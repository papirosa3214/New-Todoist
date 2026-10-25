# iOS Role Live Window Scroll Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В нативном приложении TaskFlow карточка роли в графе плана должна сохранять позицию прокрутки во время идущего хода, оставляя кнопку «Прервать» доступной и продолжая показывать живые события.

**Architecture:** Сервер остаётся источником событий `task:activity` и `tasks:live`. Нативный клиент разделяет редкий REST-снимок и частое событийное обновление: снимок берётся при открытии/смене шага/сцены, а список действий обновляется не чаще раза в две секунды. Один приложенческий `RealtimeClient` обслуживает всех подписчиков вместо отдельного WebSocket на каждый экран.

**Tech Stack:** SwiftUI, Observation, URLSessionWebSocketTask, XCTest, TaskFlow API/WebSocket, SQLite на сервере только для read-only диагностики.

**Spec:** Этот документ, раздел «Установленные факты и критерии приёмки».

## Global Constraints

- Исходник нативного клиента изменять только в `/Users/max/Проекты/TaskFlowNativeBuild` на MacBook.
- Текущую грязную ветку `roles/builder-swipe-complete-20261024` не использовать для сборки или установки: она не содержит исправления `d012eb15`.
- Замороженный веб-клиент `/home/maksim/Проекты/New-Todoist/src (Временно приостановлена разработка)` не трогать.
- Серверный код не менять: сервер корректно публикует живые события, дефект находится в iOS-клиенте.
- Не запускать и не расширять XCUITest без отдельного явного согласия владельца.
- Не устанавливать сборку на физический iPhone без отдельного явного поручения владельца.
- Не убирать живое обновление: запрещено «лечить» прокрутку простым прекращением обновлений.
- Каждое независимое изменение — отдельный коммит; push выполнять только по поручению владельца.

---

## Установленные факты и критерии приёмки

### Что воспроизведено

- Сервер и web живы: `GET http://127.0.0.1:3001/api/health` вернул `200`; порты `3001` и `5180` слушаются.
- Наблюдаемая карточка: задача `252c400e-aa8e-4cab-9993-0d7e85388e1e` («Упорядочить чат, прерывания и обсуждение работающей задачи»), проект `TaskFlow - NewTodoist`, активный узел `discussion`, роль `builder` («Разработчик»).
- iPhone `192.168.1.123` за 30 секунд сделал 150 запросов: 40 подключений к `/ws`, 19 `GET /api/tasks/:id/live`, 18 `GET /api/tasks/:id/activity`, 18 `GET /api/tasks`, 18 `GET /api/notifications`, 36 вариантов списка задач.
- Медианный интервал `/live` — 1,640 с; `/activity` — 1,645 с. Это совпадает с частотой живых событий, а не с медленной сетью.
- Источник сброса прокрутки найден в `Sources/Features/Task/Detail/PlanStepSheets.swift`: вложенный `ScrollView` окна роли имел `.defaultScrollAnchor(.bottom)`. SwiftUI пересчитывает якорь при изменении содержимого; при идущем ходе содержимое меняется каждую секунду, поэтому окно уводит пользователя наверх.

### Что уже сделано, но ещё не доведено до телефона

- Локальный `main` содержит `d012eb15 fix(ios): окно живого хода больше не сбрасывает прокрутку`: якорь удалён, а `TaskLiveActivityView` больше не привязывает REST-снимок к ревизиям живых событий.
- Фикс есть только в локальных `main`/`fix/live-window-scroll-anchor`; ни `origin/main`, ни `github/main`, ни `gitea/main` его не содержат.
- Текущая рабочая ветка MacBook `roles/builder-swipe-complete-20261024` фикс не содержит.
- В `main` остаются два незакрытых пути:
  1. `AgentTraceView` всё ещё выполняет `GET /live` на каждую ревизию активности.
  2. `TaskLiveActivityView` и `AgentTraceView` создают каждый собственный `RealtimeClient`, из-за чего один экран добавляет несколько WebSocket-соединений.

### Критерии приёмки

1. После открытия шторки роли позиция прокрутки в окне «В работе» не меняется минимум 10 секунд при продолжающихся живых событиях.
2. Кнопка «Прервать» остаётся достижимой без повторной прокрутки.
3. Живой текст/список действий продолжает обновляться, но не чаще одного раза в две секунды для REST-части.
4. После открытия шторки не идёт новый `GET /api/tasks/:id/live` на каждое событие.
5. На весь экран используется одно приложенческое WebSocket-соединение, а не отдельное на каждый дочерний вид.
6. Unit-тесты проходят; сборка simulator успешна; визуальная проверка выполнена кадром. Физический iPhone проверяется только после отдельного разрешения на установку.

---

### Task 1: Зафиксировать чистую исходную точку и baseline

**Files:**
- Create: `docs/2026-10-25-role-live-window-scroll-stability.md` на MacBook
- Read only: `AGENT-WORK-SCOPES.md`, `Sources/Features/Task/Detail/PlanStepSheets.swift`, `Sources/Features/Task/Detail/TaskLiveActivityView.swift`, `Sources/Features/Task/Detail/AgentTraceView.swift`

**Interfaces:**
- Consumes: локальный `main` с коммитом `24ceb325`
- Produces: отдельная чистая ветка/worktree и измеримый baseline сети

- [ ] **Step 1: Создать отдельный worktree от локального `main`**

Выполнять на MacBook после загрузки skill `superpowers:using-git-worktrees`:

```bash
cd ~/Проекты/TaskFlowNativeBuild
git worktree add .worktrees/live-window-followup -b fix/live-window-followup 24ceb325
git -C .worktrees/live-window-followup status -sb
```

Expected: чистая ветка `fix/live-window-followup` на `24ceb325`; чужие изменения из `roles/builder-swipe-complete-20261024` не попадают в worktree.

- [ ] **Step 2: Зафиксировать baseline запросов iPhone**

На `.110` за 30 секунд посчитать запросы с `remoteAddress=192.168.1.123`, отдельно `/ws`, `/api/tasks/:id/live`, `/api/tasks/:id/activity`. Сохранить команды и числа в отчёте.

Expected baseline из текущего состояния: около 5 запросов/с, `/live` и `/activity` примерно раз в 1,6 с, множественные `/ws`.

- [ ] **Step 3: Вручную зафиксировать исходное поведение**

На физическом iPhone: открыть задачу → узел роли «Разработчик» → раскрыть «В работе» → прокрутить к кнопке «Прервать» → подождать 10 секунд.

Expected на старом клиенте: позиция прыгает наверх, кнопка становится недоступна. На новом клиенте: позиция сохраняется.

- [ ] **Step 4: Коммит отчёта**

```bash
git add docs/2026-10-25-role-live-window-scroll-stability.md
git commit -m "docs(ios): зафиксировать сброс прокрутки окна роли"
```

---

### Task 2: Разделить снимок и поток обновлений

**Files:**
- Create: `Sources/Features/Task/Detail/LiveActivityRefreshState.swift`
- Create: `Tests/LiveActivityRefreshStateTests.swift`
- Modify: `Sources/Features/Task/Detail/TaskLiveActivityView.swift`
- Modify: `Sources/Features/Task/Detail/AgentTraceView.swift`

**Interfaces:**
- Consumes: `RealtimeEvent.taskActivity(taskId:raw:)`, `RealtimeEvent.taskLive(TaskLiveTurn)`, `APIClient.taskLiveTurns`, `APIClient.taskActivity`
- Produces: `LiveActivityRefreshState` с операциями `markDirty()` и `takeDirty()`; REST-обновление не чаще одного раза в 2 секунды

- [ ] **Step 1: Написать failing unit-тест**

```swift
import XCTest
@testable import TaskFlow

final class LiveActivityRefreshStateTests: XCTestCase {
    func testDirtyFlagSurvivesUntilOneRefreshConsumesIt() {
        var state = LiveActivityRefreshState()
        XCTAssertFalse(state.takeDirty())

        state.markDirty()
        state.markDirty()
        XCTAssertTrue(state.takeDirty())
        XCTAssertFalse(state.takeDirty())
    }
}
```

- [ ] **Step 2: Запустить тест на старом коде и зафиксировать RED**

```bash
xcodebuild test -project TaskFlow.xcodeproj -scheme TaskFlow \
  -destination 'platform=iOS Simulator,id=9FF78D89-EE84-4914-AA56-D0A72D1AF43A' \
  -only-testing:TaskFlowTests/LiveActivityRefreshStateTests
```

Expected: компиляция падает, потому что `LiveActivityRefreshState` ещё нет.

- [ ] **Step 3: Добавить минимальное состояние**

```swift
struct LiveActivityRefreshState {
    private(set) var isDirty = false

    mutating func markDirty() { isDirty = true }
    mutating func takeDirty() -> Bool {
        let value = isDirty
        isDirty = false
        return value
    }
}
```

- [ ] **Step 4: Убрать привязку снимка к ревизиям событий**

В `TaskLiveActivityView`:

- REST-снимок оставить под `.task(id: "\(taskID):\(subtaskID ?? ""):\(scenePhase)")`.
- В `realtime.onEvent` для `.taskActivity` вызывать `activityRefreshState.markDirty()`.
- Запустить один цикл обновления на время сцены; после паузы в 2 секунды вызвать `takeDirty()` и только при `true` выполнить `refreshActivity()`.
- Не использовать `.task(id: activityRevision)` с `Task.sleep(2)`: смена id отменяет предыдущую SwiftUI-задачу, поэтому при событиях чаще раза в две секунды ожидание постоянно отменяется и список может не обновляться. Поведение подтверждено документацией Apple: «If the `id` value changes, SwiftUI cancels and restarts the task» — https://developer.apple.com/documentation/swiftui/view/task(id:name:priority:file:line:_:)

В `AgentTraceView`:

- первичный `taskLiveTurns` брать только при смене `scope`/`scenePhase`;
- `tasks:live` продолжать применять локально через `receive(live)` без REST;
- fallback `taskActivity` брать через тот же dirty/throttle-механизм, а не на каждую `activityRevision`.

- [ ] **Step 5: Запустить целевые тесты и получить GREEN**

```bash
xcodebuild test -project TaskFlow.xcodeproj -scheme TaskFlow \
  -destination 'platform=iOS Simulator,id=9FF78D89-EE84-4914-AA56-D0A72D1AF43A' \
  -only-testing:TaskFlowTests/LiveActivityRefreshStateTests \
  -only-testing:TaskFlowTests/AgentTraceTests
```

Expected: перечисленные тесты выполнены, падений нет; в выводе обязательно присутствует строка `Executed N tests`, а не только `TEST SUCCEEDED`.

- [ ] **Step 6: Коммит**

```bash
git add Sources/Features/Task/Detail/LiveActivityRefreshState.swift \
        Sources/Features/Task/Detail/TaskLiveActivityView.swift \
        Sources/Features/Task/Detail/AgentTraceView.swift \
        Tests/LiveActivityRefreshStateTests.swift
git commit -m "fix(ios): не перезапрашивать живой ход на каждое событие"
```

---

### Task 3: Убрать отдельные WebSocket на каждый дочерний экран

**Files:**
- Modify: `Sources/Core/Realtime/RealtimeClient.swift`
- Modify: `Sources/Features/Task/Detail/TaskLiveActivityView.swift`
- Modify: `Sources/Features/Task/Detail/AgentTraceView.swift`
- Modify: `Tests/RealtimeEnergyTests.swift`

**Interfaces:**
- Consumes: существующий один `@Environment(RealtimeClient.self)` уровня приложения
- Produces: `RealtimeClient.addObserver` / `removeObserver`; несколько подписчиков получают одно событие, удаление подписчика не влияет на остальных

- [ ] **Step 1: Написать failing unit-тест на мультиподписку**

Тест должен доказать: два подписчика получают одно событие, после удаления первого второй продолжает получать события, существующий `onEvent` не сломан.

- [ ] **Step 2: Запустить тест и зафиксировать RED**

Expected: API `addObserver` / `removeObserver` отсутствует.

- [ ] **Step 3: Добавить реестр подписчиков в `RealtimeClient`**

Хранить наблюдателей по UUID в `@ObservationIgnored`; удаление — по UUID. `onEvent` оставить для обратной совместимости и вызывать вместе с observers.

- [ ] **Step 4: Перевести виды на общий клиент**

В `TaskLiveActivityView` и `AgentTraceView`:

- удалить `@State private var realtime = RealtimeClient()`;
- получать `@Environment(RealtimeClient.self) private var realtime`;
- подписываться в `.task` и снимать подписку в `.onDisappear`;
- не открывать и не закрывать общий сокет из дочернего вида.

- [ ] **Step 5: Проверить GREEN и существующие realtime-тесты**

```bash
xcodebuild test -project TaskFlow.xcodeproj -scheme TaskFlow \
  -destination 'platform=iOS Simulator,id=9FF78D89-EE84-4914-AA56-D0A72D1AF43A' \
  -only-testing:TaskFlowTests/RealtimeEnergyTests \
  -only-testing:TaskFlowTests/RealtimeInvalidationCoalescingTests \
  -only-testing:TaskFlowTests/LiveActivityRefreshStateTests
```

- [ ] **Step 6: Коммит**

```bash
git add Sources/Core/Realtime/RealtimeClient.swift \
        Sources/Features/Task/Detail/TaskLiveActivityView.swift \
        Sources/Features/Task/Detail/AgentTraceView.swift \
        Tests/RealtimeEnergyTests.swift
git commit -m "fix(ios): один realtime-канал на экран роли"
```

---

### Task 4: Проверить прокрутку и сетевой эффект

**Files:**
- Modify: `docs/2026-10-25-role-live-window-scroll-stability.md` (только результаты проверок)

- [ ] **Step 1: Прогнать сторож и целевые unit-тесты**

```bash
python3 Tools/design-system-guard.py --diff HEAD
```

Expected: новых нарушений нет.

- [ ] **Step 2: Собрать simulator один раз**

```bash
xcodegen generate
xcodebuild -project TaskFlow.xcodeproj -scheme TaskFlow \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=9FF78D89-EE84-4914-AA56-D0A72D1AF43A' \
  -derivedDataPath build_sim build
```

Expected: `BUILD SUCCEEDED`.

- [ ] **Step 3: Проверить экран кадром без UI-теста**

Открыть только нужный экран через `TASKFLOW_DEBUG_ROUTE` или обычную accessibility-навигацию, снять один кадр и проверить наличие окна роли и состояния «В работе». Не обходить соседние экраны и не запускать UI-тест.

- [ ] **Step 4: Проверить сеть на работающем агенте**

После открытия роли на реальном сервере за 30 секунд посчитать iPhone-запросы.

Expected:

- `GET /api/tasks/:id/live` — только при открытии/смене шага, не на каждое событие;
- `GET /api/tasks/:id/activity` — не чаще одного раза в две секунды;
- `/ws` — одно устойчивое соединение, а не серия переподключений;
- список действий и живой текст визуально продолжают обновляться.

- [ ] **Step 5: Коммит отчёта**

```bash
git add docs/2026-10-25-role-live-window-scroll-stability.md
git commit -m "docs(ios): проверить стабильность окна живого хода"
```

---

### Task 5: Доставить на физический iPhone отдельным разрешением

**Files:**
- No source changes

- [ ] **Step 1: Получить явное разрешение владельца на установку на iPhone**

Без этого шага сборка на физический телефон не запускается.

- [ ] **Step 2: Собрать из чистого worktree, а не из текущей грязной ветки**

Использовать `fix/live-window-followup`; перед сборкой зафиксировать `git status -sb` и `git rev-parse HEAD`.

- [ ] **Step 3: Установить и проверить вручную**

Проверить на устройстве: позиция окна сохраняется 10 секунд, кнопка «Прервать» достижима, живые события продолжаются.

- [ ] **Step 4: Отдельно решить судьбу push**

Локальный `main` опережает remotes. Push `main`/fix-ветки выполнять только по явному поручению владельца; сначала убедиться, что в remote не попадут чужие незакоммиченные изменения.

---

## Self-review

- Spec coverage: первопричина, доставка существующего фикса, незакрытые `AgentTraceView`/WebSocket-пути, unit-проверки, simulator-проверка и отдельная установка на iPhone покрыты Tasks 1–5.
- Placeholder scan: незаполненных мест и отсылок «сделать аналогично» нет; для каждого изменения указаны файлы и команды.
- Type consistency: `LiveActivityRefreshState.markDirty()` / `takeDirty()` одинаковы в описании, тесте и интеграции; `RealtimeClient.addObserver` / `removeObserver` совпадают в тесте и реализации.
- Scope check: серверный подсистемный рефакторинг не требуется; изменения ограничены нативным клиентом и его unit-тестами.
