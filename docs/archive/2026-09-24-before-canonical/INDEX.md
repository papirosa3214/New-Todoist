# Документация TaskFlow: Полный указатель

Справочник по всем техническим документам, протоколам и гайдам репозитория.

---

## ⚠️ Что где лежит (09.09.2026)

Проект разложен по двум репозиториям, у каждого своё назначение:

| Что меняем | Репозиторий | Где внутри |
|---|---|---|
| Логика, база, права, API | `taskflow-server` (этот) | `server/` |
| Что видно в браузере | `taskflow-server` (этот) | `src/` |
| Что видно на айфоне | `taskflow-native-ios` | весь репозиторий |

**Этот репозиторий 09.09.2026 переименован** из `New-Todoist` в `taskflow-server`,
а рабочая ветка `native-app` стала `main` — под именем «нативное приложение» лежал
весь сервер и веб, и это сбивало с толку.

**Нативного iOS-клиента здесь нет.** Он живёт отдельным репозиторием
`maksim/taskflow-native-ios`, единственная рабочая копия — на маке в
`/Users/max/Проекты/TaskFlowNativeBuild`, собирается через `xcodegen` + `xcodebuild`.
Папка `ios/` (обёртка Capacitor от прежнего подхода, 947 МБ) удалена из репозитория
09.09.2026 — история сохранена в git.

Документы ниже с пометкой `NATIVE-IOS-*` описывают экраны **прежнего** веб-клиента
в обёртке Capacitor. К нативному SwiftUI-клиенту они относятся только как справка
по задуманному поведению экранов, не как описание его кода.

Актуальное состояние всего проекта — заметка «TaskFlow — единая картина на
09.09.2026» в документации проекта на доске.

---

## 📌 Основные документы

1. [**Главный README**](../README.md) — обзор возможностей, быстрый старт, стек технологий и команды сборки.
2. [**STATUS.md**](../STATUS.md) — живой журнал состояния проекта: кто работает, что сделано последним, известные нюансы.
3. [**BRANCHING.md**](BRANCHING.md) — **карта веток и рабочих копий** (описывает порядок до 09.09.2026, когда работа шла в ветке `native-app`; сейчас рабочая ветка — `main`).
4. [**NATIVE-IOS-TODAY-CHROME.md**](NATIVE-IOS-TODAY-CHROME.md) — **зафиксированная реализация экрана «Сегодня»:** слои липкой шапки, pull-down, схлопывание и системное стеклянное меню фильтров.
5. [**NATIVE-IOS-CHAT.md**](NATIVE-IOS-CHAT.md) — **контракт нативного чата:** отдельная нижняя панель ввода, размытая шапка и возврат в «Обзор».
6. [**NATIVE-IOS-PERFORMANCE.md**](NATIVE-IOS-PERFORMANCE.md) — **аудит плавности:** исправленные горячие пути и ограничения измерений Simulator.
7. [**TASK-LIFECYCLE-SCENARIOS.md**](TASK-LIFECYCLE-SCENARIOS.md) — **матрица всех сценариев, состояний и кнопок задач** (человек, агент, блокеры, приёмка, доработка).
8. [**ARCHITECTURE.md**](ARCHITECTURE.md) — детальная архитектура: схема взаимодействия, потоки данных, система авторизации, iOS-плагины.
9. [**INTEGRATIONS.md**](../INTEGRATIONS.md) — руководство по интеграциям с Google Tasks, Apple Calendar и Apple Reminders.
10. [**DESIGN.md**](../DESIGN.md) — гайдлайны по UI/UX: дизайн-система, цветовая палитра, микро-анимации, система откликов.

---

## Ревью планов и реализаций

1. [**Канонический план ролей внутри сервера от 23.09.2026**](2026-09-23-roles-in-server-plan.md) — утверждённая цель, этапы миграции и текущий handoff.
2. [**Каталог независимых технических ревью**](reviews/INDEX.md) — отчёты, проверенные ревизии и воспроизводимые доказательства находок.
3. [**Handoff hardening ролей и durable-оркестрации от 23.09.2026**](handoffs/2026-09-23-roles-hardening-and-orchestration-handoff.md) — что исправлено, что не делалось, результаты gates, риски и точный порядок продолжения.

---

## 🤖 Протокол и API AI-агентов

1. [**AI-ASSISTANT-ARCHITECTURE.md**](AI-ASSISTANT-ARCHITECTURE.md) — **архитектура AI-ассистента и Second Brain** (переключатель хабов Local/Claude/Hermes/Antigravity/DeepSeek, недельная сводка, умная структуризация).
2. [**AGENTS-SETUP-GUIDE.md**](AGENTS-SETUP-GUIDE.md) — **руководство по подключению и настройке AI-агентов от А до Я** (создание, токены, MCP для IDE, автономный будильник, аватарки).
3. [**AGENT-PROTOCOL.md**](../AGENT-PROTOCOL.md) — строгие правила работы AI-агентов с доской, аренда задач, ведение подзадач, предотвращение дедлоков.
4. [**AGENT-API.md**](../AGENT-API.md) — спецификация REST API и MCP-инструментов для внешних исполнителей.
5. [**AGENT-MODELS.md**](AGENT-MODELS.md) — **какая модель достаётся исполнителю при автономном заходе**: метки на карточке, что настроено у каждого агента, подменный `DSH_HOME` у DeepSeek Harness, проверка маршрута.
6. [**server/scripts/TRIGGER.md**](../server/scripts/TRIGGER.md) — документация службы-будильника (`trigger.py`), WebSocket-подключения, сухого прогона.

---

## 📱 Инженерные уроки и мобильная разработка (`docs/lessons/`)

1. [**Сборка iOS и распознавание речи на устройстве**](lessons/2026-08-18-ios-build-and-on-device-speech.md) — разбор WhisperKit CoreML, Neural Engine, бенчмарки времени прогрева, профилирование и деплой через `devicectl`.
2. [**Кастомная экранная клавиатура в WebView**](lessons/2026-08-18-custom-keyboard-in-webview.md) — разбор перехвата фокуса, `visualViewport` и управления вводом.
3. [**Интеграция с Google Tasks, Apple Calendar и Reminders**](lessons/2026-08-23-integrations-google-tasks-apple-calendar-reminders.md) — разбор EventKit, OAuth 2.0 и синхронизации.
4. [**Ультраплавный нативный iOS-свайп действий в WebView**](lessons/2026-08-24-lesson-1-native-ios-swipe-actions.md) — разбор Pointer Events, `setPointerCapture`, аппаратного ускорения `translate3d`, кривой Apple и отклика Haptics.
5. [**Dynamic Island и Live Activities в Capacitor iOS**](lessons/2026-08-24-lesson-2-dynamic-island-live-activities-capacitor.md) — разбор ActivityKit, SwiftUI виджета (Compact/Expanded), спиннера активного шага и моста Capacitor.
6. [**Виджет на экране блокировки и кнопка действия Action Button**](lessons/2026-08-24-lesson-3-lock-screen-widget-and-action-button.md) — разбор мгновенного запуска диктовки через Deep Links (`taskflow://dictate`), `AppIntents` и Shortcuts.
