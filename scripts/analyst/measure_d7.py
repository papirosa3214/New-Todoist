#!/usr/bin/env python3
"""Замер времени ролей TaskFlow (7-й и 14-й день) — определения приведены
к базовому замеру 17–31.10.2026 (заметка `1239163b`).

Что изменено против первой версии скрипта (коммит 221bee78):
  1. Вызов операции учитывается и как `taskflow_subtask_done`, и как обёртка
     `taskflow` с `operation="taskflow_subtask_done"`. Из-за этого «шаги без
     сдачи» раньше считались как 86,7 % вместо ~18 %.
  2. Поиск по диску — ровно grep/find/ls/rg/fd и `bash` с этими командами,
     как в базе. `cat/head/tail` больше не считаются поиском по диску.
  3. Память — taskflow_recall и taskflow_kb_search (строгое определение базы);
     taskflow_doc_read/taskflow_docs/taskflow_remember считаются отдельно.
  4. Окно отбирается по разобранному времени первого файла сессии (UTC),
     а не по лексикографическому сравнению имени файла.
  5. Считается модельное и инструментальное время (база: карточка 58,9 ч
     модели, 27,9 ч инструментов, 300 шагов, 27 362 вызова).
  6. Пустые сессии отбрасываются, нечитаемые файлы считаются отдельно.

Популяции (как в базе, смешивать нельзя):
  card      — рабочие шаги карточки, каталоги `<task>-<role>-<step>`;
  cardmain  — сессии уровня карточки `<task>-<role>-main`;
  chat      — чатовые ходы. Лежат в /home/maksim/taskflow/roles/<role>/sessions,
              каталог /home/maksim/taskflow — 700 maksim, роль работает как
              tfrole, поэтому чтение запрещено. Метрики чата в этом прогоне
              недоступны, а не «не считаются по недосмотру».

Использование:
    python3 measure_d7.py <since ISO> [until ISO] [--json out.json]
    python3 measure_d7.py 2026-10-17T00:00:00 2026-10-31T23:59:59
"""
import json, glob, os, re, sys, statistics, collections, datetime

ROOT = "/home/maksim/.local/state/taskflow-runs/sessions"
CHAT_ROOT = "/home/maksim/taskflow/roles"

# --- определения базы (заметка 1239163b) -----------------------------------
DISK_TOOLS = {"grep", "find", "ls", "rg", "fd", "glob"}
DISK_BASH = re.compile(r"\b(grep|find|ls|rg|fd)\b")
MEM_TOOLS = {"taskflow_recall", "taskflow_kb_search"}
MEM_WIDE = {"taskflow_recall", "taskflow_kb_search", "taskflow_doc_read",
            "taskflow_docs", "taskflow_remember"}
SUBMIT_OPS = {"taskflow_subtask_done"}
# «неверная форма вызова»: база (17 %) считает такие отказы по тексту ошибки.
# Классификация приблизительная — точнее по журналам не разделить.
SHAPE_ERR = re.compile(
    r"не в каталоге|not found|неизвестн|Unknown tool|не является операцией|"
    r"schema|required|аргумент|Tool .* not", re.I)

# значения базового замера 17–31.10.2026 для сверки
BASE = {
    "card": {"steps": 300, "calls": 27362, "median": 82, "mean": 91, "p90": 154,
             "max": 301, "share_steps_gt100": 34.0, "disk_share": 34.8,
             "mem_share": 0.7, "repeat_share": 8.9, "refusal_share": 5.7,
             "no_submit_share": 18.0, "model_hours": 58.9, "tool_hours": 27.9},
    "chat": {"turns": 299, "calls": 17316, "median": 32, "p90": 147,
             "share_turns_gt100": 18.4, "disk_share": 29.4, "mem_share": 3.8,
             "repeat_share": 8.7, "refusal_share": 7.45, "order_share": 19.8,
             "model_hours": 40.3},
    "overall": {"calls": 44678, "disk_share": 30.8, "refusal_share": 13.0,
                "repeat_share": 8.8, "model_hours": 142.0,
                "restarts_per_step": 6.6, "multi_session_dirs": 129},
}


def file_ts(path):
    """Имя файла сессии: 2026-10-24T22-03-41-208Z_<id>.jsonl"""
    try:
        return datetime.datetime.strptime(os.path.basename(path)[:24],
                                          "%Y-%m-%dT%H-%M-%S-%fZ")
    except Exception:
        return None


def ts_dt(s):
    try:
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def op_of(name, args):
    """Имя операции: прямая `taskflow_x` или обёртка `taskflow` + operation."""
    if name == "taskflow":
        return (args.get("operation") or args.get("op") or "")
    return name or ""


def is_disk(name, args):
    if name in DISK_TOOLS:
        return True
    if name == "bash":
        return bool(DISK_BASH.search(args.get("command", "") or ""))
    return False


def load_dir(d):
    calls, results, files, unread = [], {}, 0, 0
    submitted = False
    model_sec = tool_sec = 0.0
    for f in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except PermissionError:
            unread += 1
            continue
        files += 1
        evs = []
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            m = r.get("message") or {}
            role = m.get("role")
            t = ts_dt(r.get("timestamp", ""))
            if role == "assistant":
                for c in m.get("content") or []:
                    if not isinstance(c, dict) or c.get("type") != "toolCall":
                        continue
                    a = c.get("arguments") or {}
                    calls.append((c.get("name"), a, c.get("id")))
                    if op_of(c.get("name"), a) in SUBMIT_OPS:
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
            if t is not None:
                evs.append((t, r))
        evs.sort(key=lambda x: x[0])
        call_ts = {}
        for i, (t, r) in enumerate(evs):
            m = r.get("message") or {}
            if m.get("role") == "assistant":
                if i > 0:
                    model_sec += (t - evs[i - 1][0]).total_seconds()
                for c in m.get("content") or []:
                    if isinstance(c, dict) and c.get("type") == "toolCall":
                        call_ts[c.get("id")] = t
            elif m.get("role") == "toolResult":
                ct = call_ts.get(m.get("toolCallId"))
                if ct is not None:
                    tool_sec += (t - ct).total_seconds()
    return {"dir": os.path.basename(d), "calls": calls, "results": results,
            "files": files, "unread": unread, "submitted": submitted,
            "model_sec": model_sec, "tool_sec": tool_sec}


def pct(xs, p):
    if not xs:
        return 0.0
    k = (len(xs) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 1)


def metrics(steps, unit):
    per = sorted(len(s["calls"]) for s in steps)
    total = sum(per)
    disk = mem = mem_wide = graft = repeats = refusals = refusals_shape = 0
    order_ok = order_n = 0
    for s in steps:
        seen = collections.Counter()
        first_disk = first_know = None
        for i, (name, args, cid) in enumerate(s["calls"]):
            op = op_of(name, args)
            if is_disk(name, args):
                disk += 1
            if op in MEM_TOOLS:
                mem += 1
            if op in MEM_WIDE:
                mem_wide += 1
            if op.startswith("graft"):
                graft += 1
            key = (name, json.dumps(args, ensure_ascii=False, sort_keys=True))
            seen[key] += 1
            if seen[key] > 1:
                repeats += 1
            res = s["results"].get(cid)
            if res and res[0]:
                refusals += 1
                if SHAPE_ERR.search(res[1]):
                    refusals_shape += 1
            if first_disk is None and is_disk(name, args):
                first_disk = i
            if first_know is None and (op in MEM_WIDE or op.startswith("graft")):
                first_know = i
        if first_disk is not None:
            order_n += 1
            if first_know is not None and first_know < first_disk:
                order_ok += 1
    n = len(steps)
    gt100 = sum(1 for c in per if c > 100)
    return {
        "unit": unit,
        "steps": n,
        "calls": total,
        "mean": round(total / n, 1) if n else 0,
        "median": statistics.median(per) if per else 0,
        "p90": pct(per, 0.9),
        "max": per[-1] if per else 0,
        "share_steps_gt100": round(100 * gt100 / n, 1) if n else 0,
        "disk_calls": disk,
        "disk_share": round(100 * disk / total, 1) if total else 0,
        "mem_share": round(100 * mem / total, 1) if total else 0,
        "mem_wide_share": round(100 * mem_wide / total, 1) if total else 0,
        "graft_calls": graft,
        "repeat_share": round(100 * repeats / total, 1) if total else 0,
        "refusal_share": round(100 * refusals / total, 1) if total else 0,
        "refusals": refusals,
        "refusal_shape_share": round(100 * refusals_shape / refusals, 1) if refusals else 0,
        "order_ok": order_ok,
        "order_n": order_n,
        "order_share": round(100 * order_ok / order_n, 1) if order_n else 0,
        "no_submit_share": round(100 * sum(1 for s in steps if not s["submitted"]) / n, 1) if n else 0,
        "multi_session_steps": sum(1 for s in steps if s["files"] > 1),
        "restarts_per_step": round(sum(max(0, s["files"] - 1) for s in steps) / n, 2) if n else 0,
        "unreadable_files": sum(s["unread"] for s in steps),
        "model_hours": round(sum(s["model_sec"] for s in steps) / 3600, 1),
        "tool_hours": round(sum(s["tool_sec"] for s in steps) / 3600, 1),
    }


def collect(since, until):
    card, cardmain, skipped = [], [], {"empty": 0, "out_of_window": 0, "unreadable": 0}
    for d in sorted(glob.glob(os.path.join(ROOT, "*"))):
        if not os.path.isdir(d):
            continue
        files = glob.glob(os.path.join(d, "*.jsonl"))
        if not files:
            continue
        stamps = [t for t in (file_ts(f) for f in files) if t]
        if not stamps:
            continue
        first = min(stamps)
        if not (since <= first < until):
            skipped["out_of_window"] += 1
            continue
        rec = load_dir(d)
        if not rec["calls"]:
            skipped["empty"] += 1
            continue
        if re.search(r"-[A-Za-z_]+-main$", rec["dir"]):
            cardmain.append(rec)
        else:
            card.append(rec)
    return card, cardmain, skipped


def chat_available():
    """Чатовые журналы ролей: каталог /home/maksim/taskflow — 700 maksim."""
    try:
        os.listdir(CHAT_ROOT)
        return True, None
    except PermissionError as e:
        return False, f"{CHAT_ROOT}: {e.strerror}"
    except FileNotFoundError:
        return False, f"{CHAT_ROOT}: каталог не найден"


def main():
    since_s = sys.argv[1] if len(sys.argv) > 1 else "1970-01-01T00:00:00"
    until_s = sys.argv[2] if len(sys.argv) > 2 else "2100-01-01T00:00:00"
    out_path = None
    if "--json" in sys.argv:
        out_path = sys.argv[sys.argv.index("--json") + 1]
    since = datetime.datetime.fromisoformat(since_s)
    until = datetime.datetime.fromisoformat(until_s)
    card, cardmain, skipped = collect(since, until)
    ok_chat, chat_reason = chat_available()
    result = {
        "since": since_s, "until": until_s,
        "definitions": "заметка 1239163b: card = рабочие шаги карточки, "
                       "cardmain = сессии уровня карточки, chat = чатовые ходы",
        "card": metrics(card, "шаг карточки"),
        "cardmain": metrics(cardmain, "сессия уровня карточки"),
        "chat": {"unit": "ход чата", "available": ok_chat,
                 "reason": chat_reason, "steps": 0, "calls": 0},
        "skipped": skipped,
        "base": BASE,
        "comparable_with_base": {
            "card": True,
            "cardmain": False,
            "chat": ok_chat,
            "overall": False,
            "note": "числа базы для «overall» (30,8 % диск, 13 % отказы, "
                    "8,8 % повторы, 142 ч, 6,6 перезапуска) смешивают чат и "
                    "карточку; без чатовых журналов не воспроизводятся",
        },
    }
    txt = json.dumps(result, ensure_ascii=False, indent=2)
    print(txt)
    if out_path:
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(txt + "\n")


if __name__ == "__main__":
    main()
