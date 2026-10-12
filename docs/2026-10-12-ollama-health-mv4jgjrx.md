# 2026-10-12 — Ollama health-mv4jgjrx (503 «maximum pending requests exceeded»)

Связь с карточкой: `ollama-health-mv4jgjrx`, шаг `work_1` (Разработчик).

## Исходное состояние

- `ollama.service` активен, Main PID 2231845, started Sun 2026-10-11 10:12 MSK. В журнале за последний час нет `aborted`/`core dumped`/`fatal` — падений не было.
- `bge-m3-embed:latest` скачана (1.2 GB, 7 нед назад), в slot 0 (`size_vram:0`, CPU-only, context 8192).
- `POST http://127.0.0.1:11434/api/embeddings` для `bge-m3-embed:latest` стабильно отвечает 503 `{"error":"server busy, please try again.  maximum pending requests exceeded"}` (серия 5/5 + одиночные 3/3 той же ошибки за <300 мс).
- Активные клиенты слота в этот момент: `ollama_nothink_shim.py` (PID 2903731, 14d uptime) через `127.0.0.1:11500 → 127.0.0.1:11434`, node-клиент (PID 922276) `192.168.1.110:44942 → 192.168.1.110:11434`, контейнер `172.20.0.3` (RAGFlow) с десятками параллельных TCP на 11434.
- В `/api/tags` присутствуют `qwen3.6-27b-iq4-16k:latest` и `qwen3.6-before-queue-fix-20261011:latest` — последнее имя след ранее предпринимавшейся попытки вылечить очередь; в `/api/ps` сейчас загружена только bge-m3-embed.

Паттерн совпадает с уроком `kb/2026-10-08-ollama-stale-queue-qwen-report-editor.md` (там лечение было тем же `systemctl --user restart ollama.service`).

## Действие

- 04:01:57 MSK выполнен `systemctl --user restart ollama.service` (rc=0, новый Main PID 979274). TaskFlow при этом не перезапускался — по прецеденту урока 2026-10-08.

## Проверки

Все проверки делал на работающем сервере `.110` против порта 11434 (Ollama) и 3001 (TaskFlow-сервер). Копий и симуляторов не поднимал.

- `systemctl --user status ollama.service` — `active (running)`, без свежих падений в журнале.
- `/home/maksim/ollama/bin/ollama list` — строка `bge-m3-embed:latest 85a2fd0a8c4c 1.2 GB` присутствует.
- Серия из 4 запросов `POST /api/embeddings` для `bge-m3-embed:latest` после рестарта:

  | # | HTTP | время, с | длина embedding |
  |---|------|----------|-----------------|
  | 1 | 200  | 3.408    | 1024 (холодная загрузка) |
  | 2 | 200  | 27.504   | 1024 |
  | 3 | 200  | 0.085    | 1024 |
  | 4 | 200  | 0.085    | 1024 |

- Приборы TaskFlow через `/api/embeddings` (тот же клиент, что используют подбор ролей, фанаут плана, смысловой поиск):
  - `POST /api/embeddings` (одна строка): HTTP 200, `dim=1024`, `duration_ms=240`.
  - `POST /api/embeddings` (батч из 3 строк): HTTP 200, 3 эмбеддинга по 1024.
  - `GET /api/health`: HTTP 200, `{"ok":true,...}`.
  - `GET /api/agents`: HTTP 200, массив агентов возвращён.

## Итог

Все три критерия шага выполнены. Очередь сбросилась, приборы TaskFlow не отдают 502 по вине Ollama.

## Ограничения

- Причина первоначального зависания очереди (какой именно клиент её «заклинил» и почему модель не разгрузилась сама) внутри этого шага не исследовал — задача была про «503 по вине Ollama», и владелец санкционировал рестарт без отдельного расследования.
- Запросы от `ollama_nothink_shim.py`, `node` (PID 922276) и контейнера `172.20.0.3` (RAGFlow) описаны выше; их отдельное тушение владелец не санкционировал.
