#!/usr/bin/env python3
"""Повторный замер времени ролей TaskFlow (7-й день) — независимая реализация
метрик базового замера 17–31.10.2026, потому что /home/maksim/taskflow/roles/analyst/scripts
недоступна пользователю tfrole (каталог 700 maksim).

Вход: /home/maksim/.local/state/taskflow-runs/sessions/<task>-<role>-<step>/*.jsonl
Выход: JSON со сводкой по шагам.
"""
import json, glob, os, sys, collections, statistics, re

ROOT = "/home/maksim/.local/state/taskflow-runs/sessions"

DISK = {"grep", "find", "ls", "glob"}
DISK_BASH = re.compile(r"\b(grep|find|ls|rg|fd|cat|head|tail)\b")
MEMORY = {"taskflow_recall", "taskflow_kb_search", "taskflow_doc_read", "taskflow_docs",
          "taskflow_remember", "taskflow_memory_search"}
GRAFT_PREFIX = "graft_"


def parse_ts(s):
    # "2026-10-31T20:28:15.023Z"
    return s


def load_step(d):
    calls = []          # (order, tool, args_json, ts)
    results = {}        # toolCallId -> (status, text)
    submitted = False
    files = sorted(glob.glob(os.path.join(d, "*.jsonl")))
    unreadable = [0]
    for f in files:
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except PermissionError:
            unreadable[0] += 1
            continue
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("type") != "message":
                continue
            m = r.get("message") or {}
            role = m.get("role")
            ts = r.get("timestamp", "")
            if role == "assistant":
                for c in m.get("content") or []:
                    if not isinstance(c, dict):
                        continue
                    if c.get("type") == "toolCall":
                        name = c.get("name") or ""
                        args = json.dumps(c.get("arguments") or {}, ensure_ascii=False, sort_keys=True)
                        calls.append((ts, name, args, c.get("id")))
                        if name == "taskflow_subtask_done":
                            submitted = True
            elif role == "toolResult":
                cid = m.get("toolCallId")
                txt = ""
                for c in m.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "text":
                        txt += c.get("text") or ""
                bad = bool(m.get("isError")) or txt.lstrip().startswith(
                    ("Error", "Ошибка", "Action not started", "Действие не начато"))
                results[cid] = (bad, txt)
    return {"dir": os.path.basename(d), "files": len(files) - unreadable[0], "calls": calls,
            "results": results, "submitted": submitted, "unreadable": unreadable[0]}


def is_disk(name, args):
    if name in DISK:
        return True
    if name == "bash":
        try:
            a = json.loads(args)
        except Exception:
            return False
        return bool(DISK_BASH.search(a.get("command", "") or ""))
    return False


def metrics(steps):
    calls_per_step = [len(s["calls"]) for s in steps]
    calls_per_step.sort()
    def pct(xs, p):
        if not xs:
            return 0
        k = (len(xs) - 1) * p
        lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
        return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)
    total_calls = sum(calls_per_step)
    disk = mem = graft = 0
    repeats = 0
    refusals = 0
    for s in steps:
        seen = collections.Counter()
        for _, name, args, cid in s["calls"]:
            if is_disk(name, args):
                disk += 1
            if name in MEMORY:
                mem += 1
            if name.startswith(GRAFT_PREFIX):
                graft += 1
            key = (name, args)
            seen[key] += 1
            if seen[key] > 1:
                repeats += 1
            res = s["results"].get(cid)
            if res and res[0]:
                refusals += 1
    # порядок: в шагах с дисковым поиском был ли вызов памяти/библиотеки/графа ДО первого дискового
    order_ok = order_n = 0
    for s in steps:
        first_disk = None
        first_know = None
        for i, (_, name, args, cid) in enumerate(s["calls"]):
            if first_know is None and (name in MEMORY or name.startswith(GRAFT_PREFIX)):
                first_know = i
            if first_disk is None and is_disk(name, args):
                first_disk = i
            if first_disk is not None and first_know is not None:
                break
        if first_disk is not None:
            order_n += 1
            if first_know is not None and first_know < first_disk:
                order_ok += 1
    return {
        "steps": len(steps),
        "calls": total_calls,
        "median": statistics.median(calls_per_step) if calls_per_step else 0,
        "p90": round(pct(calls_per_step, 0.9), 1),
        "max": calls_per_step[-1] if calls_per_step else 0,
        "share_steps_gt100": round(100 * sum(1 for c in calls_per_step if c > 100) / len(steps), 1) if steps else 0,
        "disk_calls": disk,
        "disk_share": round(100 * disk / total_calls, 1) if total_calls else 0,
        "mem_calls": mem,
        "mem_share": round(100 * mem / total_calls, 1) if total_calls else 0,
        "graft_calls": graft,
        "repeat_share": round(100 * repeats / total_calls, 1) if total_calls else 0,
        "refusal_share": round(100 * refusals / total_calls, 1) if total_calls else 0,
        "order_ok": order_ok, "order_n": order_n,
        "order_share": round(100 * order_ok / order_n, 1) if order_n else 0,
        "no_submit_share": round(100 * sum(1 for s in steps if not s["submitted"]) / len(steps), 1) if steps else 0,
        "unreadable_files": sum(s.get("unreadable", 0) for s in steps),
        "restarts_total": sum(max(0, s["files"] - 1) for s in steps),
        "restarts_per_step": round(sum(max(0, s["files"] - 1) for s in steps) / len(steps), 2) if steps else 0,
    }


def main():
    since = sys.argv[1] if len(sys.argv) > 1 else "1970-01-01T00:00:00"
    until = sys.argv[2] if len(sys.argv) > 2 else "9999"
    dirs = sorted(glob.glob(os.path.join(ROOT, "*")))
    card, main = [], []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        files = glob.glob(os.path.join(d, "*.jsonl"))
        if not files:
            continue
        first_ts = min(os.path.basename(f)[:24] for f in files)  # имя файла начинается с ISO-таймстампа
        if not (since <= first_ts <= until):
            continue
        name = os.path.basename(d)
        step = load_step(d)
        if not step["calls"]:
            continue  # пустые сессии отбрасываем, как в базовом замере
        if re.search(r"-[a-z_]+-main$", name):
            main.append(step)
        else:
            card.append(step)
    out = {"since": since, "until": until,
           "card": metrics(card), "main": metrics(main),
           "card_dirs": len(card), "main_dirs": len(main)}
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
