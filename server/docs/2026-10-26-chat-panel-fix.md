# Доработка панели чата по замечаниям проверки (карточка e11eae7a)

Дата: 26.10.2026. Ветка роли: `roles/e11eae7a-2198-41af-9244-de7a82164882`.
Основа: коммиты `c56645e6`, `1332237c` (реализация контракта панели) поверх `main e1b54a73`.

## Что исправлено

### D1 (P1) — после «Новая сессия» панель показывала окно прошлой сессии

`POST /api/chats/:id/new-session` удалял сессию роли в базе, но замер контекста в памяти
оставался: `resetChatContext` была мёртвым кодом — вызовов не было нигде.

- `server/src/runtime/chatContextUsage.ts`: `resetChatContext` теперь вызывается в
  маршруте новой сессии; добавлена `markChatContextCompacted` — после сжатия прежнее
  занятое окно помечается `after_compaction` с пустыми токенами.
- `server/src/routes/chats.ts`: вызов `resetChatContext(chatId, roleId)` в
  `POST /api/chats/:id/new-session`; `markChatContextCompacted` — в
  `POST /api/chats/:id/compact`.

### D2 (P1) — реальный slash-навык отклонялся как «не найден» до первого хода роли

`listRoleSkills` брал текст навыка только через `composeLayer(role, key)`, а блоки
навыков регистрирует `discoverChatResources` — до первого хода роли слой был `null`,
и падение `TypeError` проглатывалось `.catch(() => [])`.

- `server/src/runtime/instructionResources.ts`: если слой не зарегистрирован, текст
  навыка читается с диска (`composeLayer(...)?.effective ?? fs.readFileSync(...)`).
- `server/src/runtime/chatCommands.ts`: ошибка загрузки навыков больше не глотается
  молча — она пишется в журнал (`console.warn`).

### D3 (P2) — список команд не учитывал режим чата

`GET /api/chats/:id/controls` всегда считал режим «Работа».

- `server/src/routes/chats.ts`: добавлена `chatWorkMode(chatId)` — режим берётся у
  последнего сообщения человека в чате (`work_mode` в `chat_messages`, `work` по
  умолчанию). Список команд фильтруется по режиму: в «Планировании» `bash`, `write`,
  `edit` не предлагаются. Права при исполнении не менялись.

### D4 (P2) — «документ с выводами» исследования не был обеспечен

- `server/src/runtime/chatWorkMode.ts`: инструкция режима «Глубокое исследование» теперь
  требует сохранить итог документом (`taskflow_doc_write`) и дать ссылку `note://…`.
- `server/src/runtime/chatResearchDocument.ts` (новый): `researchDocumentSince`,
  `saveResearchDocument`, `ensureResearchDocument` — поиск документа, записанного ролью
  за ход, и сохранение ответа роли как документа, если роль не сохранила его сама.
- `server/src/routes/chats.ts`: после хода в режиме `deep_research` сервер проверяет
  наличие документа; если роль ничего не сохранила, ответ сохраняется как документ, и
  в чат кладётся карточка со ссылкой на него.

## Примеры API

Замер прежней сессии и сброс:

```
GET  /api/chats/<chatId>/controls?role_id=u-secretary
→ {"context":{"roleID":"u-secretary","sessionID":"sess-old","tokens":5000,"status":"measured",...},
   "commands":[{"id":"chat-report-format","kind":"skill","invocation":"/skill:chat-report-format "}, ...]}

POST /api/chats/<chatId>/new-session      {"role_id":"u-secretary"}
→ 200 {"message":{...}}

GET  /api/chats/<chatId>/controls?role_id=u-secretary
→ {"context":{"roleID":"u-secretary","sessionID":null,"tokens":null,"status":"no_session",...}, ...}
```

Реальный вызов навыка (до первого хода роли):

```
POST /api/chats/<chatId>/messages   {"text":"/skill:chat-report-format сделай отчёт"}
→ 200 (раньше: 400 «Навык chat-report-format у роли secretary не найден»)
```

Режим «Планирование» и состав команд:

```
POST /api/chats/<chatId>/messages   {"text":"Спланируй работу","work_mode":"plan"}
GET  /api/chats/<chatId>/controls?role_id=u-secretary
→ commands: нет "bash", "write", "edit" (в режиме «Работа» они есть)
```

## Проверки

- Новый набор `server/test/chatPanelRework.test.ts`: RED на старом коде — 4 из 4 падают;
  GREEN после правок — 4 из 4.
- Смежные наборы (панель, режимы, чаты, доставка, материалы, работа по чату):
  89/89 и 125 прогонов, из них 2 падения (`chatWork.test.ts`, `privateRoleChat.test.ts`) —
  те же самые падения на исходном коде, вне этой работы.
- Проверка типов сервера: `tsc --noEmit` — чисто.

## Ограничения

- Живой сервер не перезапускался и не выкладывался: это этап интеграции.
- Проверка окна контекста сделана на подставной сессии с тем же интерфейсом
  `getContextUsage`, а не на настоящем ходе Pi с моделью.
