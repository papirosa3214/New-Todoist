#!/usr/bin/env python3
"""Проверка правила потерь тревог в ~/infra-ops/autonomy-report.py::delivery_watch.

Зачем. Правило менялось трижды, и каждая правка лечила одну ложную тревогу, оставляя
следующую. Скрипт проверяет ОДНОВРЕМЕННО две вещи, которые противоречат друг другу
и обе нужны:

  * тревога, до которой дошёл только доклад о сбое (reserve без скобок), обязана
    попасть в потери — иначе сводка пишет «потерь нет» при мёртвом основном канале;
  * тревога, которая дошла (повтор через n8n или запасной дорогой), потерей быть не
    обязана — иначе сводка снова кричит «НЕ УШЛО» про то, что Максим получил.

Что делает:
  1. гоняет НАСТОЯЩУЮ функцию с живого файла на синтетическом журнале, где есть все
     значения reserve, которые пишет alert_send.py, и печатает, что она считает;
  2. гоняет ту же функцию на живом журнале за текущее окно и за исторические окна
     13.10 и 14.10 (выборка строк подменяется, тело функции — настоящее);
  3. для контраста считает потерь по ПРЕДЫДУЩЕМУ правилу (из git show efe9816),
     чтобы видеть, что именно перестало считаться потерей.

Запуск: HOME=/home/maksim python3 handoff/check-delivery-loss-rule.py
Ничего не пишет и не меняет: только чтение живого журнала.
"""
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time

LIVE = pathlib.Path("/home/maksim/infra-ops")
JOURNAL = pathlib.Path("/home/maksim/.claude/alert-undelivered.log")

# Все значения, которые пишет alert_send.py, и смысл каждого.
MARKERS = [
    # (source, error, reserve, ожидание «потеря?», почему)
    ("kb-add", "HTTP Error 500: Internal Server Error", "дошёл",
     True, "дошёл только доклад о сбое, сама тревога не дошла"),
    ("autonomy-110", "timed out", "не дошёл", True, "ни тревога, ни доклад"),
    ("mcp-net-watch", "HTTP Error 503", "промолчал", True, "запасная дорога молчала"),
    ("vnc-desktop-watch", "HTTP Error 503", "не дошёл (запасной дорогой)", True,
     "запасная дорога не увезла саму тревогу"),
    ("infra-vpn-watch", "HTTP Error 500", "", True, "строка без пометки — сбой неизвестен"),
    ("capture-session", "код возврата 28", "своя дорога", True,
     "отправитель сам отметил, что тревога не ушла"),
    ("kb-add", "", "дошёл (через n8n)", False, "обычная успешная отправка"),
    ("xray-target-guard", "HTTP Error 500", "дошёл (через n8n)", False,
     "первая попытка сорвалась, вторая доставила"),
    ("infra-vpn-watch", "HTTP Error 500", "дошёл (запасной дорогой)", False,
     "запасная дорога увезла САМУ тревогу"),
]


def load_live_module():
    sys.path.insert(0, str(LIVE))
    spec = importlib.util.spec_from_file_location("autonomy_report_live",
                                                 LIVE / "autonomy-report.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_old_module(tmpdir: pathlib.Path):
    """Модуль с правилом, которое было до правки 17.10 (git show efe9816)."""
    src = subprocess.run(["git", "-C", str(LIVE), "show", "efe9816:autonomy-report.py"],
                         capture_output=True, text=True, check=True).stdout
    path = tmpdir / "autonomy-report-old.py"
    path.write_text(src, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("autonomy_report_old", path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as exc:  # noqa: BLE001 — старый модуль тянет за собой импорты
        print(f"  (старое правило не импортировалось: {exc})")
        return None
    return mod


def write_journal(path: pathlib.Path, rows) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for source, error, reserve, _lost, _why in rows:
            rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "source": source, "title": "проверка", "error": error}
            rec["reserve"] = reserve
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def main() -> int:
    tmpdir = pathlib.Path(tempfile.mkdtemp(prefix="delivery-loss-check-"))
    synth = tmpdir / "synthetic.log"
    relay = tmpdir / "relay.log"
    relay.write_text("", encoding="utf-8")
    write_journal(synth, MARKERS)

    live = load_live_module()
    live.UNDELIVERED = synth
    live.RELAY_JOURNAL = relay

    print("1. Синтетика: настоящая delivery_watch на всех значениях reserve")
    print(f"   сводка по всем девяти строкам -> {live.delivery_watch(36)}")
    print(f"\n   {'источник':22s} {'reserve':32s} {'ожидание':11s} {'факт':11s} вердикт")
    bad = 0
    for source, error, reserve, want_lost, why in MARKERS:
        # Одна строка в журнале и запуск настоящей функции: так проверяется не
        # внутренний помощник, а то, что реально попадёт в утреннюю сводку.
        write_journal(synth, [(source, error, reserve, want_lost, why)])
        got_lost = "НЕ УШЛО" in live.delivery_watch(36)
        ok = "ok" if got_lost == want_lost else "РАСХОЖДЕНИЕ"
        bad += ok != "ok"
        print(f"   {source:22s} {reserve!r:32s} "
              f"{'потеря' if want_lost else 'доставлена':11s} "
              f"{'потеря' if got_lost else 'доставлена':11s} {ok}  ({why})")
    print(f"   расхождений с ожиданием: {bad}")

    print("\n2. Живой журнал: настоящая функция на разных окнах")
    live.UNDELIVERED = JOURNAL
    live.RELAY_JOURNAL = pathlib.Path("/home/maksim/.claude/alerts/relay-undelivered.log")
    orig_recent = live._recent

    def ts(s: str) -> float:
        return time.mktime(time.strptime(s + ":00", "%Y-%m-%d %H:%M:%S"))

    all_rows = []
    for line in JOURNAL.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            rec = json.loads(line)
            stamp = (rec.get("ts_epoch")
                     or time.mktime(time.strptime(rec["ts"], "%Y-%m-%dT%H:%M:%S")))
        except Exception:  # noqa: BLE001 — мусорные строки пропускаем, как это делает отчёт
            continue
        rec["_ts"] = stamp
        all_rows.append(rec)

    def window(label, a, b):
        live._recent = lambda path, hours: [r for r in all_rows if a <= r["_ts"] <= b]
        print(f"   {label:34s} -> {live.delivery_watch(36)}")
        live._recent = orig_recent

    print(f"   {'сейчас, окно 36 ч (как в сводке)':34s} -> {live.delivery_watch(36)}")
    window("13.10 00:00 - 14.10 00:00", ts("2026-10-13 00:00"), ts("2026-10-14 00:00"))
    window("14.10 00:00 - 15.10 00:00", ts("2026-10-14 00:00"), ts("2026-10-15 00:00"))
    window("вся история журнала", ts("2026-01-01 00:00"), ts("2027-01-01 00:00"))

    print("\n3. Контраст: сколько строк потерями считало ПРЕДЫДУЩЕЕ правило (efe9816)")
    # Здесь правило переписано для отчёта: внутренний помощок delivery_watch —
    # вложенная функция, снаружи её нет, а прогонять журнал целиком ради одной строки
    # не нужно. Сама проверка поведения — в разделе 1, там работает живая функция.
    def dost_now(r):
        if not str(r.get("error") or "").strip():
            return True
        return str(r.get("reserve") or "").startswith("дошёл (")

    def lost_old(r):
        return ((str(r.get("error") or "").strip()
                 and not str(r.get("reserve") or "").startswith("дошёл"))
                or r.get("reserve") == "не дошёл")

    print(f"   {'окно':18s} {'строк':>6s} {'было':>6s} {'стало':>6s} {'совет «непустой error»':>24s}")
    for label, a, b in (("13.10", ts("2026-10-13 00:00"), ts("2026-10-14 00:00")),
                        ("14.10", ts("2026-10-14 00:00"), ts("2026-10-15 00:00")),
                        ("вся история", ts("2026-01-01 00:00"), ts("2027-01-01 00:00"))):
        rows = [r for r in all_rows if a <= r["_ts"] <= b]
        print(f"   {label:18s} {len(rows):6d} {sum(1 for r in rows if lost_old(r)):6d} "
              f"{sum(1 for r in rows if not dost_now(r)):6d} "
              f"{sum(1 for r in rows if str(r.get('error') or '').strip()):24d}")
    print("   Разница «стало» и «совет» — тревоги, которые дошли с первой попытки или со второй:")
    for r in all_rows:
        if str(r.get("error") or "").strip() and dost_now(r):
            print(f"     {r['ts']} {r.get('source'):20s} reserve={r.get('reserve')!r} — тревога дошла")

    print("\nИтог:", "расхождений нет" if bad == 0 else f"расхождений {bad}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())