# Multi-agent handoff — паттерны и применимость к TaskFlow — 04.10.2026

## Вопрос
Как организовать передачу работы между ролями (handoff) в нашей системе TaskFlow: 8 ролей, claim/work, дочерние задачи, без выделенного оркестратора. Владелец попросил посмотреть на решения лидеров рынка.

## Что нашёл по 4 фреймворкам
- **Microsoft AutoGen (v0.4+, actor model).** Handoff — pub-sub: `AIAgent` публикует `UserTask` в `topic_id` следующего агента; цепочка задаётся в коде. AutoGen ушёл в maintenance; Microsoft перевёл всё в Microsoft Agent Framework 1.0 (GA 3 апреля 2026, AutoGen + Semantic Kernel).
- **AG2 (community fork, v0.2 line).** Разговорные агенты + `GroupChat` с `speaker_selection_method`; handoff встроен, но не декларативный — LLM выбирает, кто говорит следующим.
- **CrewAI (role/task/crew).** Агент с `allow_delegation=True` получает инструменты `delegate_work`/`ask_question`, остальные агенты превращаются в инструменты. Менеджер-агент в `Process.hierarchical` решает, кого звать. Минус: маршрутизация решётся LLM, не правилами.
- **LangGraph (graph + `Command`).** Самый явный API: узел возвращает `Command(goto=…, update={…})` — динамический прыжок; `graph=Command.PARENT` для подъёма в родительский граф. Полезно для иерархии и для условных переходов по результату.
- **OpenAI Swarm (экспериментальный, преемник — Agents SDK).** Две примитивы: `Agent` + функция-handoff вида `transfer_to_xxx()`, возвращающая целевого агента. Stateless, без персистентного состояния. Идея «handoff = first-class tool call» пошла именно отсюда.

## Что подходит к нам
- **Не подходит как продукт:** ни один фреймворк нельзя втащить в TaskFlow 1-в-1 — все они завязаны на собственный runtime/LLM-цикл, а у нас уже есть свой claim/work + дочерние задачи + чат-координация.
- **Заимствуем идеи:** (1) **handoff как явный шаг с указанием адресата** (как `Command(goto=…)` или `transfer_to_xxx()`), а не «агент сам пишет в общий чат, кто-нибудь подхватит»; (2) **роль-маршрутизация через capability matrix**, а не через LLM-судью; (3) **правила для агентов в одном месте** (AGENTS.md / Skills), читаются перед действием.
- **Что уже почти есть:** дочерние задачи с явным заголовком/комментарием и связью через parent_id (по комментарию) — это и есть наш «handoff», только без формального API `assignee` на subtask.

## Рекомендация (минимум внедрения, в каком порядке)
1. **Capability matrix** в `/home/maksim/taskflow/roles/<role>/capabilities.md` — список «роль X может делать Y» (1 таблица, ~30 строк). Источник истины для маршрутизации.
2. **Правило handoff в AGENTS.md роли:** если задача вне компетенции — создать дочернюю задачу с `parent_id` и явным `assignee`/комментарием «для @role», не продолжать самому.
3. **Шаблон `AGENT-PROTOCOL.md` «Handoff»:** поля «от кого / кому / артефакт / что готово / что нужно» — для комментария при создании дочерней задачи.
4. **Позже, если понадобится:** ввести `subtask.assignee_id` (сейчас у subtask нет своего assignee) и формальный `parent_task_id` в API вместо связи через заголовок. Без этого хэндофф остаётся текстовым.

## Границы
- Владелец не давал зелёного света на «внедрять сейчас», задача — только обосновать. Перед реализацией — отдельная карточка.
- Не покрыто: протоколы A2A/MCP, Magentic-One, Microsoft Agent Framework 1.0 (упомянуты, но детально не разобраны).
- Доказательства: первоисточники — `microsoft.github.io/autogen/.../handoffs.html`, `langchain.com/blog/command-a-new-tool-for-multi-agent-architectures-in-langgraph`, `github.com/openai/swarm` README, `docs.crewai.com/v1.15.23/en/concepts/collaboration`.
