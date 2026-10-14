# Исследование каналов сообщений для мультиагентских систем — Часть 1: источники и сравнение

**Дата изучения:** 2026-10-10
**Карточка:** 01290389-5450-414b-bb12-9cbe802ccc01 (Исследовать и пересмотреть коммуникацию между агентами)
**Шаг плана:** work_1, исполнитель Исследователь
**Полный артефакт в базе знаний:** doc id `919c1483-adb9-43c7-a077-931a9bebbd50` (TaskFlow - NewTodoist)

## Вердикт о названии «Mission Control от Factory»

**Название точное.** В официальной документации Factory AI (docs.factory.ai/missions/overview) компонент называется **Mission Control** и описывается как «orchestration view» внутри функции Missions.

Цитата из первоисточника (docs.factory.ai/missions/overview, раздел «How it works», шаг 5):

> «Enter Mission Control: Once the plan is approved, Droid enters Mission Control, the Missions orchestration view that manages execution of the plan.»

Доступ через команду `/missions` (или `/mission`) в Droid CLI.

Синонимы в первоисточниках:
- Mission Control (основное)
- Missions orchestration view (формально)
- Mission (как сокращение режима)

**Отвергнутые альтернативы** (в официальной документации не используются): Mission Manager, Mission Center, Control Tower.

## Сравнительная таблица реализаций мультиагентских каналов

| Реализация | Архитектура канала | Маршрутизация | Доставка и пробуждение | Контекст-изоляция | Длительные задачи | Когда подходит |
| --- | --- | --- | --- | --- | --- | --- |
| **Factory Mission Control** | Hub (Orchestrator) | По плану/майлстоунам | Spawn fresh worker sessions, валидация на чекпоинтах | Изоляция сессий воркеров | Да, multi-day horizons | Автономные цели с явным планом и валидацией |
| **A2A Protocol (Linux Foundation)** | P2P (JSON-RPC 2.0 over HTTPS/gRPC) | Agent Card discovery | Sync, SSE streaming, async push notifications | Не регламентирована протоколом | Через task lifecycle | Межфреймворковый стандарт «агент↔агент» |
| **MCP (Linux Foundation)** | P2P (агент↔инструмент) | По именам инструментов | Request/Response | Изоляция по серверу | Нет | Доступ к внешним данным и действиям |
| **Claude Agent SDK** | Subagent spawn через `Agent` tool | Через parent → child | Lifecycle hooks (18 событий: PreToolUse, PostToolUse, SubagentStart/Stop, Stop, Notification, PreCompact) | Строгая: subagent имеет свой context window | Да, через `resume=session_id` | Изолированные подзадачи с переиспользованием сессий |
| **LangGraph** | Shared State Graph | Checkpointing на каждом узле | Pause/Resume, time-travel | Централизованное состояние | Да | Сложные compliance workflow |
| **CrewAI** | Event-driven flows | Ролевая модель «crew» | Standalone execution (с v1.14) | Абстракция мутнеет при >5 агентах | Нет, ~18% оверхед токенов | Быстрые Python-прототипы |
| **AutoGen (Microsoft)** | Turn-taking chat | Структурированные диалоги | Conversational turns | В рамках диалога | Нет | Устарело (maintenance с 10.2025) |
| **Microsoft Agent Framework 1.0** | Unified (.NET + Python) | MCP + A2A native | Native support | Зависит от реализации | Да | Enterprise-стеки Microsoft |
| **Google ADK** | Иерархическое дерево | Root → sub-agents → ... | A2A native, интеграция с Vertex AI | Иерархическая изоляция | Да | Глубокие иерархии задач в Google Cloud |
| **OpenAI Agents SDK** | Handoff model | Tool-centric | Lightweight handoffs | Изоляция через sandbox tools | Нет | Простые tool-based задачи |
| **MQTT Event-bus (HiveMQ подход)** | Pub/Sub Broker | По топикам (`task/{id}/role/{role}/slot/{slot}`) | Push events, wake-on-event | Изоляция по topic scope | Да (stateless agents) | Масштабирование без каскадных сбоев |

## Ключевые архитектурные паттерны

1. **Hub-and-spoke** — координатор в центре. Плюсы: легко ловить петли и контролировать поток. Минусы: +1 hop задержки. Пример: Factory Mission Control.
2. **Direct A2A (peer-to-peer)** — каждый агент знает endpoint каждого. Плюсы: минимальная задержка. Минусы: квадратичный рост связей, каскадные сбои. Пример: A2A в чистом виде (критика от HiveMQ).
3. **Pub/Sub message bus** — брокер, топики, подписчики. Плюсы: масштабируемость, независимость, сильная контекстная изоляция через scope. Минусы: нужна инфраструктура брокера.

## Что подходит TaskFlow (гипотеза для архитектора)

Агенты TaskFlow stateless, живут минуты, не держат постоянный сокет. Для работающих — `PostToolUse`-хук; для спящих — systemd-таймер/wake-on-event. Широковещательный канал без маршрутизации + отсутствие ACK = потери сообщений (уже задокументированный паттерн).

Применимо из изученного:
1. **Маршрутизация по `task_id`/`slot_id`** в топиках/очередях, как в MQTT pub/sub.
2. **ACK-механизм** по модели A2A task lifecycle (`submitted → working → completed/failed`).
3. **Agent Card** для описания роли и текущих возможностей.
4. **Subagent-стиль изоляции** (Claude Agent SDK): subslot знает только свою задачу, не видит историю родителя и других subslots.

Не применимо в лоб: LangGraph (требует long-running процесс с состоянием), CrewAI (Python-only runtime), AutoGen (legacy). MCP закрывает канал «агент↔инструмент», не «агент↔агент».

## Источники (все изучены 2026-10-10)

- https://docs.factory.ai/missions/overview — официальное описание Mission Control
- https://sidbharath.com/blog/factory-ai-guide — независимый разбор Factory (обновлено август 2026)
- https://www.youtube.com/watch?v=SwKIJSOSH0w — Ray Fernando, обзор Missions
- https://github.com/a2aproject/A2A — спецификация A2A v1.0
- https://finance.yahoo.com/news/linux-foundation-launches-agent2agent-protocol-150000932.html — пресс-релиз Linux Foundation (23.06.2025)
- https://code.claude.com/docs/en/agent-sdk/subagents — документация Claude Agent SDK
- https://medium.com/@shivanshmay2019/claude-agent-sdk-deep-dive-what-it-means-to-use-claude-code-as-a-library-773aea121787 — глубокий разбор SDK
- https://dev.to/saaro_net/multi-agent-orchestration-2026-langgraph-crewai-and-autogen-compared-34bd — LangGraph v1.0 GA
- https://blckalpaca.at/en/knowledge-base/ai-agents/ai-agent-frameworks-comparison — CrewAI v1.10.1
- https://alicelabs.ai/en/insights/best-ai-agent-frameworks-2026 — Microsoft Agent Framework 1.0
- https://gurusup.com/blog/best-multi-agent-frameworks-2026 — Google ADK
- https://galileo.ai/blog/autogen-vs-crewai-vs-langgraph-vs-openai-agents-framework — паттерны коммуникации
- https://ably.com/topic/pub-sub — базовое описание Pub/Sub
- https://arxiv.org/html/2312.14647v1 — академическая база по pub/sub для GenAI
- https://www.hivemq.com/blog/a2a-enterprise-scale-agentic-ai-collaboration-part-1 — критика P2A, MQTT event bus
- https://www.taskade.com/blog/inter-agent-communication-patterns — сравнение паттернов
- https://www.digitalapplied.com/blog/factory-ai-multi-agent-coding-platform-review — обзор Factory
- https://www.augmentcode.com/tools/factory-ai-vs-augment-cosmos — Factory vs Augment
- https://trustvector.guard0.ai/agents/factory-droids — TrustVector security review

## Ограничения

- Внутренний код Factory Mission Control и Claude Agent SDK закрыт; детали реализации worker-пробуждения не подтверждены кодом.
- Цифры (22 000+ звёзд A2A, 110M+ загрузок MCP, 18% оверхед CrewAI, 150+ организаций LF) — заявления первоисточников.
- Это исследование (work_1); полная диагностика текущего TaskFlow — следующий шаг архитектора (work_2).