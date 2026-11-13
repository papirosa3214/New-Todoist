#!/usr/bin/env python3
"""Факты для критика-проверяющего вместо самостоятельных ходов.

Владелец 13.11.2026: проверка занимает больше всего слотов ролей (29 за ноябрь),
хотя половина проверки считается кодом, а не рассуждением.

Что собирает по одной карточке:
  * состояние карточки и её планов;
  * узлы плана: роль, закрыт/нет, есть ли результат, блок;
  * git: ветка карточки, коммиты, которых нет в main на .110 и на GitHub,
    список изменённых файлов;
  * отчёт по карточке в task_reports;
  * (--tsc) проверку типов сервера.

Ничего не меняет: база открывается mode=ro, git вызывается только на чтение.

Использование:
    server/scripts/critic-facts.py <task_id> [--tsc] [--json]
Код возврата: 0 — факты собраны (вердикт в поле verdict_hints), 2 — карточки нет,
3 — ошибка чтения.
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys

DB = "/home/maksim/Проекты/New-Todoist/server/taskflow.db"
LIVE_REPO = os.environ.get("MAK70_LIVE_REPO", "/home/maksim/Проекты/New-Todoist")
WORKTREES = os.path.expanduser("~/.local/state/taskflow-runs/worktrees")


def db_ro() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def git(repo: str, *args: str) -> tuple[int, str]:
    try:
        out = subprocess.run(
            ["git", "-C", repo, *args],
            capture_output=True, text=True, timeout=60,
        )
        return out.returncode, (out.stdout or out.stderr).strip()
    except Exception as exc:  # noqa: BLE001
        return 1, f"git error: {exc}"


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        print("usage: critic-facts.py <task_id> [--tsc] [--json]", file=sys.stderr)
        return 3
    task_id = args[0]

    con = db_ro()
    task = con.execute(
        "SELECT id,title,status,agent_state,created_at,completed_at,assignee_id,"
        "blocked_reason,block_type FROM tasks WHERE id=?", (task_id,)
    ).fetchone()
    if not task:
        print(json.dumps({"error": "task_not_found", "task_id": task_id}, ensure_ascii=False))
        return 2

    plans = [
        dict(r) for r in con.execute(
            "SELECT id,revision,status,profile,approved_at FROM task_collaboration_plans "
            "WHERE task_id=? ORDER BY revision", (task_id,)
        )
    ]
    slots = [
        dict(r) for r in con.execute(
            "SELECT n.slot_key, n.role_key, n.required, "
            "       COALESCE(s.done,0) AS done, "
            "       CASE WHEN COALESCE(s.result,'')='' THEN 0 ELSE 1 END AS has_result, "
            "       s.block_type, s.result "
            "FROM task_collaboration_plan_nodes n "
            "JOIN task_collaboration_plans p ON p.id=n.plan_id "
            "  AND p.status='approved' "
            "  AND p.revision=(SELECT MAX(revision) FROM task_collaboration_plans "
            "                  WHERE task_id=p.task_id AND status='approved') "
            "LEFT JOIN subtasks s ON s.task_id=p.task_id AND s.plan_node_key=n.slot_key "
            "WHERE p.task_id=? ORDER BY n.slot_key", (task_id,)
        )
    ]
    for s in slots:
        s["result"] = (s.get("result") or "")[:300]
    reports = [
        dict(r) for r in con.execute(
            "SELECT id,title,note_id,created_at FROM task_reports "
            "WHERE task_id=? ORDER BY created_at DESC LIMIT 3", (task_id,)
        )
    ] if con.execute(
        "SELECT 1 FROM sqlite_master WHERE name='task_reports'"
    ).fetchone() else []
    con.close()

    branch = f"roles/{task_id}"
    facts: dict = {
        "task": dict(task),
        "plans": plans,
        "slots": slots,
        "slots_total": len(slots),
        "slots_open": sum(1 for s in slots if not s["done"]),
        "slots_without_result": sum(1 for s in slots if s["done"] and not s["has_result"]),
        "reports": reports,
    }

    worktree = os.path.join(WORKTREES, task_id)
    facts["worktree"] = {"path": worktree, "exists": os.path.isdir(worktree)}
    if os.path.isdir(worktree):
        rc, log = git(worktree, "log", "--oneline", f"main..{branch}")
        facts["git"] = {
            "branch": branch,
            "commits_ahead_of_main": len(log.splitlines()) if rc == 0 else 0,
            "commits": log.splitlines()[:20] if rc == 0 else [],
        }
        rc, files = git(worktree, "diff", "--name-only", f"main...{branch}")
        facts["git"]["changed_files"] = files.splitlines() if rc == 0 else []
        ok = []
        for remote in ("origin", "github"):
            rc, refs = git(worktree, "branch", "-r", "--contains", branch)
            ok.append(refs.count(remote) > 0 if rc == 0 else False)
        facts["git"]["branch_on_origin"] = ok[0] if ok else False
        facts["git"]["branch_on_github"] = ok[1] if len(ok) > 1 else False

    rc, head = git(LIVE_REPO, "rev-parse", "--short", "HEAD")
    facts["live_main"] = {"repo": LIVE_REPO, "head": head if rc == 0 else None}

    if "--tsc" in flags:
        try:
            proc = subprocess.run(
                ["npx", "tsc", "--noEmit"],
                cwd=os.path.join(LIVE_REPO, "server"),
                capture_output=True, text=True, timeout=600,
            )
            facts["tsc"] = {
                "code": proc.returncode,
                "errors": [l for l in (proc.stdout or "").splitlines() if "error TS" in l][:20],
            }
        except Exception as exc:  # noqa: BLE001
            facts["tsc"] = {"code": -1, "errors": [str(exc)]}

    hints = []
    if facts["slots_open"]:
        hints.append(f"не закрыто узлов: {facts['slots_open']} — вердикт approved невозможен")
    gitf = facts.get("git") or {}
    if gitf.get("commits_ahead_of_main"):
        hints.append(
            f"ветка {branch} ушла вперёд main на {gitf['commits_ahead_of_main']} коммитов — "
            "проверять надо этот дифф, а не main"
        )
    if gitf.get("commits_ahead_of_main") and not gitf.get("branch_on_github"):
        hints.append(f"ветки {branch} нет на GitHub — отчёт, ссылающийся на main, неверен")
    if facts.get("tsc", {}).get("code") not in (None, 0):
        hints.append("tsc --noEmit не чист — правка не готова")
    if not reports:
        hints.append("отчёта по карточке нет в task_reports")
    facts["verdict_hints"] = hints

    print(json.dumps(facts, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
