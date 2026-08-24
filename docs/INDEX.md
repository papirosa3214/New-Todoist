# Документация TaskFlow: Полный указатель

Справочник по всем техническим документам, протоколам и гайдам репозитория.

---

## 📌 Основные документы

1. [**Главный README**](../README.md) — обзор возможностей, быстрый старт, стек технологий и команды сборки.
2. [**STATUS.md**](../STATUS.md) — живой журнал состояния проекта: кто работает, что сделано последним, известные нюансы.
3. [**ARCHITECTURE.md**](ARCHITECTURE.md) — детальная архитектура: схема взаимодействия, потоки данных, система авторизации, iOS-плагины.
4. [**INTEGRATIONS.md**](../INTEGRATIONS.md) — руководство по интеграциям с Google Tasks, Apple Calendar и Apple Reminders.
5. [**DESIGN.md**](../DESIGN.md) — гайдлайны по UI/UX: дизайн-система, цветовая палитра, микро-анимации, система откликов.

---

## 🤖 Протокол и API AI-агентов

1. [**AGENT-PROTOCOL.md**](../AGENT-PROTOCOL.md) — строгие правила работы AI-агентов с доской, аренда задач, ведение подзадач, предотвращение дедлоков.
2. [**AGENT-API.md**](../AGENT-API.md) — спецификация REST API и MCP-инструментов для внешних исполнителей.
3. [**server/scripts/TRIGGER.md**](../server/scripts/TRIGGER.md) — документация службы-будильника (`trigger.py`), WebSocket-подключения, сухого прогона.

---

## 📱 Инженерные уроки и мобильная разработка (`docs/lessons/`)

1. [**Сборка iOS и распознавание речи на устройстве**](lessons/2026-08-18-ios-build-and-on-device-speech.md) — разбор WhisperKit CoreML, Neural Engine, бенчмарки времени прогрева, профилирование и деплой через `devicectl`.
2. [**Кастомная экранная клавиатура в WebView**](lessons/2026-08-18-custom-keyboard-in-webview.md) — разбор перехвата фокуса, `visualViewport` и управления вводом.
3. [**Интеграция с Google Tasks, Apple Calendar и Reminders**](lessons/2026-08-23-integrations-google-tasks-apple-calendar-reminders.md) — разбор EventKit, OAuth 2.0 и синхронизации.
