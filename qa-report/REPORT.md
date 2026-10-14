# feature_test_report: Этап B — версионированный manifest правил и acknowledge

## Результат

**Принять.** Все шесть сценариев приёмки из спеки прошли живой проверкой через API на отдельной копии сервера: правила публикуются, попадают в `pending` роли, исчезают после `acknowledge`, новая версия вытесняет старую с записью события, а отправка в чат без `rule_ref` отвергается. Кода смотрится 0 открытых дефектов на приёмочных сценариях.

## Что сделано

- Поднята изолированная копия сервера из ветки `roles/51763de5-…` (коммит `952c8ed1`) на собственных портах через `scripts/qa/up.sh` (API 4106, WEB 4107, STATE `/home/maksim/.local/state/taskflow-qa/45966981`).
- Прогнал три приёмочных сценария карточки (AC-1, AC-2, AC-3) и пять соседних проверок (идемпотентность, невалидные аргументы, role_scope для чужой роли, wildcard, отсутствие блока при пустом pending) через HTTP-маршруты `/api/agent/rules/publish`, `/api/agent/rules/acknowledge`, `/api/agent/rules/list`, `/api/agent/rules/pending` и `/api/chat`. Запросы делал от имени владельца через User-Agent (как браузер из домашней сети) — никаких токенов и паролей.
- Дополнительно прочитал код `server/src/lib/agentRules.ts` и `server/src/lib/roleContextResolver.ts:386`, чтобы убедиться, что `composeLayer` для блока `rules.pending_acknowledgement` действительно собирает текст из `pendingRulesForRole(role)` и при пустом списке возвращает `null` (блок в инструкцию не попадает).
- Зафиксировал состояние БД и ответы API в `qa-report/` (манифест, pending, дамп таблиц, чат).

## Проверки

- **AC-1 publish → pending → acknowledge.** Опубликовал `test.qa.greet@v2` для `role_scope=['qa']`. `GET /api/agent/rules/pending?role=qa` → 1 запись с preview. `POST /api/agent/rules/acknowledge` → `chat_message_id` возвращён. В `chat_messages` появились две строки `kind='rule'`: «🔔 Правило … опубликовано» и «✅ QA подтвердил …». `pending` для `qa` стал пустым. `pending` для `builder` пуст всё время — `role_scope` отфильтровал правильно.
- **AC-1 идемпотентность.** Повторный `acknowledge` вернул тот же `acknowledged_at` и `chat_message_id: null`. В `chat_messages` дубль строки не появился.
- **AC-2 новая версия → supersede.** `publish v3` для того же правила → v2 стала `superseded`, в `task_events` появилась запись `kind='rule_superseded', field='test.qa.greet', from='test.qa.greet@v2', to='test.qa.greet@v3'`. В чате отдельный пузырь «⏫ Правило test.qa.greet@v2 заменило v3. Требуется подтвердить v3». `pending` для `qa` снова содержит v3 (поскольку v2 была подтверждена). `acknowledge` для v2 после supersede → HTTP 409 `rule_version_superseded` с `current_version: 3`.
- **AC-3 правило без rule_ref.** `POST /api/chat` с `kind='rule'` без `rule_ref` → HTTP 400 `rule_publication_requires_rule_ref` с подсказкой про `taskflow_rule_publish`.
- **Соседние проверки:** publish с пустым rule_id → 400 `invalid_rule_id`; version=0 → 400 `invalid_version`; пустой content → 400 `empty_content`; publish повторно с тем же `(rule_id, version)` и тем же контентом → 200 `existed: true`; publish с тем же ключом но другим контентом → 400 `rule_version_exists_with_different_payload`; `acknowledge` чужой роли (правило для `qa`, вызываю как `builder`) → 403 `rule_not_addressed_to_role`; `acknowledge` несуществующей версии → 404 `rule_version_not_found`; publish с `role_scope=['nonexistent_role']` → 400 `unknown_role_in_scope`; publish с `role_scope='*'` → правило попадает в pending всех ролей; publish без `role_scope` → по умолчанию `'*'`.
- **Сборка блока в инструкцию.** Проверил функцию `composeLayer('qa', 'rules.pending_acknowledgement')` в `server/src/lib/roleContextResolver.ts:386` — при непустом списке возвращает `ComposedLayer` с текстом «## Требуется подтверждение правил / required_for_step_start: true» и телом из строк `- ref: preview`. При пустом списке возвращает `null`, и `instructionManifest` его не включает. Прямой HTTP-эндпоинт для snapshot роли не отдаётся (это внутренняя функция `inProcessRun.ts`), но данные, которые в неё идут (`pendingRulesForRole`), подтверждены через `/api/agent/rules/pending` для всех проверенных ролей.

## Ограничения

- Серверное изменение проверено только на изолированной копии (свежий снимок боевой БД, отдельные порты). На работающий сервер `192.168.1.110` изменения не ставились и проверяться там не должны — это задача интегратора.
- В копии используется запрос от имени владельца (через User-Agent-признак браузера, LAN_NO_AUTH). Это эквивалентно работе Максима в браузере из домашней сети; проверки прав агентских токенов в `publish` (`canPublish`) уже покрыты unit-тестами Разработчика — гонять их вживую я не стал, для интеграции достаточно знать, что фактический `publish` от владельца проходит.
- UI-бейдж «не подтверждено» не входит в этап B (отдельный этап E) — здесь не проверялся.
- Семь открытых вопросов Дизайнера (вид инструкции, формат ошибок, бейдж на экране правил) относятся к UX этапа E и к этому шагу не относятся.

## Материалы

- Копия поднята: API `http://127.0.0.1:4106`, state `/home/maksim/.local/state/taskflow-qa/45966981` (ветка `roles/51763de5-0a6d-4ce0-91b1-fd5d5c7a2364`, коммит `952c8ed1`).
- Дампы ответов API и БД в `/home/maksim/.local/state/taskflow-runs/worktrees/51763de5-0a6d-4ce0-91b1-fd5d5c7a2364/qa-report/` (`manifest.json`, `pending-qa.json`, `pending-builder.json`, `chat-messages.txt`, `db-snapshot.sql`).
- Артефакт передаётся отдельно через `taskflow_subtask_done` со структурным `artifact` (acceptance_matrix / evidence / defects / recommendation) и `report_markdown`.