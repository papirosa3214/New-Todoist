"""Проверка delivery_watch НАСТОЯЩЕЙ функцией из живого файла ~/infra-ops/autonomy-report.py."""
import importlib, json, os, pathlib, sys, time

os.environ["HOME"] = "/home/maksim"
sys.path.insert(0, "/home/maksim/infra-ops")
import importlib.util                    # noqa: E402
_spec = importlib.util.spec_from_file_location("ar", "/home/maksim/infra-ops/autonomy-report.py")
ar = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ar)             # живой файл, с правкой 17.10

LIVE = "/home/maksim/.claude/alert-undelivered.log"
EMPTY = pathlib.Path("/tmp/empty.log"); EMPTY.write_text("")


def rows_of(path=LIVE):
    return [json.loads(l) for l in pathlib.Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


def window(rows, lo, hi):
    return [r for r in rows if lo <= r.get("ts", "") < hi]


def run(rows, hours, label):
    """Прогон настоящей функции на указанном наборе строк."""
    p = pathlib.Path("/tmp/_win.log")
    p.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    ar.UNDELIVERED, ar.RELAY_JOURNAL = str(p), EMPTY
    out = ar.delivery_watch(hours)
    print(f"[{label}] строк {len(rows)}, окно {hours} ч\n   → {out}")
    return out


def losses_of(text):
    for part in text.split(";"):
        if "НЕ УШЛО" in part:
            return int(part.split("НЕ УШЛО")[1].split("(")[0].strip())
    return 0


live_rows = rows_of()
print(f"живой журнал: {len(live_rows)} строк, последняя {live_rows[-1]['ts']}\n")

# A. текущее окно 36 ч — как Максим увидит это утром
a = run(live_rows, 36, "A. сейчас, 36 ч")

# B. окно 13-14.10 — то, за которое критик нашёл ложные потери
w = window(live_rows, "2026-10-13T00:00", "2026-10-15T00:00")
b = run(w, 240, "B. 13-14.10")

# C. вся история журнала
c = run(live_rows, 24 * 365 * 10, "C. вся история")
print(f"   → потерь {losses_of(c)}, доставлено {len(live_rows) - losses_of(c)}")

# D. то же окно 13-14.10 на МИГРИРОВАННОЙ копии (что даёт команда владельца)
mig = []
for r in w:
    r = dict(r)
    if (r.get("reserve") == "дошёл" and str(r.get("error") or "").strip()
            and r.get("source") == "infra-vpn-watch"
            and r.get("title") == "VPN/прокси: TaskFlow↔Linear под угрозой"):
        r["reserve"] = "дошёл (запасной дорогой)"
    mig.append(r)
run(mig, 240, "D. 13-14.10 после переименования 2 строк")

# E. четыре строки, названные критиком, — по новому правилу
print("\n[E] строки, названные в ревью:")
for r in w:
    if r.get("reserve") in ("дошёл", "дошёл (запасной дорогой)") and r["ts"] >= "2026-10-13":
        delivered = (not str(r.get("error") or "").strip()
                     or str(r.get("reserve") or "").startswith("дошёл ("))
        print(f"   {r['ts']}  {r['source']:20} reserve={r['reserve']!r:26} "
              f"→ {'доставлена' if delivered else 'ПОТЕРЯ'}")
