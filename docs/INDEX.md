# Документация TaskFlow: Полный указатель

Справочник по всем техническим документам, протоколам и гайдам репозитория.

---

## 📌 Основные документы

1. [**Главный README**](../README.md) — обзор возможностей, быстрый старт, стек технологий и команды сборки.
2. [**STATUS.md**](../STATUS.md) — живой журнал состояния проекта: кто работает, что сделано последним, известные нюансы.
3. [**BRANCHING.md**](BRANCHING.md) — **карта веток и рабочих копий:** iOS-разработка в `native-app`, проверка контекста и безопасная публикация.
4. [**TASK-LIFECYCLE-SCENARIOS.md**](TASK-LIFECYCLE-SCENARIOS.md) — **матрица всех сценариев, состояний и кнопок задач** (человек, агент, блокеры, приёмка, доработка).
5. [**ARCHITECTURE.md**](ARCHITECTURE.md) — детальная архитектура: схема взаимодействия, потоки данных, система авторизации, iOS-плагины.
6. [**INTEGRATIONS.md**](../INTEGRATIONS.md) — руководство по интеграциям с Google Tasks, Apple Calendar и Apple Reminders.
7. [**DESIGN.md**](../DESIGN.md) — гайдлайны по UI/UX: дизайн-система, цветовая палитра, микро-анимации, система откликов.

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
