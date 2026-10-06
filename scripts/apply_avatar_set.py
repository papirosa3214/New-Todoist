#!/usr/bin/env python3
"""Поставить комплект аватарок всем учётками агентов на сервере.

Запуск:
  python3 ~/.claude/vault-run.py --secret T=TASKFLOW_ORCHESTRATOR_CLAUDE_TOKEN -- \
      python3 scripts/apply_avatar_set.py red

Комплекты лежат в avatar-sets/ИМЯ/УЧЁТКА.png (red, noir, neon, classic).
orchestrator.png — учётка «Оркестратор Claude». Приложение подхватывает
новые картинки без пересборки.
"""
import os
import pathlib
import sys
import urllib.request

BASE = os.environ.get("TASKFLOW_URL", "http://localhost:3001")
ORCH = "6848a89b-04fe-4015-bb1c-61b03782c378"
root = pathlib.Path(__file__).resolve().parent.parent / "avatar-sets"
name = sys.argv[1] if len(sys.argv) > 1 else ""
d = root / name
if not d.is_dir():
    sys.exit("комплекты: " + ", ".join(sorted(p.name for p in root.iterdir())))
for f in sorted(d.glob("*.png")):
    uid = ORCH if f.stem == "orchestrator" else f.stem
    req = urllib.request.Request(
        f"{BASE}/api/users/{uid}/avatar",
        data=f.read_bytes(),
        method="POST",
        headers={"Authorization": "Bearer " + os.environ["T"], "Content-Type": "image/png"},
    )
    print(uid, urllib.request.urlopen(req).status)
