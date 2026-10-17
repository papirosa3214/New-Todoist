"""Сквозная проверка КОНТРАКТА журнала: что alert_send.py теперь пишет и как это читает
настоящая delivery_watch. Отправка никуда не идёт: n8n уводится в мёртвый порт,
rendezvous подменён, запасная дорога подменена, журнал пишется в /tmp."""
import importlib.util, json, os, pathlib, sys

os.environ["HOME"] = "/home/maksim"
sys.path.insert(0, "/home/maksim/infra-ops")


def load(path):
    spec = importlib.util.spec_from_file_location("m", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ar = load("/home/maksim/infra-ops/autonomy-report.py")
LIVE = pathlib.Path("/tmp/contract.log")


def one(source, title, reserve_full, direct_ok, rf_result):
    """Одна отправка с мёртвым n8n; возвращает строку журнала."""
    import alert_send
    alert_send.WEBHOOK = "http://127.0.0.1:1/dead"
    alert_send.UNDELIVERED = str(LIVE)
    alert_send.rendezvous.write = lambda *a, **k: {"path": None, "has_triage": False,
                                                  "triage_lines": [], "error": "подмена"}
    alert_send.send_direct = lambda text: direct_ok
    alert_send.report_failure = lambda s, t, e: rf_result
    LIVE.write_text("", encoding="utf-8")
    alert_send.send(source, "error", title, "текст", reserve_full=reserve_full)
    return LIVE.read_text(encoding="utf-8")


def verdict(log, label):
    p = pathlib.Path("/tmp/one.log"); p.write_text(log, encoding="utf-8")
    ar.UNDELIVERED = str(p)
    ar.RELAY_JOURNAL = pathlib.Path("/tmp/empty.log")
    row = json.loads(log.strip().splitlines()[-1])
    print(f"{label}\n   пишет в журнал: reserve={row['reserve']!r}"
          f"\n   сводка говорит: {ar.delivery_watch(24)}\n")


print("КОНТРАКТ ЖУРНАЛА — живой alert_send.py и живая delivery_watch:\n")
verdict(one("infra-vpn-watch", "A", True, True, "дошёл"),
        "A. тревога уведена запасной дорогой и ДОШЛА (было: почему-то «потеря»)")
verdict(one("infra-vpn-watch", "B", True, False, "дошёл"),
        "B. тревога запасной дорогой не ушла — потеря настоящая")
verdict(one("kb-add", "C", False, False, "дошёл"),
        "C. дошёл только доклад о сбое — потеря настоящая (дефект 14e015b не сломан)")
verdict(one("kb-add", "D", False, False, "не дошёл"),
        "D. не дошёл ни доклад — сводка показывает «без предупреждения»")
