# -*- coding: utf-8 -*-
"""Итоговый вердикт на сегодняшних числах через настоящую функцию.

Запуск:
    AR_FILE=/tmp/infra-ops-fix/autonomy-report.py python3 test_today_e2e.py
"""
import importlib.util
import os
import subprocess as real_sp

AR_FILE = os.environ.get("AR_FILE", "/tmp/infra-ops-fix/autonomy-report.py")

spec = importlib.util.spec_from_file_location("ar", AR_FILE)
ar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ar)

_real = real_sp.run


class P:
    def __init__(self, o, e=""):
        self.stdout, self.stderr = o, e


def verdict(out, err=""):
    real_sp.run = lambda *a, **k: P(out, err)
    try:
        return ar.kb_reachable_watch()
    finally:
        real_sp.run = _real


CASES = [
    ("СЕГОДНЯ (база сжалась под проверкой: 1540 -> 1539, список 1539)",
     "TOTAL_BEFORE=1540\nTOTAL_AFTER=1539\nSEEN=1539\nGOOD=3\n", "все 1539 документов видны"),
    ("НАСТОЯЩАЯ ПОЛОМКА (список стабильно короче базы)",
     "TOTAL_BEFORE=1540\nTOTAL_AFTER=1540\nSEEN=1539\nGOOD=3\n", "ВИДНО НЕ ВСЁ"),
    ("ПОКОЙ (как сейчас на сервере: 1539 = 1539)",
     "TOTAL_BEFORE=1539\nTOTAL_AFTER=1539\nSEEN=1539\nGOOD=3\n", "все 1539 документов видны"),
]

if __name__ == "__main__":
    ok = True
    for name, out, expect in CASES:
        got = verdict(out)
        good = expect in got
        ok = ok and good
        print(("  OK  " if good else " FAIL ") + name)
        print("        → " + got)
    raise SystemExit(0 if ok else 1)
