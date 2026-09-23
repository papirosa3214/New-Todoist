#!/usr/bin/env python3
"""Серверный конвейер глубокого исследования задачи.

Владелец 21.09.2026 (хэндофф HANDOFF-RESEARCHER-2026-09-21): до этого порядок
«план → сбор → валидация → синтез → отчёт» жил ТОЛЬКО в промпте роли
(`role-prompts/researcher.md`) — то есть держался на дисциплине модели. Здесь
он зафиксирован в коде: сервер сам раскладывает вопрос на проверяемые части,
сам ходит за источниками, сам повторяет сбор, пока проверка не скажет
«достаточно» (с жёстким потолком раундов), и кладёт итог отчётом в карточку.

Что откуда берётся:
  • инструменты сбора — те же, что у агента-исследователя: `mcp_server.py`
    (`taskflow_web_search`, `taskflow_web_get`, `taskflow_ocr`,
    `taskflow_youtube`, `taskflow_docs`/`taskflow_doc_read`,
    `taskflow_kb_search`). Не второй набор, а тот же код: агент и конвейер
    должны видеть одинаковый мир.
  • «мозг» шагов — локальная модель Ollama (решение владельца 21.09.2026:
    весь MVP на локальной модели; основной моделью Pi-рантайм сервер напрямую
    не управляет — это отдельная доработка). Модель нужна для плана, проверки
    достаточности и синтеза; сам сбор — это инструменты, а не модель.
  • итог — `taskflow_report`: светлый HTML+PDF, зеркало-заметка в доках
    проекта и отдельная секция «Отчёты» в карточке.

Запускается ТОЛЬКО роутом `POST /api/tasks/:id/research` (владелец, задача
помечена `needs_research=1`) как отдельный процесс — см. `routes/research.ts`.
Токен приходит в окружении `TASKFLOW_TOKEN` (короткоживущий JWT владельца).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# Сеть .110 выпускает трафик через локальный xray — роль researcher прописывает
# тот же выход (`HTTPS_PROXY`) в свой профиль (хэндофф 21.09.2026). Запуск из
# сервера профиль агента не наследует, поэтому ставим выход здесь, если он не
# задан снаружи. localhost в NO_PROXY обязателен: иначе urllib погонит запросы
# к самому TaskFlow через тот же прокси.
os.environ.setdefault("HTTPS_PROXY", "http://127.0.0.1:10811")
os.environ.setdefault("HTTP_PROXY", "http://127.0.0.1:10811")
os.environ.setdefault(
    "NO_PROXY", "localhost,127.0.0.1,192.168.1.110"
)

# Инструменты сбора — из боевого MCP-сервера, чтобы не заводить вторую копию.
import mcp_server as mcp  # noqa: E402

OLLAMA = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get(
    "RESEARCH_MODEL",
    os.environ.get("OLLAMA_MODEL", "qwen3.6-27b-iq4-16k:latest"),
)
LLM_TIMEOUT = int(os.environ.get("RESEARCH_LLM_TIMEOUT", "300"))

# Облачная модель — та же, что у роли researcher, и тем же путём. Владелец
# 21.09.2026: «облачная такая же, как у роли агента» — то есть не «какой-нибудь
# OpenRouter», а конкретно `models.researcher` из `role-routing.yaml`
# (`MiniMax-M3`), напрямую в `api.minimax.io/anthropic` (anthropic-messages),
# ключом из Pi (`~/.pi/agent/auth.json`). Имя модели читается из роутинга, а не
# хардкодится: сменит владелец модель роли — конвейер пойдёт за ней.
#
# Разделение шагов: план и проверка — облачной (качество рассуждения), синтез —
# локальной (дешёвый объёмный текст). Если облачная недоступна — откат на
# локальную, причина в stderr, имя модели в ленту задачи.
ROLE = os.environ.get("RESEARCH_ROLE", "researcher")
CLOUD_TIMEOUT = int(os.environ.get("RESEARCH_CLOUD_TIMEOUT", "180"))

ROLE_ROUTING = os.path.join(HERE, "role-routing.yaml")
PI_AUTH = os.path.expanduser("~/.pi/agent/auth.json")
PI_MODELS = os.path.expanduser("~/.pi/agent/models-store.json")

# Потолки конвейера — в одном месте, чтобы «сколько это стоит» не искалось
# по коду. Лимит источников владелец просил начать с 5–10 (хэндофф, п.4).
MAX_ROUNDS = int(os.environ.get("RESEARCH_MAX_ROUNDS", "3"))
MAX_QUERIES = int(os.environ.get("RESEARCH_MAX_QUERIES", "4"))
MAX_SOURCES = int(os.environ.get("RESEARCH_MAX_SOURCES", "10"))
SOURCES_PER_QUERY = int(os.environ.get("RESEARCH_SOURCES_PER_QUERY", "3"))
SOURCE_CHARS = int(os.environ.get("RESEARCH_SOURCE_CHARS", "6000"))


def log(msg: str) -> None:
    print(f"[research] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- лента задачи

def comment(task_id: str, text: str) -> None:
    """Строка статуса в ленту задачи. Не роняет шаг: не ушла — идём дальше."""
    try:
        mcp.t_comment({"id": task_id, "text": text})
    except Exception as e:  # noqa: BLE001
        log(f"комментарий не ушёл: {e}")


def activity(task_id: str, detail: str) -> None:
    try:
        mcp.send_activity(task_id, "edit", "исследование", detail)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- локальная модель

def llm(system: str, user: str, *, num_ctx: int = 16384, predict: int = 3072) -> str:
    """Один вызов локальной модели. Без стрима, без «думания» (для шагов
    конвейера скорость важнее), строго результат."""
    body = {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": system + "\nРассуждай кратко. Верни строго требуемый результат.",
            },
            {"role": "user", "content": user},
        ],
        "stream": False,
        "think": False,
        "options": {"num_ctx": num_ctx, "num_predict": predict, "temperature": 0.2},
    }
    req = urllib.request.Request(
        OLLAMA + "/api/chat",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as r:
            data = json.loads(r.read().decode())
    except urllib.error.URLError as e:
        raise RuntimeError(f"локальная модель недоступна: {e}") from e
    msg = data.get("message") or {}
    content = (msg.get("content") or "").strip()
    if not content:
        content = (msg.get("thinking") or "").strip()
    if not content:
        raise RuntimeError("локальная модель вернула пустой ответ")
    return content


def role_model_name(role: str = ROLE) -> str:
    """Имя модели роли из `role-routing.yaml` (секция `models:`). Простой
    разбор текста — тащить PyYAML ради одной строки не нужно."""
    try:
        text = open(ROLE_ROUTING, encoding="utf-8").read()
        m = re.search(r"^models:\s*$", text, re.M)
        tail = text[m.end():] if m else text
        mm = re.search(rf"^\s*{re.escape(role)}:\s*(\S+)", tail, re.M)
        if mm:
            return mm.group(1).strip().strip("\"'")
    except Exception as e:  # noqa: BLE001
        log(f"не прочитать модель роли из {ROLE_ROUTING}: {e}")
    return "MiniMax-M3"


def cloud_target() -> tuple[str, str, str]:
    """(model, base_url, provider) — ровно то, чем ходит роль: запись модели
    из стора Pi. Окружение может переопределить имя модели."""
    model = os.environ.get("RESEARCH_CLOUD_MODEL") or role_model_name()
    try:
        store = json.load(open(PI_MODELS, encoding="utf-8"))
        for pname, provider in store.items():
            for m in provider.get("models") or []:
                if m.get("id") == model:
                    return model, m.get("baseUrl"), m.get("provider") or pname
    except Exception as e:  # noqa: BLE001
        log(f"не прочитать стор моделей Pi ({e}) — беру MiniMax по умолчанию")
    return model, "https://api.minimax.io/anthropic", "minimax"


def cloud_key(provider: str) -> str:
    """Ключ облачной модели. Основной путь — тот же, что у Pi: `auth.json`.
    Запасной — хранилище (на случай, если ключ туда положат явно)."""
    try:
        auth = json.load(open(PI_AUTH, encoding="utf-8"))
        entry = auth.get(provider)
        if isinstance(entry, dict) and entry.get("key"):
            return str(entry["key"])
    except Exception as e:  # noqa: BLE001
        log(f"не прочитать ключ облачной модели из {PI_AUTH}: {e}")
    for name in ("MINIMAX_API_KEY", "MINIMAX_OAUTH_TOKEN"):
        try:
            return mcp._vault_read(name)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("нет ключа облачной модели")


def cloud_chat(system: str, user: str, *, max_tokens: int = 2048) -> str:
    """Один вызов облачной модели роли (anthropic-messages)."""
    model, base, provider = cloud_target()
    key = cloud_key(provider)
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/messages",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=CLOUD_TIMEOUT) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"облачная модель HTTP {e.code}: {e.read().decode()[:300]}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"облачная модель недоступна: {e}") from e
    parts = data.get("content") or []
    text = "".join(
        p.get("text") or "" for p in parts if isinstance(p, dict) and p.get("type") == "text"
    ).strip()
    if not text:
        text = str(data.get("completion") or "").strip()
    if not text:
        raise RuntimeError("облачная модель вернула пустой ответ")
    return text


def cloud_label() -> str:
    try:
        return f"облачная {cloud_target()[0]}"
    except Exception:  # noqa: BLE001
        return "облачная"


def cloud_then_local(
    system: str, user: str, *, num_ctx: int = 16384, predict: int = 2048
) -> tuple[str, str]:
    """Облачная модель, при отказе — локальная. Возвращает (текст, откуда).
    Откат молча не проходит: причина уходит в stderr, а имя модели — в ленту
    задачи, чтобы по карточке было видно, чем реально считали."""
    try:
        return cloud_chat(system, user, max_tokens=predict), cloud_label()
    except Exception as e:  # noqa: BLE001
        log(f"облачная модель не сработала ({e}) — беру локальную {MODEL}")
        return llm(system, user, num_ctx=num_ctx, predict=predict), f"локальная {MODEL}"


def extract_json(text: str) -> dict:
    """Достать первый JSON-объект из ответа модели (модели любят обернуть его
    в ```json и дописать пояснение до/после)."""
    t = text.strip()
    t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("в ответе модели нет JSON-объекта")
    return json.loads(t[start : end + 1])


# ---------------------------------------------------------------- шаги конвейера

def build_plan(title: str, description: str) -> tuple[list[dict], str]:
    """Шаг 1. Вопрос → 2–4 проверяемые части, каждая со своим поисковым
    запросом. Закрывает требование промпта роли «работай шагами»."""
    system = (
        "Ты планировщик исследования. Разложи вопрос на 2-4 ПРОВЕРЯЕМЫЕ части. "
        "Для каждой дай короткий поисковый запрос (до 12 слов, ключевые слова "
        "без воды) и одно предложение, что считаем доказательством. "
        'Верни СТРОГО JSON: {"queries":[{"query":"...","why":"..."}]}. '
        "Никакого текста вокруг JSON."
    )
    user = f"Тема задачи: {title}\n\nОписание:\n{description or '(пусто)'}"
    text, source = cloud_then_local(system, user, predict=1536)
    data = extract_json(text)
    queries = [
        q
        for q in (data.get("queries") or [])
        if isinstance(q, dict) and str(q.get("query") or "").strip()
    ]
    if not queries:
        queries = [{"query": title, "why": "прямой запрос по теме задачи"}]
    return queries[:MAX_QUERIES], source


def gather_sources(task_id: str, queries: list[dict], seen_urls: set, sources: list) -> None:
    """Шаг 2. По каждой части — поиск, затем выкачиваем лучшие страницы
    чистым markdown. Плюс база знаний по первой части: возможно, это уже
    разбирали (тем же правилом «сначала KB», что у людей)."""
    for q in queries:
        if len(sources) >= MAX_SOURCES:
            return
        query = str(q["query"]).strip()

        # База знаний — один раз, только по первому запросу раунда.
        if q is queries[0]:
            try:
                kb = mcp.t_kb_search({"query": query, "top_k": 3})
                for chunk in (kb.get("куски") or [])[:3]:
                    text = (chunk.get("текст") or "").strip()
                    if text:
                        sources.append(
                            {
                                "query": query,
                                "title": f"База знаний: заметка {chunk.get('id_заметки')}",
                                "url": f"note:{chunk.get('id_заметки')}",
                                "text": text[:SOURCE_CHARS],
                            }
                        )
            except Exception as e:  # noqa: BLE001
                log(f"kb_search не удался: {e}")

        try:
            found = mcp.t_web_search({"query": query, "max_results": 5})
        except Exception as e:  # noqa: BLE001
            log(f"web_search «{query}» не удался: {e}")
            continue

        results = (found.get("results") or [])[:SOURCES_PER_QUERY]
        for r in results:
            if len(sources) >= MAX_SOURCES:
                return
            url = str(r.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            text = ""
            try:
                page = mcp.t_web_get({"url": url, "max_chars": SOURCE_CHARS})
                text = (page.get("markdown") or "").strip()
            except Exception as e:  # noqa: BLE001
                log(f"web_get {url} не удался: {e}")
            # Страница не скачалась (таймаут, 403, bot-check) — берём хотя бы
            # выжимку поисковика. Источник остаётся источником, просто короче;
            # терять весь раунд из-за одного упрямого сайта нельзя.
            if len(text) < 200:
                text = str(r.get("snippet") or "").strip()
            if len(text) < 80:
                continue
            seen_urls.add(url)
            sources.append(
                {
                    "query": query,
                    "title": str(r.get("title") or url),
                    "url": url,
                    "text": text[:SOURCE_CHARS],
                }
            )


def sources_digest(sources: list, limit: int = 14000) -> str:
    parts = []
    for i, s in enumerate(sources, 1):
        parts.append(
            f"[{i}] {s['title']}\nURL: {s['url']}\nВопрос: {s['query']}\n"
            f"{s['text']}\n"
        )
    joined = "\n---\n".join(parts)
    return joined[:limit]


def validate(title: str, sources: list) -> tuple[dict, str]:
    """Шаг 3. Проверка: хватает ли собранного, что противоречит, чего нет.
    Возвращает ({enough, gaps[], notes}, откуда ответ)."""
    system = (
        "Ты проверяющий исследователь. Реши, достаточно ли собранного, чтобы "
        "ответить на вопрос. По умолчанию считай, что ДОСТАТОЧНО, если по "
        "каждой части плана есть хотя бы один содержательный фрагмент: "
        "исследование не обязано закрыть все пробелы, важнее честно их назвать. "
        "Отметь противоречия и ограничения. `enough:false` ставь ТОЛЬКО когда "
        "по ключевой части вопроса материала нет вовсе; тогда предложи до двух "
        'уточняющих поисковых запросов. Верни СТРОГО JSON: {"enough":true|false,'
        '"gaps":["поисковый запрос"],"notes":"противоречия, ограничения, пробелы"}.'
    )
    user = f"Вопрос: {title}\n\nСобранные фрагменты:\n{sources_digest(sources)}"
    try:
        text, source = cloud_then_local(system, user, predict=1536)
        data = extract_json(text)
    except Exception as e:  # noqa: BLE001
        log(f"валидация не распарсилась ({e}) — считаю, что достаточно")
        return {"enough": True, "gaps": [], "notes": ""}, "пропущена"
    gaps = [
        {"query": str(g).strip(), "why": "уточняющий поиск по пробелу"}
        for g in (data.get("gaps") or [])
        if str(g).strip()
    ]
    return (
        {
            "enough": bool(data.get("enough")),
            "gaps": gaps[:2],
            "notes": str(data.get("notes") or "").strip(),
        },
        source,
    )


def synthesize(
    title: str, description: str, sources: list, validation: dict
) -> tuple[str, str]:
    """Шаг 4. Синтез: факт → источник → уверенность, противоречия и пробелы
    названы прямо. Формат — из промпта роли. По решению владельца синтез идёт
    ЛОКАЛЬНОЙ моделью (объёмный текст дешевле локально); облачная — только
    запасной путь, если локальная не ответила."""
    system = (
        "Ты исследователь TaskFlow. Составь отчёт на русском в markdown строго "
        "по структуре:\n"
        "# Краткий вывод\nсжатый ответ\n"
        "## Подтверждённые факты\nпо пункту: факт → источник (номер из списка)\n"
        "## Противоречия и ограничения\nчто расходится, дата и область применимости\n"
        "## Пробелы\nчто не проверено и почему\n"
        "## Источники\nнумерованный список ссылок\n"
        "Опирайся только на собранные фрагменты. Не выдавай предположение за факт. "
        "Если факт не подтверждён — скажи это прямо."
    )
    notes = validation.get("notes") or "не найдены"
    user = (
        f"Вопрос: {title}\n\nОписание задачи:\n{description or '(пусто)'}\n\n"
        f"Замечания проверки: {notes}\n\nСобранные фрагменты:\n"
        f"{sources_digest(sources)}"
    )
    try:
        return llm(system, user, num_ctx=16384, predict=4096).strip(), f"локальная {MODEL}"
    except Exception as e:  # noqa: BLE001
        log(f"локальный синтез не удался ({e}) — синтезирую облачной")
        return cloud_chat(system, user, max_tokens=4096).strip(), cloud_label()


def run(task_id: str) -> int:
    token = os.environ.get("TASKFLOW_TOKEN", "").strip()
    if not token:
        log("нет TASKFLOW_TOKEN — работать нечем")
        return 2
    # Инструменты MCP берут ключ из модульной переменной; подкладываем наш.
    mcp.TOKEN = token

    data = mcp.api("GET", f"/api/tasks/{task_id}")
    task = mcp.unwrap(data) if isinstance(data, dict) and "task" in data else data
    title = str(task.get("title") or "Задача").strip()
    description = str(task.get("description") or "").strip()

    comment(
        task_id,
        "🔎 Начинаю глубокое исследование: план → сбор → проверка → синтез → отчёт "
        f"(облачная: {role_model_name()}, локальная: {MODEL}).",
    )
    activity(task_id, "исследование: план")

    try:
        queries, plan_src = build_plan(title, description)
    except Exception as e:  # noqa: BLE001
        comment(task_id, f"❌ Не смог построить план исследования: {e}")
        return 1
    comment(
        task_id,
        f"План ({plan_src}): " + "; ".join(f"«{q['query']}»" for q in queries),
    )

    # Вложения-сканы и PDF — в тот же котёл, до сети: возможно, ответ уже в них.
    sources: list[dict] = []
    seen_urls: set = set()
    for att in task.get("attachments") or []:
        att_id = att.get("id") if isinstance(att, dict) else None
        if not att_id:
            continue
        try:
            ocred = mcp.t_ocr({"attachment_id": att_id})
            text = (ocred.get("text") or "").strip()
            if text:
                sources.append(
                    {
                        "query": "вложение задачи",
                        "title": f"Вложение {att.get('file_name') or att_id}",
                        "url": f"attachment:{att_id}",
                        "text": text[:SOURCE_CHARS],
                    }
                )
        except Exception as e:  # noqa: BLE001
            log(f"ocr вложения {att_id} не удался: {e}")

    validation = {"enough": False, "gaps": [], "notes": ""}
    rounds_used = 0
    for rnd in range(1, MAX_ROUNDS + 1):
        rounds_used = rnd
        activity(task_id, f"сбор источников, раунд {rnd}")
        before = len(sources)
        gather_sources(task_id, queries, seen_urls, sources)
        if not sources:
            comment(
                task_id,
                "⚠️ Поиск не вернул пригодных источников — "
                "останавливаюсь, чтобы не выдумывать.",
            )
            break
        comment(task_id, f"Раунд {rnd}: собрано источников — {len(sources)}.")
        # Дошли до потолка источников — дальше собирать некуда.
        if len(sources) >= MAX_SOURCES:
            break
        # Новых источников раунд не принёс (всё уже видели) — гонять дальше
        # те же запросы бессмысленно, это только жжёт время.
        if rnd > 1 and len(sources) == before:
            break
        validation, val_src = validate(title, sources)
        if validation["enough"] or not validation["gaps"]:
            break
        comment(
            task_id,
            f"Проверка ({val_src}): материала мало, добираю по пробелам — "
            + "; ".join(f"«{g['query']}»" for g in validation["gaps"]),
        )
        queries = validation["gaps"]

    if not sources:
        comment(
            task_id,
            "❌ Исследование не дало источников. Отчёта нет; "
            "попробуйте уточнить формулировку задачи и запустить ещё раз.",
        )
        return 1

    activity(task_id, "синтез отчёта")
    try:
        markdown, synth_src = synthesize(title, description, sources, validation)
    except Exception as e:  # noqa: BLE001
        comment(task_id, f"❌ Синтез не удался: {e}")
        return 1

    if len(markdown) < 40:
        comment(task_id, "❌ Синтез вернул пустой отчёт — не сохраняю заглушку.")
        return 1

    activity(task_id, "сохранение отчёта")
    try:
        out = mcp.t_report(
            {
                "task_id": task_id,
                "title": f"Исследование: {title}"[:200],
                "markdown": markdown,
            }
        )
    except Exception as e:  # noqa: BLE001
        comment(task_id, f"❌ Не смог сохранить отчёт: {e}")
        return 1

    comment(
        task_id,
        "✅ Готово. Отчёт «Исследование: "
        f"{title}» — в секции «Отчёты» карточки "
        f"(PDF/HTML) и заметкой в документации проекта. "
        f"Источников: {len(sources)}, раундов сбора: {rounds_used}, "
        f"синтез: {synth_src}.",
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Серверный конвейер исследования TaskFlow")
    parser.add_argument("--task", required=True, help="id задачи")
    args = parser.parse_args()
    try:
        return run(args.task)
    except Exception as e:  # noqa: BLE001 — наружу понятный выход
        log(f"конвейер упал: {e!r}")
        try:
            mcp.TOKEN = os.environ.get("TASKFLOW_TOKEN", "")
            comment(args.task, f"❌ Конвейер остановился с ошибкой: {e}")
        except Exception:  # noqa: BLE001
            pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
