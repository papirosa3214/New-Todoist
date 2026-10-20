# -*- coding: utf-8 -*-
"""Проверка kb_reachable_watch на сценариях: подменяем только запуск пробы.

Запуск:
    AR_FILE=/tmp/infra-ops-fix/autonomy-report.py python3 test_kb_watch.py

AR_FILE — путь к autonomy-report.py (лучше к файлу из коммита).
Модуль тянет за собой соседние файлы репозитория (alert_send и др.), поэтому
запускать нужно из каталога с ними, напр. из /tmp/infra-ops-fix.
"""
import importlib.util
import os
import subprocess as real_sp
import sys

AR_FILE = os.environ.get("AR_FILE", "/tmp/infra-ops-fix/autonomy-report.py")

spec = importlib.util.spec_from_file_location("ar", AR_FILE)
ar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ar)

_real_run = real_sp.run


class FakeProc:
    def __init__(self, out, err=""):
        self.stdout, self.stderr = out, err


def verdict(out, err=""):
    # функция делает `import subprocess as sp` внутри тела, поэтому подменяем
    # метод run у самого модуля subprocess
    real_sp.run = lambda *a, **k: FakeProc(out, err)
    try:
        return ar.kb_reachable_watch()
    finally:
        real_sp.run = _real_run


def line(before, after, seen, good):
    return f"TOTAL_BEFORE={before}\nTOTAL_AFTER={after}\nSEEN={seen}\nGOOD={good}\n"


CASES = [
    ("покой 1539=1539", line(1539, 1539, 1539, 3), "", "все 1539 документов видны"),
    ("сегодня: было 1540, стало 1539 (движение базы)", line(1540, 1539, 1539, 3), "",
     "все 1539 документов видны"),
    ("настоящая обрезка", line(1540, 1540, 1539, 3), "",
     "ВИДНО НЕ ВСЁ"),
    ("база росла", line(1539, 1540, 1540, 3), "", "все 1540 документов видны"),
    ("содержимое пустое", line(1539, 1539, 1539, 0), "", "документы достаются пустыми"),
    # один битый документ в датасете — не повод тревожить (это был риск правки)
    ("один битый, остальные живые", line(1539, 1539, 1539, 2), "", "все 1539 документов видны"),
    # регресс: проба упала (тот самый list index out of range)
    ("проба упала", "", "Traceback (most recent call last):\nRuntimeError: RAGFlow: 401 token",
     "не проверить (RuntimeError: RAGFlow: 401 token)"),
    # мусор в выводе пробы больше не роняет разбор
    ("мусор в stdout", "warning: blah\n" + line(1539, 1539, 1539, 3), "",
     "все 1539 документов видны"),
]

if __name__ == "__main__":
    ok = True
    for name, out, err, expect in CASES:
        got = verdict(out, err)
        good = expect in got
        ok = ok and good
        print(("  OK  " if good else " FAIL ") + name)
        print("        → " + got)
    print()
    print("ИТОГ:", "все сценарии прошли" if ok else "ЕСТЬ ПРОВАЛЫ")
    sys.exit(0 if ok else 1)
