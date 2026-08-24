<div align="center">

# ⚡️ TaskFlow (New-Todoist)

**Личный таск-трекер нового поколения с протоколом работы автономных AI-агентов, нативным распознаванием речи на устройстве и интеграцией с экосистемами Apple и Google.**

[![React](https://img.shields.io/badge/React-19.2-61dafb?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Capacitor](https://img.shields.io/badge/Capacitor-8.5-119EFF?logo=capacitor)](https://capacitorjs.com/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify)](https://fastify.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite)](https://sqlite.org/)
[![iOS](https://img.shields.io/badge/iOS-16.0%2B-black?logo=apple)](https://developer.apple.com/ios/)

[Возможности](#-основные-возможности) • [Архитектура](#-архитектура) • [Быстрый старт](#-быстрый-старт) • [iOS и Сборка](#-сборка-и-запуск-на-ios) • [AI Агенты](#-протокол-ai-агентов) • [Интеграции](#-интеграции) • [Документация](#-карта-документации)

</div>

---

## ✨ Основные возможности

### 🎯 Управление задачами и планирование
- **Интуитивный интерфейс:** Премиальная тёмная тема, адаптивная сетка, веерное меню быстрых действий (Fan Menu), жестовое управление (свайпы, перетаскивание dnd-kit).
- **Различные представления:**
  - **«Сегодня» / «Предстоящее»:** Дневная лента, почасовая сетка с поддержкой drag-and-drop распределения по времени (DayHours) и интерактивный свайп-календарь (Week/Month view).
  - **Канбан-доска:** Наглядное отображение статусов задач и подзадач.
  - **Входящие (Inbox), Проекты и Метки:** Иерархическая структура проектов и гибкая система тегов.
- **Подзадачи и чек-листы:** Пошаговое ведение с отображением текущего исполнителя и результата.

### 🎙 Нативное голосовое распознавание (On-Device ASR)
- **WhisperKit CoreML на iPhone:** Полностью локальное распознавание речи прямо на устройстве (Neural Engine) без отправки звука на внешние сервера.
- **Интеллектуальный парсер диктовки:** Автоматическое извлечение дат («завтра в 15:00», «через 3 дня»), приоритетов и проектов из надиктованной фразы.
- **Запасной серверный путь:** Автоматический fallback на Faster-Whisper и локальную LLM (Ollama) в домашней сети.

### 🤖 Протокол AI-агентов (Multi-Agent System)
- **Поддержка множества моделей:** Claude (Opus/Sonnet), Hermes, DeepSeek и другие.
- **Служба-будильник (Trigger Service):** Отслеживает появление задач в реальном времени через WebSockets и автоматически запускает назначенных агентов.
- **Аренда и Heartbeat:** Автоматическое продление аренды, контроль зависших процессов («Сторож тишины») и защита от конфликтов нескольких агентов.
- **Единый протокол сдачи:** Агенты закрывают подзадачи галочками с фиксацией результатов, а финальный приём (`review` ➔ `completed`) остаётся за владельцем.

### 🔄 Интеграции с внешними экосистемами
- **Apple Календарь:** Нативное отображение системных событий календаря прямо в лентах «Сегодня» и «Предстоящее» через `EventKit`.
- **Apple Напоминания:** Двусторонняя синхронизация задач и чек-листов со стандартным приложением «Напоминания» на iOS.
- **Google Задачи (Google Tasks):** Полноценная OAuth 2.0 интеграция со списками задач Google.

---

## 🏛 Архитектура

```mermaid
graph TD
    subgraph Client["Клиент (Web / iOS App)"]
        UI[React 19 + Tailwind CSS + Lucide]
        CapacitorBridge[Capacitor Native Bridge]
        LocalAI[WhisperKit CoreML / Speech Engine]
        EventKit[Apple Calendar & Reminders Plugin]
        CoreHaptics[TFHaptics Custom Plugin]
    end

    subgraph Server["Серверная часть (:3001)"]
        FastifyServer[Fastify REST API & WebSockets]
        SQLite[(SQLite + Better-SQLite3)]
        AuthEngine[JWT Auth + LAN Passwordless + API Tokens]
        SyncEngine[Google Tasks & External Integrations]
    end

    subgraph AIOrchestration["AI-инфраструктура"]
        TriggerService[Trigger Service / WebSocket Listener]
        AgentClaude[Claude Bot]
        AgentHermes[Hermes]
        AgentDeepSeek[DeepSeek Agent]
    end

    UI <-->|REST / WS| FastifyServer
    CapacitorBridge <--> LocalAI
    CapacitorBridge <--> EventKit
    CapacitorBridge <--> CoreHaptics
    FastifyServer <--> SQLite
    TriggerService <-->|WS stream| FastifyServer
    TriggerService --> AgentClaude
    TriggerService --> AgentHermes
    TriggerService --> AgentDeepSeek
    SyncEngine <-->|Google REST API| GoogleCloud[Google Cloud Services]
```

---

## 📁 Структура проекта

```
TaskFlow/
├── src/                        # Исходный код фронтенда (React 19 + Vite)
│   ├── api/                    # Клиенты REST API и React Query хуки
│   ├── components/             # Компоненты UI (DayHours, TaskBoard, FanMenu, Calendar)
│   ├── lib/                    # Утилиты (appleIntegrations, localAI, dictationParser)
│   ├── screens/                # Экраны (Today, Upcoming, TaskDetail, Integrations, etc.)
│   └── store/                  # Глобальное состояние (Zustand)
├── server/                     # Бэкенд (Node.js + Fastify + SQLite)
│   ├── src/                    # API маршруты, миграции схемы, авторизация, WS
│   │   ├── routes/             # tasks, subtasks, agent-state, integrations, auth
│   │   ├── migrations.ts       # Версионные миграции базы данных
│   │   └── access.ts           # Разграничение прав (владелец vs агенты)
│   ├── scripts/                # Служба trigger.py, mcp_server.py, vault-run
│   └── test/                   # Vitest тесты бэкенда и прав доступа
├── ios/                        # Нативный проект iOS (Capacitor + Xcode)
│   └── App/
│       ├── App/                # Swift плагины (EventKitPlugin, LocalAIPlugin, TFHaptics)
│       └── App.xcodeproj       # Проект Xcode с подключенным WhisperKit SPM
├── docs/                       # Документация и технические уроки
│   ├── lessons/                # Инженерные разборы и бенчмарки
│   └── ...
├── AGENT-PROTOCOL.md           # Правила и протокол работы AI-агентов
├── AGENT-API.md                # Спецификация API для внешних агентов
├── DESIGN.md                   # Гайдлайны дизайна и системы откликов
├── INTEGRATIONS.md             # Инструкция по Google и Apple интеграциям
└── STATUS.md                   # Актуальное состояние разработки проекта
```

---

## 🚀 Быстрый старт

### Требования
- **Node.js:** `>= 20.x`
- **npm:** `>= 10.x`
- **Xcode:** `>= 16.0` (для сборки под iOS)

### 1. Установка зависимостей
```bash
# Установка зависимостей фронтенда
npm install

# Установка зависимостей сервера
npm --prefix server install
```

### 2. Запуск локального сервера разработки
```bash
# Запуск бэкенда (порт 3001)
npm --prefix server run dev

# В отдельном терминале: запуск фронтенда (порт 5180)
npm run dev
```

Откройте в браузере: `http://localhost:5180` (или `http://192.168.1.110:5180`).

---

## 📱 Сборка и запуск на iOS

Подробный разбор сборки: [`docs/lessons/2026-08-18-ios-build-and-on-device-speech.md`](docs/lessons/2026-08-18-ios-build-and-on-device-speech.md).

### Сборка и деплой на физическое устройство за одну команду:

```bash
# 1. Сборка веб-бандла с явным указанием адреса сервера
VITE_API_URL=http://192.168.1.110:3001 npx vite build && npx cap sync ios

# 2. Сборка Release-версии в Xcode
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination "platform=iOS,id=00008150-001545400144401C" \
  -allowProvisioningUpdates build

# 3. Установка на iPhone
xcrun devicectl device install app --device 00008150-001545400144401C \
  ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Release-iphoneos/App.app

# 4. Запуск приложения на разблокированном телефоне
xcrun devicectl device process launch --device 00008150-001545400144401C \
  --terminate-existing com.maksim.taskflow
```

---

## 🤖 Протокол AI-агентов

Агенты взаимодействуют с TaskFlow по строгому протоколу:
1. **Взятие задачи:** `POST /api/tasks/:id/claim` — задача блокируется за агентом на 15 минут.
2. **Шаг в работе:** `POST /api/subtasks/:id/work` (`state="in_progress"`).
3. **Завершение шага:** Закрытие галочкой с обязательным текстовым итогом `result` (1–2 предложения).
4. **Сдача задачи:** Перевод в `state="review"` — окончательно задачу закрывает только владелец.
5. **Сторож тишины (Deadlock Prevention):** При отсутствии активности > 20 минут выдаётся предупреждение; через 45 минут задача автоматически возвращается в `blocked`.

Полная спецификация: [`AGENT-PROTOCOL.md`](AGENT-PROTOCOL.md) и [`AGENT-API.md`](AGENT-API.md).

---

## 🔗 Интеграции

- **Google Tasks:** Подключение через OAuth 2.0, синхронизация списков и статусов.
- **Apple Calendar & Reminders:** Нативный плагин [`EventKitPlugin.swift`](ios/App/App/EventKitPlugin.swift), использующий системный фреймворк iOS `EventKit`.
- Подробное руководство: [`INTEGRATIONS.md`](INTEGRATIONS.md).

---

## 📚 Карта документации

| Документ | Описание |
| :--- | :--- |
| [`STATUS.md`](STATUS.md) | **Живой статус проекта:** текущие задачи, кто работает, последние изменения. |
| [`docs/TASK-LIFECYCLE-SCENARIOS.md`](docs/TASK-LIFECYCLE-SCENARIOS.md) | **Матрица сценариев и состояний задач:** человек, агент, блокеры, приёмка, доработка. |
| [`docs/AGENTS-SETUP-GUIDE.md`](docs/AGENTS-SETUP-GUIDE.md) | **Подключение агентов от А до Я:** создание, ключи, MCP, автономный будильник. |
| [`AGENT-PROTOCOL.md`](AGENT-PROTOCOL.md) | **Правила агентов:** жизненный цикл задач, шаги, аренда, сдача работы. |
| [`AGENT-API.md`](AGENT-API.md) | **API для агентов:** спецификация REST-эндпоинтов, токены, MCP. |
| [`INTEGRATIONS.md`](INTEGRATIONS.md) | **Интеграции:** настройка Google Tasks, Apple Calendar и Reminders. |
| [`DESIGN.md`](DESIGN.md) | **Дизайн-система:** палитра, анимации, правила вёрстки, тактильный отклик (Haptics). |
| [`server/scripts/TRIGGER.md`](server/scripts/TRIGGER.md) | **Служба будильника:** WebSocket-слушатель задач и запуск агентов. |
| [`docs/lessons/`](docs/lessons/) | **Инженерные уроки:** разборы нативного звука Whisper, кастомных клавиатур и др. |

---

## 🧪 Тестирование

```bash
# Тесты фронтенда (парсинг диктовки, компоненты)
npm test

# Тесты сервера (права доступа, агенты, интеграции, e2e)
npm --prefix server test

# Проверка UI и контролов интерфейса
npm run check
```

---

<div align="center">
Разработано с заботой о скорости, приватности и автономности.
</div>
