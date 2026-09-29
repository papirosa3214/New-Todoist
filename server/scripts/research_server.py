#!/usr/bin/env python3
"""Исследовательский MCP-сервер — специальные инструменты роли researcher.

Владелец 21.09.2026: `web_search`, `web_get`, `ocr`, `youtube`, `local_model` —
это НЕ общие инструменты TaskFlow, а специальные исследовательские. Они лежали
в общем `mcp_server.py` и назывались `taskflow_*`, из-за чего выглядели как
разданные всем. Здесь они вынесены отдельным сервером и без префикса
`taskflow_`: подключаются ТОЛЬКО профилю роли researcher (`researcher.json`,
сервер `research`), другим ролям недоступны вовсе.

Реализации переиспользуются из `mcp_server.py` (один код, не копии) — этот файл
лишь подменяет список инструментов и отдаёт их по тому же протоколу. Ключ для
скачивания вложений (OCR) — ролевой, из хранилища.
"""
import json
import sys

import mcp_server as mcp

RESEARCH_TOOLS = [
    {
        "name": "web_search",
        "description": (
            "Найти в интернете: сначала Tavily, при недоступности — Brave. "
            "Возвращает список результатов со ссылками и выжимками. Текст "
            "страницы потом бери через web_get."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "поисковый запрос"},
                "max_results": {"type": "integer", "description": "1–10, по умолчанию 5"},
            },
            "required": ["query"],
        },
        "fn": mcp.t_web_search,
    },
    {
        "name": "web_get",
        "description": (
            "Скачать страницу и вернуть её ОСНОВНОЕ содержимое ЧИСТЫМ markdown "
            "— без меню, рекламы и скриптов. Для PDF и сканов — ocr."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "http(s)-адрес страницы"},
                "max_chars": {"type": "integer", "description": "потолок символов"},
            },
            "required": ["url"],
        },
        "fn": mcp.t_web_get,
    },
    {
        "name": "ocr",
        "description": (
            "Распознать текст из изображения или PDF (в том числе скан без "
            "текстового слоя), русский+английский. Источник — attachment_id "
            "вложения задачи или path файла на машине."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "attachment_id": {"type": "string", "description": "id вложения задачи"},
                "path": {"type": "string", "description": "путь к файлу на машине"},
                "langs": {"type": "string", "description": "языки tesseract"},
                "max_chars": {"type": "integer"},
            },
        },
        "fn": mcp.t_ocr,
    },
    {
        "name": "youtube",
        "description": (
            "Транскрипт видео YouTube в текст (сначала ручные субтитры, иначе "
            "авто). Источник-видео для исследования."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "ссылка на видео"},
                "langs": {"type": "string", "description": "языки субтитров, по умолчанию ru,en"},
                "max_chars": {"type": "integer"},
            },
            "required": ["url"],
        },
        "fn": mcp.t_youtube,
    },
    {
        "name": "local_model",
        "description": (
            "ЛОКАЛЬНАЯ модель на сервере (Ollama, бесплатно, без интернета). "
            "Этап «синтез»: отдай собранные фрагменты и задание — вернёт "
            "связный черновик или сводку. Готовый отчёт потом кладёшь "
            "через taskflow_report."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "материал + что нужно сделать"},
                "system": {"type": "string", "description": "роль/стиль (необязательно)"},
                "max_tokens": {"type": "integer", "description": "потолок ответа, по умолчанию 4096"},
                "num_ctx": {"type": "integer", "description": "окно контекста, по умолчанию 16384"},
            },
            "required": ["prompt"],
        },
        "fn": mcp.t_local_model,
    },
]

# Подменяем набор инструментов общего сервера на исследовательский — дальше
# работает тот же handle()/main(): протокол, allowlist и запуск общие.
mcp.TOOLS = RESEARCH_TOOLS
mcp.BY_NAME = {t["name"]: t for t in RESEARCH_TOOLS}
mcp.SERVER_NAME = "taskflow-research"


def _call_once(name: str) -> int:
    """Разовый вызов одного инструмента: JSON-аргументы на stdin, JSON-результат
    на stdout. Владелец 30.09.2026: инструменты этого сервера лежали в профиле
    (`researcher.json`) для СТАРОЙ схемы — внешний Pi-процесс сам говорил с этим
    сервером по MCP-протоколу через stdio. С переходом ролей на исполнение
    внутри сервера (23.09.2026) внешние MCP больше не подключаются вообще
    (`getExtensions()` в inProcessRun.ts пуст) — профиль тихо перестал работать,
    никто не заметил. Здесь — не полноценный MCP-хендшейк, а минимальный режим
    ровно под то, как сервер сейчас реально зовёт инструменты: один вызов,
    один результат, без держания процесса и состояния между вызовами.
    """
    tool = mcp.BY_NAME.get(name)
    if not tool:
        print(json.dumps({"error": f"неизвестный инструмент: {name}"}, ensure_ascii=False))
        return 1
    try:
        raw = sys.stdin.read()
        args = json.loads(raw) if raw.strip() else {}
    except ValueError as e:
        print(json.dumps({"error": f"аргументы не JSON: {e}"}, ensure_ascii=False))
        return 1
    try:
        mcp.TOKEN = mcp.load_token()
    except mcp.TaskFlowError as e:
        # Не у каждого инструмента этот сервер нужен токен TaskFlow (web_search
        # им не пользуется вовсе) — не падаем заранее, пусть решит сам инструмент,
        # понадобился ли ему TOKEN (тогда упадёт содержательно ниже).
        mcp.log(f"TOKEN не получен: {e}")
    try:
        result = tool["fn"](args)
    except mcp.TaskFlowError as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    except Exception as e:  # noqa: BLE001 — наружу понятный текст, не трассировка
        print(json.dumps({"error": f"сбой инструмента {name}: {e}"}, ensure_ascii=False))
        return 1
    print(json.dumps({"result": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if "--call" in sys.argv:
        _i = sys.argv.index("--call")
        _name = sys.argv[_i + 1] if len(sys.argv) > _i + 1 else ""
        sys.exit(_call_once(_name))
    else:
        mcp.main()
