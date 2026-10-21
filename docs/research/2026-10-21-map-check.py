#!/usr/bin/env python3
"""Проверка карты проектов и папок: пути, числа и порты — по живой машине .110.

Карта: docs/research/2026-10-21-map-note.md (она же — текст заметки в разделе
Knowledge Base). Скрипт ничего не меняет: только читает и печатает отчёт.

Запуск:
    python3 docs/research/2026-10-21-map-check.py [путь к файлу карты]

Что проверяет:
  1. Абсолютные пути и пути `~/…` — существуют ли на .110.
  2. Относительные пути (README.md, docs/, graft/INDEX.md, CRM/CRM-Castom …) —
     есть ли такой путь в проектах; если ни в одном — дефект.
  3. Числа из раздела «Сколько чего на .110» — пересчитывает командами.
  4. Порты из таблицы живых портов — слушает ли их машина.
"""
import glob
import os
import re
import subprocess
import sys

HOME = "/home/maksim"
PROJECTS = f"{HOME}/Проекты"
MAP = sys.argv[1] if len(sys.argv) > 1 else "docs/research/2026-10-21-map-note.md"

TOKEN = re.compile(r"`([^`\n]+)`")
LOOKS_LIKE_PATH = re.compile(r"^(?:~|/)?[\wА-Яа-яЁё][\wА-Яа-яЁё ./()-]*$")
HAS_EXT = re.compile(r"\.[A-Za-z0-9]{1,6}$")
# Слова и адреса, которые похожи на путь, но путями на диске не являются.
# Пути, которые с .110 проверить нельзя: лежат на MacBook.
MAC_PREFIX = "/Users/"
# Каталоги, закрытые владельцем: для роли не видны — это ожидаемо, а не дефект.
EXPECTED_HIDDEN = {"/home/maksim/taskflow/roles": "каталог ролей закрыт правами владельца"}
SKIP = {
    "main", "master", "git", "compose", "docker", "curl", "find", "ls", "wc", "head",
    "python3", "node", "npm", "taskflow-web.service", "taskflow-server.service",
    "codex-bridge.service", "feat/task-calendar-event-ui", "feat/cordis-core",
    "server/src", "src/screens", "server/taskflow.db", "taskflow.db",
    "Проекты/", "docs/", "graft/", "src/", "public/", "references/",
    "BoardUI/boardui", "theatre-js/theatre", "trailhq/Graft", "monicahq/monica",
    "magicuidesign/magicui", "HKUDS/DeepTutor", "penpot/penpot", "maksim/taskflow-server",
}


def tokens_of(text: str) -> list[str]:
    out = []
    for raw in TOKEN.findall(text):
        token = raw.strip()
        if not token or token in SKIP or " " in token or "://" in token:
            continue
        if not LOOKS_LIKE_PATH.match(token):
            continue
        if not ("/" in token or HAS_EXT.search(token)):
            continue
        if token.startswith("http") or "*" in token or "<" in token:
            continue
        # первый сегмент с точкой — адрес удалённого репозитория или хоста
        first = token.split("/")[0]
        if "." in first:
            continue
        out.append(token)
    return out


def project_roots() -> list[str]:
    roots = [PROJECTS]
    roots += [p for p in sorted(glob.glob(f"{PROJECTS}/*")) if os.path.isdir(p)]
    roots += [p for p in sorted(glob.glob(f"{PROJECTS}/*/*")) if os.path.isdir(p)]
    repo = subprocess.run("git rev-parse --show-toplevel", shell=True, capture_output=True, text=True).stdout.strip()
    if repo:
        roots.append(repo)
    return roots


def find_relative(token: str, roots: list[str]) -> list[str]:
    token = token.rstrip("/")
    hits = []
    for root in roots:
        cand = os.path.join(root, token)
        if os.path.exists(cand):
            hits.append(cand)
    return hits


def sh(cmd: str) -> str:
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def main() -> int:
    text = open(MAP, encoding="utf-8").read()
    tokens = tokens_of(text)
    defects = []
    checked_abs = 0
    checked_rel = 0
    seen_rel = set()
    roots = project_roots()

    for token in tokens:
        if token.startswith(MAC_PREFIX):
            print(f"  ПРОПУСК mac-путь (с .110 не проверяется): {token}")
            continue
        if token.startswith("/"):
            checked_abs += 1
            if not os.path.exists(token):
                if token in EXPECTED_HIDDEN:
                    print(f"  OK   {token} — {EXPECTED_HIDDEN[token]}")
                else:
                    defects.append(("нет такого пути", token, "абсолютный"))
        elif token.startswith("~/"):
            checked_abs += 1
            if not os.path.exists(token.replace("~", HOME, 1)):
                defects.append(("нет такого пути", token, "домашняя папка"))
        else:
            if token in seen_rel:
                continue
            seen_rel.add(token)
            checked_rel += 1
            if not find_relative(token, roots):
                defects.append(("не найден ни в одном проекте", token, "относительный"))

    facts = [
        ("папок верхнего уровня в ~/Проекты", 45, "ls -1 /home/maksim/Проекты | wc -l"),
        ("папок вместе со скрытыми", 49, "ls -1A /home/maksim/Проекты | wc -l"),
        ("git-репозиториев", 19, "find /home/maksim/Проекты -maxdepth 3 -name .git -type d 2>/dev/null | wc -l"),
        ("графов кода (graft/)", 6, "find /home/maksim/Проекты -maxdepth 3 -name graft -type d 2>/dev/null | wc -l"),
        ("записей сервисов в пульте", 124, "curl -s http://127.0.0.1:3007/api/services | python3 -c \"import json,sys;d=json.load(sys.stdin);r=d if isinstance(d,list) else d.get('services',[]);print(len(r))\""),
        ("работающих служб", 67, "curl -s http://127.0.0.1:3007/api/services | python3 -c \"import json,sys;d=json.load(sys.stdin);r=d if isinstance(d,list) else d.get('services',[]);print(sum(1 for x in r if x.get('status')=='running'))\""),
        ("остановленных служб", 57, "curl -s http://127.0.0.1:3007/api/services | python3 -c \"import json,sys;d=json.load(sys.stdin);r=d if isinstance(d,list) else d.get('services',[]);print(sum(1 for x in r if x.get('status')=='stopped'))\""),
        ("записей в docs/ TaskFlow", 148, "ls -1 /home/maksim/Проекты/New-Todoist/docs | wc -l"),
        ("файлов в docs/ TaskFlow", 394, "find /home/maksim/Проекты/New-Todoist/docs -type f | wc -l"),
        (".md в docs/ TaskFlow", 220, "find /home/maksim/Проекты/New-Todoist/docs -type f -name '*.md' | wc -l"),
    ]
    print("== числа ==")
    for label, expected, cmd in facts:
        got = sh(cmd)
        ok = got == str(expected)
        print(f"  {'OK  ' if ok else 'ДИФФ'} {label}: в карте {expected}, на машине {got}")
        if not ok:
            defects.append(("число не совпало", f"{label}: карта {expected}, машина {got}", "пересчёт"))

    section = text.split("## Живые порты", 1)[-1].split("\n## ", 1)[0]
    ports = sorted({int(p) for p in re.findall(r"\b(\d{4})\b", section) if not 1900 <= int(p) <= 2100})
    listening = set()
    for line in sh("ss -tln").splitlines():
        m = re.search(r":(\d+)\s", line)
        if m:
            listening.add(int(m.group(1)))
    print("== порты ==")
    for port in ports:
        if port in listening:
            print(f"  OK   {port} слушает")
        else:
            print(f"  ДИФФ {port} не слушает")
            defects.append(("порт не слушает", str(port), "ss -tln"))

    print(f"== пути: проверено {checked_abs} абсолютных и {checked_rel} относительных ==")
    for kind, what, where in defects:
        print(f"  ДЕФЕКТ [{where}] {kind}: {what}")
    print(f"\nитого дефектов: {len(defects)}")
    return 1 if defects else 0


if __name__ == "__main__":
    sys.exit(main())
