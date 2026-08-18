# Avatar URL — Отчет о состоянии работ (DeepSeek иконка)

## ✅ ГОТОВО

### База данных (`server/taskflow.db`)
1. Добавлена колонка `avatar_url TEXT DEFAULT NULL` в таблицу users
2. Установлено значение для DeepSeek-Agent: `/images/deepseek-logo.svg`
3. Проверено запросом — подтвеждено ✅

### Файл иконки скопирован и проверен
4. Файл из дропбокса AI/dropbox.ai
5. Сопирана в `public/images/deepseek-logo.png` IDENTICAL) ✅

## Backend SQL запросы обновлены:

6. **GET /api/agents** (`projects.ts`) — добавлено `avatar_url` в SELECT
78. **GET /me & login auth routes** (`auth.ts`) — добавлено `avatar_url` в SELECT
   - **POST /register** INSERT при регистрации — добавлена колонка `avatar_url`, 9-й placeholder = null

### Task list/detail assignee JOIN (`tasks.ts`) — добавлено как assignee_avatar_url
* Search results assigee JOIN — tasks,comments & events JOINS — добавлено как user_avatar_url/actor_avatar_url
* Subtask & comments JOINS (`subtasks.ts`) — добавлено как assignee/user_avatar_url
* Actor JOIN в нотификациях (`notifications.ts`) — добавлено как actor_avatar_url

## ЧАСТИЧНО СДЕЛАНО / НЕ ДОДЕЛАНО

### Frontend — НЕ ОБНОВЛЕНЫ callers (называют Avatar без avatar_url):
10. `AgentsScreen.tsx` line 49: `<Avatar initials={u.initials} color={u.avatar_color}` — нужен `<...avatar_url={u.avatar_url}'`
11. `TaskFormScreen.tsx` lines 776+833 — callers не передают avatar_url
12. `NotificationScreen.tsx` line 48 — caller не передает avatar_url'
13. `ActivityScreen.tsx` line 429 — caller не передает avatar_url'
14. `OverviewScreen.tsx` line 120 — caller не передает avatar_url'
15. `TaskRow.tsx` line 417 — task.assignee_avatar_url не определён в типах (ApiTask)

## ЧЕГО НЕ ХВАТИЛО

- **Не передал все callers**: `AgentsScreen` показывает список агентов БЕЗ иконки — хотя API теперь возвращает avatar_url' в типе ApiUser, компонент Avatar обновлён чтобы принимать его и рендерить `<img>
- **API Task types (`src/api/types.ts`) не расширен** поле assignee_avatar_url' поэтому задач без аватара
- **Server NOT RESTARTED**: Backend запущен через `tsx watch` — возможно подхватит изменения, но может потребоваться перезапуск
- **Frontend REBUILD: Changes в .tsx файлов требуют пересборки — Vite dev server должен HMR'ить, но Avatar component changes могут потребовать refresh

## ИТОГО

**Что работает:** DB готова, иконка на месте, backend API возвращает avatar_url', компонент Avatar умеет показывать `<img> когда передан avatar_url'.

**Что сломано/не сработает:** Экраны вызывают Avatar без передачи `avatar_url' — значит пока видят fallback (цветной круг + initials или эмодзи 🐋).
