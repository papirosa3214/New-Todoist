# Интеграция с Google Tasks, Apple Calendar и Apple Reminders

Отчет и технический разбор реализации (23.08.2026).

---

## 1. Архитектура и компоненты

### 🍏 Apple Calendar и Apple Reminders (Нативно на iOS)
- **Файл плагина:** `ios/App/App/EventKitPlugin.swift`
- **Мост Capacitor:** зарегистрирован в `LocalAIBridgeViewController` (`LocalAIPlugin.swift`).
- **Разрешения в Info.plist:**
  - `NSCalendarsUsageDescription`
  - `NSCalendarsFullAccessUsageDescription`
  - `NSRemindersUsageDescription`
  - `NSRemindersFullAccessUsageDescription`
- **Клиентский модуль:** `src/lib/appleIntegrations.ts`
- **Компонент отображения:** `src/components/AppleCalendarEvents.tsx`
  - Выводит события Apple Календаря в виде карточек на экранах **«Сегодня»** (`TodayScreen.tsx`) и **«Предстоящее»** (`UpcomingScreen.tsx`).

### 🔷 Google Задачи (Google Tasks API)
- **Миграция БД:** `009_integrations` в `server/src/migrations.ts`
  - Таблица `user_integrations`: хранение токенов OAuth (access_token, refresh_token, token_expires_at, settings).
  - Таблица `task_external_mappings`: связка `task_id` в TaskFlow с `external_id` в Google Tasks / Apple Reminders.
- **Серверный роут:** `server/src/routes/integrations.ts`
  - `GET /api/integrations/status` — проверка подключения и параметров.
  - `GET /api/integrations/google/auth-url` — формирование ссылки на OAuth 2.0.
  - `POST /api/integrations/google/callback` — обработка auth code и получение refresh_token.
  - `GET /api/integrations/google/lists` — списки задач Google.
  - `POST /api/integrations/google/sync` — двусторонняя синхронизация задач и статусов выполнения.
  - `POST /api/integrations/google/disconnect` — отключение интеграции.
- **React Query хуки:** `src/api/integrations.ts`

---

## 2. Интерфейс

- **Экран «Интеграции»:** `src/screens/IntegrationsScreen.tsx` (доступен в *Настройки -> Интеграции (Google, Apple)*).
  - Управление доступом к Apple Календарю и выбор отображаемых календарей.
  - Управление доступом к Apple Напоминаниям, выбор целевого списка и ручная синхронизация.
  - Авторизация через Google, выбор списка задач Google Tasks и кнопка мгновенной синхронизации.
- **Маршрут:** `/settings/integrations` в `src/App.tsx`.

---

## 3. Настройка Google OAuth 2.0

В `server/.env`:
```env
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://192.168.1.110:5180/settings/integrations
```
Требуемые Scopes в Google Cloud Console:
- `https://www.googleapis.com/auth/tasks`
- `https://www.googleapis.com/auth/userinfo.email`

---

## 4. Сборка и развертывание

```bash
VITE_API_URL=http://192.168.1.110:3001 npx vite build && npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination "platform=iOS,id=00008150-001545400144401C" \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device 00008150-001545400144401C \
  ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Release-iphoneos/App.app
```
