#!/usr/bin/env python3
"""Считает бюджет времени ролей TaskFlow по журналам сессий.

Зачем: после правок нужно уметь пересчитать то же самое теми же числами.
Сравнивать «до/после» можно только тем же способом, что и в отчёте
docs/2026-10-21-agent-speed-budget.md.

Запуск:
  python3 scripts/agent-time-budget.py                 # окна 30/7/3 дня
  python3 scripts/agent-time-budget.py --days 7
  python3 scripts/agent-time-budget.py --sessions-dir /путь/к/sessions

Источники (только чтение):
  /home/maksim/.local/state/taskflow-runs/sessions/*/*.jsonl  — журналы ролей
  /home/maksim/Проекты/New-Todoist/server/taskflow.db        — живая БД (опционально)

Считает: время модели, время инструментов, простой, отказы по причинам,
состав типичного сданного шага, висящие слоты.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

DEFAULT_SESSIONS = "/home/maksim/.local/state/taskflow-runs/sessions"
DIR_RE = re.compile(
    r"^(?P<task>[0-9a-f]{8}-[0-9a-f-]{27})-(?P<role>[a-z_]+)-"
    r"(?P<node>[0-9a-f]{8}-[0-9a-f-]{27}|main)$"
)
CD_PREFIX = re.compile(r"^\s*cd\s+[^\s;&|]+(?:\s*&&\s*)?", re.M)
SHELL_HEADS = {
    "grep", "find", "ls", "cat", "sed", "head", "tail", "rg", "graft", "git",
    "diff", "wc", "jq", "du", "df", "which",
}
SHELL_WRAP = {"echo", "mkdir", "rm", "cp", "mv", "true", "printf"}
SEARCH_OPS = {
    "taskflow:taskflow_kb_search", "taskflow:taskflow_recall",
    "taskflow:taskflow_docs", "taskflow:taskflow_doc_read",
    "taskflow:taskflow_task_summary", "taskflow:taskflow_kb_categorize",
    "bash:grep", "bash:find", "bash:ls", "bash:cat", "bash:sed", "bash:head",
    "bash:tail", "bash:rg", "bash:graft", "bash:git", "bash:diff", "bash:wc",
    "bash:jq", "bash:du", "bash:df", "bash:which", "read", "grep", "find", "ls",
}
SUBTASK_DONE = ("taskflow:taskflow_subtask_done", "taskflow_subtask_done")


def parse_ts(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)


def op_of(name: str, args: dict) -> str:
    if name == "taskflow":
        return "taskflow:" + str(args.get("operation", "?"))
    if name == "bash":
        cmd = CD_PREFIX.sub("", str(args.get("command", ""))).strip()
        head = cmd.split()[0] if cmd.split() else "cd_only"
        return "bash:" + head
    if name.startswith("taskflow_"):
        return "taskflow:" + name
    return name


def group_of(op: str) -> str:
    if op.startswith("bash:"):
        head = op.split(":", 1)[1]
        if head in SHELL_HEADS:
            return "поиск и чтение диска"
        if head == "sleep":
            return "ожидание sleep"
        if head in SHELL_WRAP:
            return "обвязка shell"
        return "долгие команды"
    if op.startswith("taskflow:"):
        name = op.split(":", 1)[1]
        if name in ("taskflow_kb_search", "taskflow_recall", "taskflow_docs",
                    "taskflow_doc_read", "taskflow_task_summary", "taskflow_kb_categorize"):
            return "поиск по базе знаний"
        if name in ("taskflow_work_plan", "taskflow_subtask_work", "taskflow_state",
                    "taskflow_heartbeat", "taskflow_claim", "taskflow_slot_status",
                    "taskflow_slot_snapshot", "taskflow_dependencies"):
            return "служебное: слот и чек-лист"
        if name in ("taskflow_subtask_done", "taskflow_review", "taskflow_comment",
                    "taskflow_doc_write", "taskflow_report", "taskflow_remember",
                    "taskflow_topic_send", "taskflow_topic_reply", "taskflow_chat_send",
                    "taskflow_plan_request", "taskflow_consult", "taskflow_create_task",
                    "taskflow_subtask_add"):
            return "сдача и связь"
        if name.startswith("taskflow_host_"):
            return "работа на маке"
        return "прочие серверные"
    if op in ("read", "grep", "find", "ls"):
        return "поиск и чтение диска"
    if op in ("write", "edit"):
        return "правка файлов"
    return "прочее"


def tool_failed(op: str, text: str, is_error: bool) -> bool:
    """Отказ: для операций TaskFlow — ok:false, для команд — ненулевой код."""
    if op.startswith("taskflow:") or op.startswith("mcp__"):
        try:
            obj = json.loads(text)
        except Exception:
            return is_error
        return isinstance(obj, dict) and obj.get("ok") is False
    if is_error:
        return True
    return "Command exited with code" in text


def error_message(text: str) -> str:
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            err = obj.get("error")
            if isinstance(err, dict):
                return str(err.get("message") or "")[:320]
            return str(obj.get("message") or "")[:320]
    except Exception:
        pass
    match = re.search(r'"message"\s*:\s*"(.{0,320}?)"(?:,\s*"hint"|"\s*$)', text, re.S)
    return re.sub(r"\s+", " ", match.group(1) if match else text[:300])


def cause_of(message: str) -> str:
    if "нужен request_id" in message:
        return "чек-лист: вызов без request_id"
    if "пришли ключи [base_revision, items], ждём [base_revision, items]" in message:
        return "чек-лист: items не принят"
    if "пришли ключи [items], ждём [base_revision, items]" in message:
        return "чек-лист: items без base_revision"
    if "base_revision" in message or "План изменился" in message:
        return "чек-лист: не та ревизия"
    if "task_id" in message and "ждём [id" in message:
        return "неверное имя аргумента (task_id вместо id)"
    if "пришли ключи [command], ждём [machine" in message or "пришли ключи [path], ждём [machine" in message:
        return "mac: плоский вызов не принят"
    if "пришли ключи [content, kind, scope]" in message:
        return "память: content вместо text"
    if "Поддерживается version: 1" in message:
        return "версия операции не та"
    if "поле отсутствует" in message:
        return "не хватает обязательного поля"
    if "Этот request_id уже использован" in message:
        return "повтор с другим аргументом"
    if "Операция не найдена" in message:
        return "нет такой операции"
    if "Состояние относится только к текущему слоту" in message:
        return "heartbeat не по своему слоту"
    if "не текущему слоту" in message or "только текущего исполнителя" in message:
        return "чек-лист: не тот слот"
    if "текущего цикла" in message:
        return "ревью: этап не текущего цикла"
    if "Reviewer обязан оставить комментарий" in message:
        return "ревью: без комментария"
    if "required_fields" in message or "required properties report_markdown" in message:
        return "сдача: отчёт не в том виде"
    if "у узла нет artifact contract" in message:
        return "сдача: artifact без контракта"
    if "должен быть коммит" in message:
        return "сдача: нет коммита поверх main"
    if message.startswith("Укажи доступную роль") or message.startswith("Укажи конкретный слот") or "не участвует в теме" in message:
        return "переписка: нет роли/слота"
    if "Тема вне согласованной ветки" in message:
        return "переписка: тема не согласована"
    if "Working directory does not exist" in message:
        return "рабочая папка исчезла"
    if "No such file or directory" in message or "Path outside developer checkout" in message or "EISDIR" in message:
        return "путь не найден / нет доступа"
    if "Could not find the exact text" in message or "No changes made" in message:
        return "правка не нашла текст"
    if "404" in message:
        return "объект не найден (404)"
    if "Command exited with code" in message:
        return "команда вернула ошибку"
    return "прочее"


# ─────────── семейства отказов (группы по существу) ───────────
# «прочее» из cause_of — это 50 % отказов без разбора. Здесь они и все
# остальные отказы раскладываются по существу: что именно было не так.
FAMILIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("вызов: массив пришёл объектом", (
        "ожидается массив; получен объект",
        '{"item"',
    )),
    ("вызов: имя аргумента не то", (
        "task_id вместо id",
        "content вместо text",
        "ожидается число",
        "ожидается boolean",
        "ожидается строка",
    )),
    ("вызов: аргументы не совпали со схемой", (
        "Аргументы не соответствуют inputSchema",
        "пришли ключи",
        "поле отсутствует",
        "Поддерживается version",
        "нужен request_id",
        "уже использован",
        "Операция не найдена",
        "Validation failed for tool",
        "must have required properties",
    )),
    ("вызов: инструмент не найден", (
        "Tool bash not found",
    )),
    ("слот: шаг не мой или ждёт предшественников", (
        "закреплён не за тобой",
        "ждёт предшественников",
        "только в назначенном текущем слоте",
        "Работай только в назначенном",
        "не взяв его в работу",
        "не текущему слоту",
        "текущего цикла",
        "Рабочий план относится к текущему слоту",
        "План обновляет только текущий исполнитель",
        "Роль выполняет только назначенный сервером слот",
    )),
    ("план: недопустимая правка графа", (
        "замыкает план в цикл",
        "неизвестная роль",
        "invalid transition",
    )),
    ("сдача и ревью: отчёт не в том виде", (
        "result слишком длинный",
        "нужен раздел",
        "required_fields",
        "обязательные поля",
        "нет artifact contract",
        "должен быть коммит",
    )),
    ("переписка: чат, тема, адресат", (
        "Чат задачи закрыт",
        "не закреплён за тобой или относится к другой ветке",
        "У задачи пока нет темы",
        "Адресат не найден",
        "Не отвечай сам себе",
        "Нужно исходное сообщение",
        "Лимит 4 сообщений",
        "не участвует в теме",
        "Тема вне согласованной ветки",
        "Отправитель не назначен на этап",
        "slot_key задаётся в теме",
        "не относится к согласованной ветке",
    )),
    ("работа на маке: host-операция", (
        "Проект не совпадает с задачей",
        "не настроен удалённый host",
        "ждём [machine, project_id, task_id, arguments]",
        "не папка",
        "хост не ответил",
    )),
    ("память и запись данных", (
        "для памяти проекта нужен project_id",
        "Не удалось сохранить результат запроса",
        "resultPath.endsWith is not a function",
        "ждём [text, kind, scope, title, project_id, source_ref]",
    )),
    ("доступ к файлам и папкам роли", (
        "нет доступа к файлу",
        "чтение вне рабочей копии роли запрещено",
        "запись вне рабочей копии роли запрещено",
        "Path outside developer checkout",
        "вне разрешённых корней",
        "path_denied",
        "EACCES",
        "permission denied",
        "ENOENT",
    )),
    ("права на карточку и её шаги", (
        "может только её исполнитель",
        "шаг адресата уже закрыт",
        "нужен комментарий",
    )),
)


def family_of(message: str) -> str:
    for name, needles in FAMILIES:
        for needle in needles:
            if needle in message:
                return name
    return "прочее: не разобрано"


def read_sessions(sessions_dir: str) -> tuple[list[dict], list[dict]]:
    import glob

    rows: list[dict] = []
    sessions: list[dict] = []
    for path in sorted(glob.glob(os.path.join(sessions_dir, "*", "*.jsonl"))):
        folder = os.path.basename(os.path.dirname(path))
        match = DIR_RE.match(folder)
        if not match:
            continue
        events: list[tuple[datetime, dict]] = []
        try:
            with open(path) as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except Exception:
                        continue
                    if record.get("type") != "message" or not record.get("timestamp"):
                        continue
                    try:
                        events.append((parse_ts(record["timestamp"]), record))
                    except Exception:
                        pass
        except OSError:
            continue
        if not events:
            continue
        pending: dict[str, tuple[str, datetime]] = {}
        pending_fail_rows: list[dict] = []
        prev = None
        model_s = tool_s = 0.0
        calls = fails = rounds = 0
        delivered = False
        per_op: dict[str, list[float]] = defaultdict(lambda: [0, 0.0, 0])
        for stamp, record in events:
            message = record.get("message") or {}
            role = message.get("role")
            if role == "assistant":
                if prev is not None:
                    model_s += (stamp - prev).total_seconds()
                if pending_fail_rows:
                    # Ход модели после цепочки отказов — это и есть цена отказа.
                    # Цепочка из нескольких отказов даёт один ответ модели, поэтому
                    # её время относим к последнему отказу: модель реагировала
                    # именно на него.
                    last = pending_fail_rows[-1]
                    last["recover_s"] = (stamp - prev).total_seconds() if prev else 0.0
                    last["recover"] = True
                    pending_fail_rows.clear()
                rounds += 1
                for part in message.get("content") or []:
                    if part.get("type") == "toolCall":
                        op = op_of(part.get("name", "?"), part.get("arguments") or {})
                        pending[part.get("id")] = (op, stamp)
            elif role == "toolResult":
                entry = pending.pop(message.get("toolCallId"), None)
                if entry:
                    op, started = entry
                    dur = (stamp - started).total_seconds()
                    tool_s += dur
                    calls += 1
                    text = " ".join(
                        part.get("text", "") for part in (message.get("content") or [])
                        if isinstance(part, dict)
                    )
                    bad = tool_failed(op, text, bool(message.get("isError")))
                    if bad:
                        fails += 1
                    elif op in SUBTASK_DONE:
                        delivered = True
                    bucket = per_op[op]
                    bucket[0] += 1
                    bucket[1] += dur
                    bucket[2] += 1 if bad else 0
                    msg = error_message(text) if bad else ""
                    row = {"op": op, "dur": dur, "err": bad, "ts": stamp,
                           "cause": cause_of(msg) if bad else "",
                           "msg": msg[:400],
                           "fam": family_of(msg) if bad else "",
                           "recover_s": 0.0, "recover": False}
                    rows.append(row)
                    if bad:
                        pending_fail_rows.append(row)
            prev = stamp
        wall = (events[-1][0] - events[0][0]).total_seconds()
        sessions.append({
            "task": match.group("task"), "role": match.group("role"), "node": match.group("node"),
            "kind": "step" if match.group("node") != "main" else "task",
            "start": events[0][0], "wall": wall, "model_s": model_s, "tool_s": tool_s,
            "calls": calls, "fails": fails, "rounds": rounds, "delivered": delivered,
            "per_op": dict(per_op),
        })
    return sessions, rows


def median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def report(sessions: list[dict], rows: list[dict], days: int, until: datetime | None = None) -> None:
    end = until or datetime.now(timezone.utc)
    cut = end - timedelta(days=days)
    s = [x for x in sessions if cut <= x["start"] <= end]
    r = [x for x in rows if cut <= x["ts"] <= end]
    steps = [x for x in s if x["kind"] == "step"]
    done = [x for x in steps if x["delivered"]]
    lost = [x for x in steps if not x["delivered"]]
    model_h = sum(x["model_s"] for x in s) / 3600
    tool_h = sum(x["tool_s"] for x in s) / 3600
    idle_h = sum(x["wall"] - x["model_s"] - x["tool_s"] for x in s) / 3600
    fails = sum(1 for x in r if x["err"])
    print(f"\n=== окно {days} дн. ===")
    print(f"сессий {len(s)} (шагов {len(steps)}, сдано {len(done)}) | вызовов {len(r)} | отказов {fails} ({100*fails/max(len(r),1):.1f} %)")
    print(f"модель {model_h:.1f} ч | инструменты {tool_h:.1f} ч | простой {idle_h:.1f} ч")
    if done:
        print(f"медиана сданного шага: вызовов {median([x['calls'] for x in done]):.0f}, раундов {median([x['rounds'] for x in done]):.0f}, "
              f"отказов {median([x['fails'] for x in done]):.0f}, модель {median([x['model_s'] for x in done])/60:.1f} мин, "
              f"инструменты {median([x['tool_s'] for x in done])/60:.1f} мин, длина {median([x['wall'] for x in done])/60:.1f} мин")
        active = median([x["model_s"] + x["tool_s"] for x in done]) / 60
        print(f"активная часть шага (медиана): {active:.1f} мин")
    if lost:
        share = 100 * sum(x["model_s"] for x in lost) / max(sum(x["model_s"] for x in s), 1)
        print(f"модельное время в шагах без сдачи: {sum(x['model_s'] for x in lost)/60:.0f} мин = {share:.0f} %")
    groups: dict[str, list[float]] = defaultdict(lambda: [0, 0.0, 0])
    for x in done:
        for op, (n, sec, f) in x["per_op"].items():
            bucket = groups[group_of(op)]
            bucket[0] += n
            bucket[1] += sec
            bucket[2] += f
    if groups:
        total = sum(v[0] for v in groups.values())
        print("состав сданных шагов:")
        for name, (n, sec, f) in sorted(groups.items(), key=lambda kv: -kv[1][0]):
            print(f"   {name:30} {n:6} {100*n/total:5.1f} %  {sec/60:8.1f} мин  отказов {f}")
    causes: dict[str, list[float]] = defaultdict(lambda: [0, 0.0])
    for x in r:
        if x["err"]:
            bucket = causes[x["cause"]]
            bucket[0] += 1
            bucket[1] += x["dur"]
    if causes:
        print("отказы по причинам:")
        for name, (n, sec) in sorted(causes.items(), key=lambda kv: -kv[1][0])[:12]:
            print(f"   {n:5}  {name:44} {sec/60:7.1f} мин")

    # ── семейства: «прочее» разложено по существу ──
    def family_table(rows_in: list[dict], title: str) -> None:
        fam: dict[str, list[float]] = defaultdict(lambda: [0, 0.0, 0.0, 0])
        for x in rows_in:
            if not x["err"]:
                continue
            b = fam[x["fam"]]
            b[0] += 1
            b[1] += x["dur"]
            b[2] += x["recover_s"]
            b[3] += 1 if x["recover"] else 0
        total_f = sum(v[0] for v in fam.values())
        total_m = sum(v[2] for v in fam.values())
        if not total_f:
            return
        steps_n = len(done) or 1
        print(f"\n{title} (отказов {total_f}, мин модели на восстановление {total_m/60:.1f}):")
        for name, (n, sec, msec, turns) in sorted(fam.items(), key=lambda kv: -kv[1][2]):
            print(f"   {n:5} ({100*n/total_f:4.1f} %)  {name:48} "
                  f"инстр {sec/60:6.1f} мин  модель {msec/60:6.1f} мин  "
                  f"на шаг: {n/steps_n:4.1f} отказов, {msec/60/steps_n:4.2f} мин модели")

    family_table([x for x in r if x["err"]], "отказы по семействам (все отказы окна)")
    other_rows = [x for x in r if x["err"] and x["cause"] == "прочее"]
    family_table(other_rows, "прежнее «прочее», разложенное по существу")
    unparsed = [x for x in other_rows if x["fam"] == "прочее: не разобрано"]
    if unparsed:
        print(f"\n   из прежнего «прочее» осталось неразобранными: {len(unparsed)}")
        for msg, n in Counter(x["msg"][:150] for x in unparsed).most_common(40):
            print(f"      {n:4}  {msg}")
    hung = [x for x in s if x["wall"] - x["model_s"] - x["tool_s"] > 600]
    print(f"висящие слоты: сессий с простоем > 10 мин — {len(hung)}, простой всего {idle_h:.1f} ч")


def main() -> int:
    parser = argparse.ArgumentParser(description="Бюджет времени ролей TaskFlow")
    parser.add_argument("--sessions-dir", default=DEFAULT_SESSIONS)
    parser.add_argument("--days", type=int, nargs="*", default=[30, 7, 3])
    parser.add_argument("--until", default="",
                        help="конец окна (ISO, например 2026-10-20T22:20:00Z); "
                             "нужен, чтобы пересчитать тот же срез, что и в отчёте")
    args = parser.parse_args()
    until = None
    if args.until:
        until = datetime.strptime(args.until, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    if not os.path.isdir(args.sessions_dir):
        print(f"каталог сессий не найден: {args.sessions_dir}", file=sys.stderr)
        return 2
    sessions, rows = read_sessions(args.sessions_dir)
    print(f"разобрано сессий: {len(sessions)}, вызовов: {len(rows)}")
    for days in args.days:
        report(sessions, rows, days, until)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
