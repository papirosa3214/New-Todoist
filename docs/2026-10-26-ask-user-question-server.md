# Уточнение роли у владельца из чата — серверная часть

**Дата:** 26.10.2026
**Ветка:** `roles/ask-user-question-20261026` (worktree `~/.local/state/taskflow-runs/worktrees/ask-user-question-20261026`)
**Живой сервер не трогался:** ни рестарта юнита, ни деплоя, ни записи в боевую
`taskflow.db`, ни `git checkout` в `~/Проекты/New-Todoist`. Веб-клиент не
трогался вообще.

## Что сделано

### A. Таблица `chat_questions`

Версионированная миграция `180_chat_questions` в `server/src/migrations.ts`
(добавлена в конец массива; номер взят на момент коммита — последний
существующий id был `179_chat_budget_cases`).

| Колонка | Тип | Смысл |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | id вопроса |
| `chat_id` | TEXT NOT NULL | чат, где задан вопрос |
| `role_id` | TEXT NOT NULL | учётка задавшей роли (`u-secretary`) |
| `message_id` | TEXT | сообщение роли в чате, где вопрос виден |
| `payload_json` | TEXT NOT NULL | сами вопросы и варианты |
| `status` | TEXT NOT NULL DEFAULT 'open' | `open` / `answered` / `expired` / `cancelled` |
| `answer_json` | TEXT | ответ владельца |
| `created_at` | TEXT NOT NULL DEFAULT (datetime('now')) | когда задан |
| `deadline_at` | TEXT | зарезервировано под срок ответа |
| `answered_at` | TEXT | когда отвечен |

Индекс `idx_chat_questions_chat_created` на `(chat_id, created_at DESC)`.

### B. Инструмент роли `taskflow_ask_user_question`

* `server/src/runtime/chatTools.ts` — сам инструмент (только когда у роли есть
  контекст чата: `chatId` + `messageId`).
* `server/src/lib/roleToolScope.ts` — карта ONLY:
  `taskflow_ask_user_question: ["secretary"]`. Другие роли инструмента не видят
  ни в наборе чата, ни в каталоге сессии.
* `server/src/runtime/roleToolCatalog.ts` — инструмент добавлен в
  `CORE_OPERATIONS`, чтобы модель видела его без подключения по требованию.
* `server/src/runtime/universalTaskflow.ts` — инструмент в `CHAT_CONTEXT`:
  без исходного сообщения в чате он недоступен.

Параметры:

```json
{
  "questions": [
    {
      "question": "текст вопроса",
      "header": "короткая метка, до 16 символов",
      "options": [{ "label": "метка, до 60 символов", "description": "что значит выбор" }],
      "multiSelect": true
    }
  ],
  "note": "пояснение владельцу"
}
```

Валидация (`server/src/lib/chatQuestions.ts`, порядок как у
`@juicesharp/rpiv-ask-user-question`), коды ошибок уходят модели в тексте
ошибки инструмента:

| Код | Когда |
| --- | --- |
| `no_questions` | вопросов нет (или поле пустое) |
| `too_many_questions` | больше четырёх вопросов |
| `empty_options` | у вопроса меньше двух вариантов |
| `too_many_options` | у вопроса больше четырёх вариантов |
| `empty_question` | пустой текст вопроса |
| `empty_option` | пустая метка варианта |
| `header_too_long` | `header` длиннее 16 символов |
| `label_too_long` | `label` длиннее 60 символов |
| `reserved_label` | метка `Other`, `Type something.` или `Next` |
| `duplicate_question` | два одинаковых вопроса |
| `duplicate_option_label` | две одинаковые метки вариантов внутри вопроса |

Действие инструмента: пишет строку в `chat_questions`, кладёт в чат сообщение
роли с текстом вопроса (`reply_to_message_id` — на сообщение, к которому
вопрос относится), отдаёт роль «вопрос задан — заверши ход» и id вопроса.

**Ход роли не блокируется в ожидании ответа.** Инструмент пишет вопрос в БД и
завершает ход; ответ приходит отдельным POST и поднимает новый ход роли.
(Потолок хода 30 минут, `CHAT_RUN_CEILING_MS` в
`server/src/runtime/PiRuntimeAdapter.ts`; рестарт сервера теряет состояние
хода, поэтому ждать ответа внутри хода нельзя.)

### C. Ответ владельца

`POST /api/chats/:id/questions/:questionId/answer`, тело:

```json
{ "answers": [{ "questionIndex": 0, "selected": ["Только iOS"], "custom": "свой текст" }], "note": "пояснение" }
```

Проверки: чат существует и пользователь — участник; отвечает **владелец**
(`users.role = 'owner'`; учётка Помощника `u-secretary` в `access.ts`
считается владельцем для прав, но вопрос задаёт она же, поэтому ответ за неё
не принимается — 403); вопрос из этого чата (иначе 404); вопрос ещё `open`
(иначе 400 «Вопрос уже отвечен»); ответ непустой, `questionIndex` в пределах
вопросов, метки — из предложенных вариантов.

Дальше: `status='answered'`, `answer_json`, `answered_at`; в чат кладётся
обычное сообщение владельца (`reply_to_message_id` — сообщение роли с
вопросом); вызывается **существующая** `dispatchRoleReplies` — новая сессия Pi
та же, роль продолжает работу с места остановки. Ответ клиенту —
`{message: <сообщение в формате formatChatMessage>}` (так ждёт iOS-клиент,
`RoleChatMessageEnvelope`).

### D. Поле `question` в ленте

`server/src/lib/chatMessages.ts`: у каждого сообщения появилось поле `question`
— `null`, если вопроса нет. Иначе:

```json
{
  "id": "…",
  "status": "open",
  "questions": [
    { "question": "…", "header": "…", "options": [{ "label": "…", "description": "…" }], "multiSelect": true }
  ],
  "answer": null,
  "created_at": "2026-10-26 19:29:10"
}
```

**Имена полей — как читает iOS-клиент** (`Sources/Core/Models/ChatQuestion.swift`
на маке, прочитан 26.10.2026):

* дата — **`created_at`** (клиент декодирует только этот ключ; `createdAt` в
  коде клиента — это имя Swift-свойства с ключом `created_at`);
* флаг множественного выбора — `multiSelect` (клиент берёт `multi_select`, а
  при его отсутствии — `multiSelect`, то есть оба понимаются; сервер шлёт
  `multiSelect`);
* `answer` — массив записей `{questionIndex, selected, custom}` (null, пока
  не отвечено).

### E. Тесты

`server/test/askUserQuestion.test.ts` (11 тестов):

* валидация вопроса — все коды ошибок;
* права: инструмент есть только у `secretary`; у `builder`/`architect` его нет
  ни в наборе чата (`taskflowTools`), ни в каталоге сессии
  (`buildRoleToolCatalog`: `registeredNames`/`activeNames`);
* сквозной сценарий: инструмент → строка в БД → сообщение в чате → поле
  `question` в ленте → ответ владельца одним POST → `open → answered` →
  повторный ответ 400 → вопрос не из этого чата 404 → ответ не от владельца
  403 → пустой ответ 400.

RED → GREEN:

* RED (до правок кода): `FAIL test/askUserQuestion.test.ts — Error: Cannot
  find module '../src/lib/chatQuestions.js'`, 0 тестов пройдено;
* GREEN (после): `Test Files 1 passed (1) / Tests 11 passed (11)`.

Целевые прогоны (Node 22.23.1):

```
npx vitest run test/askUserQuestion.test.ts test/roleToolScope.test.ts \
  test/roleToolCatalog.test.ts test/nativeToolLoading.test.ts \
  test/chatMidFlightQuickReplies.test.ts test/chatDeliveryState.test.ts
→ Test Files 6 passed (6), Tests 38 passed (38)

npx tsc --noEmit -p tsconfig.json → без ошибок
```

Регрессия по затронутым файлам (`chats-online`, `inProcessRun`,
`chatOwnerFanout`, `chatOwnerBoundary`, `chatCoordination`): 26 падающих тестов
до правок и 26 после — состав тот же (это базовая линия окружения: Pi-сессии
в тестах). Новых падений нет.

## Что НЕ сделано и почему

* **Живой сервер не перезапускался, деплой не делался.** Правки лежат в
  ветке `roles/ask-user-question-20261026`; выкладка — осознанный шаг
  владельца (и только при пустой очереди).
* **Сторож на протухание вопросов не ставил.** Статус `expired` и колонка
  `deadline_at` в схеме есть, но протухание не обрабатывается: если владелец
  не ответил, вопрос так и лежит `open`, и роль не получает продолжения.
  Сторожа на это тоже нет (в реестре `docs/watchers.md` запись не добавлял:
  сторож без работающей проверки был бы записью в пустоту). Это отдельная
  задача — по правилу «прибор — сторож» её надо будет завести вместе с
  протуханием.
* **Инструмент доступен только в чате.** В карточке (ход по задаче) у роли
  нет `chatId`, поэтому инструмент отсекается правилом `CHAT_CONTEXT` — это
  по контракту («уточнение у владельца **из чата**»).
* **Веб-клиент не трогал** — по прямому запрету владельца от 24.10.2026.
* **Строку в `AGENT-WORK-SCOPES.md` внёс в конце работы**, а не до первой
  правки — порядок нарушен, содержимое соответствует факту.

## Ограничения

* Симулятор iOS и живой сервер не трогался: проверка только на изолированной
  тестовой БД (`server/test/setup.ts` → временная БД в `/tmp`).
* Полный `npm test` по серверу на чистом main даёт ~36 падающих тестов —
  это не регрессия, гонялись целевые файлы.
* `node_modules` в worktree — симлинки на живую копию (иначе vitest/tsc не
  запускаются); ничего в боевых зависимостях не менялось.
