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


if __name__ == "__main__":
    mcp.main()
