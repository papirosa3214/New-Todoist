# Avatar URL — статус работ (DeepSeek иконка)

## ✅ СДЕЛАНО

### 1. База данных (`server/taskflow.db`)
- `ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT NULL` — колонка добавлена
- Установлено для DeepSeek-Agent: `/images/deepseek-logo.svg'`
  - Проверено: `SELECT id, name, avatar_url FROM users WHERE name LIKE '%DeepSeek%'` → `b85212d6-abab-4afb-a4c6-0d379b6537a4|DeepSeek-Agent|/images/deepseek-logo.svg` ✅

### 2. SVG иконка скопирована
- `/mnt/document/DropBox AI/deepseek-color.svg` → `public/images/deepseek-logo.svg`
  - Проверено diff: **IDENTICAL** ✅

### 3. Backend — API endpoints где уже есть avatar_url в SELECT/INSERT:

| Файл | Строки | Что сделал |
|---|---|---|
| `server/src/routes/auth.ts` | **101** INSERT при регистрации: +avatar_url в колонки, 9-й placeholder = null (было 8 → 9) |
|  | **188,270** GET /api/agents, POST /api/agents insert | SELECT +avatar_url |
| `server/src/routes/projects.ts` | **100,136** Task list & detail assignee JOIN | +u.avatar_url as assignee_avatar_url |
| `server/src/routes/search.ts` | 57** Search results assignee JOIN | +u.avatar_url as assignee_avatar_url |
| `server/src/routes/subtasks.ts` | **15,32,318,388** Subtask & comments JOINS | +u.avatar_url как assignee_avatar_url и user_avatar_url |
| `server/src/routes/notifications.ts` | **14** Actor JOIN в нотификациях | +a.avatar_url as actor_avatar_url |

### 5. Frontend — типы & компонент Avatar

| Файл | Что сделал |
|---|---|
| `src/api/types.ts` (ApiUser) | ✅ добавлено `avatar_url?: string \| null;` |
| `src/components/UI.tsx` Avatar() | ✅ переписан: принимает опциональный `{ avatar_url?, initials?, color? }`. Если есть `avatar_
