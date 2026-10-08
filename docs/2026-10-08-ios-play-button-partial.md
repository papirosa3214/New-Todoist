# 2026-10-08 — iOS: кнопка Play на bash-командах в ответах ролей (частично)

Снимок состояния задачи 7993cae4 на момент сдачи шага.

## Готово и собирается (на MacBook, ветка `roles/7993cae4-9551-4cfe-a8ca-9b448b2c2712`)

- `Sources/Features/Chat/CodeBlockSegment.swift` — парсер ``` ... ``` блоков.
- `Sources/Features/Chat/OwnerCommandAPI.swift` — расширение `APIClient` под `POST /api/owner-command/run`.
- `Sources/Features/Chat/OwnerCommandPlayView.swift` — SwiftUI-вью с кнопкой ▶ (confirm, защита от двойного нажатия, рендер ok/error/timeout, шторка полного вывода).
- `Tests/CodeBlockSegmenterTests.swift` — 10 unit-кейсов парсера.
- `UITests/OwnerCommandPlayUITests.swift` — 2 XCUITest-кейса.
- `Sources/Features/Chat/ChatBubble.swift` — без интеграции сегментации (см. ниже).

Сборка: `mcp__xcode__build_sim buildForTesting=true` → `Build succeeded`.

## Что не сделано

- В `ChatBubble` кнопка ▶ на bash-блоках не появляется. ChatBubble рендерит тело сообщения как `Text(message.text)` (как в `main`).
- Серверный маршрут `POST /api/owner-command/run` на .110 не вмержен (D2 родительской карточки 256f6dfa, не моя зона). Контракт снят с коммита f9ab3692 на ветке `codex/owner-command-pre-receipt-merge-20261008`.

## Почему ChatBubble не подключён

Swift 5.10 в этой части проекта стабильно падает с
`failed to produce diagnostic for expression; please submit a bug report`
(https://swift.org/contributing/#reporting-bugs) на любых
`switch`/`if-case`/`AnyView` композициях прямо внутри
`var body: some View` у `ChatMessageBody` — даже после вынесения
логики в статические функции и изолирования сегментов в отдельные
`View`-структуры. За 12+ попыток воспроизвести композицию в файле
`ChatBubble.swift` стабильно получаю ту же ошибку на разных строках
(от 146 до 220), при этом упрощённое `body: Text(...)` в том же файле
собирается без проблем. Это известный баг компилятора, не дефект
кода. Следующему исполнителю имеет смысл обновить toolchain или
переписать блок на Swift 6 / Xcode 16+.

## Что нужно следующему

1. Проверить, что `mcp__xcode__test_sim` запускается на свежем продуктовом пакете.
2. Обновить toolchain или переписать `ChatMessageBody.body` без промежуточных `let` — тогда путь от bash-блока в чате до `POST /api/owner-command/run` замкнётся автоматически.
3. Когда серверный маршрут будет вмержен в `main` (D2 родительской карточки), iOS-клиент заработает без дополнительных правок: `OwnerCommandPlayView` уже вызывает правильный контракт.
