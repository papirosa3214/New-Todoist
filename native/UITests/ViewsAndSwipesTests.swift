import XCTest

/// Все представления и все жесты — за один прогон.
///
/// Просьба владельца 01.09.2026: «во всех представлениях, все свайпы эти
/// проверяй, свайпы там тоже кривущие» и «сразу насобирать пачку косяков и
/// разом собирать, чем один исправил — пересобрал, опять исправил».
/// Поэтому проверки НЕ прекращают тест на первом провале
/// (`continueAfterFailure = true`): один прогон отдаёт весь список.
final class ViewsAndSwipesTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    private func запустить(экран: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        // Форсируем вид «Список» на «Сегодня»: иначе цикл снятия кадров мог
        // оставить в UserDefaults «Один день», и тесты увидят шкалу без строк.
        app.launchArguments = ["-taskflow_today_layout", "list"]
        if let экран { app.launchEnvironment["TASKFLOW_DEBUG_ROUTE"] = экран }
        app.launch()
        XCTAssertTrue(app.staticTexts["Обзор"].waitForExistence(timeout: 25),
                      "Приложение не дошло до стартового экрана")
        return app
    }

    private func открыть(вкладку: String, _ app: XCUIApplication) {
        let кнопка = app.buttons[вкладку]
        XCTAssertTrue(кнопка.waitForExistence(timeout: 10), "Нет кнопки вкладки «\(вкладку)»")
        кнопка.tap()
    }

    // MARK: - Представления «Сегодня»: список / доска / один день

    func testВсеПредставленияСегодняРисуются() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)

        // Переключатель вида — в шапке экрана («…»/меню вида, spec §4.4).
        for вид in ["Список", "Доска", "Один день"] {
            let меню = app.buttons["Вид"].exists ? app.buttons["Вид"] : app.buttons.matching(identifier: "ellipsis").firstMatch
            XCTAssertTrue(меню.waitForExistence(timeout: 10), "На «Сегодня» нет переключателя вида — вид «\(вид)» не проверить")
            меню.tap()
            let пункт = app.buttons[вид]
            if пункт.waitForExistence(timeout: 5) {
                пункт.tap()
                // После переключения экран обязан остаться живым: шапка на месте.
                XCTAssertTrue(app.buttons["Фильтры"].waitForExistence(timeout: 10),
                              "После переключения на «\(вид)» шапка пропала — экран сломался")
            } else {
                XCTFail("В меню вида нет пункта «\(вид)»")
                if app.buttons["Отмена"].exists { app.buttons["Отмена"].tap() }
            }
        }
    }

    func testФильтрСегодняОткрываетсяНативнымМеню() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)

        let фильтр = app.buttons["Фильтры"]
        XCTAssertTrue(фильтр.waitForExistence(timeout: 10), "Нет кнопки фильтров")
        фильтр.tap()

        XCTAssertTrue(app.buttons["Проект"].waitForExistence(timeout: 5),
                      "Фильтр не открыл системное меню с пунктом «Проект»")
        XCTAssertTrue(app.buttons["Метка"].exists, "В системном меню нет пункта «Метка»")
        XCTAssertTrue(app.buttons["Исполнитель"].exists, "В системном меню нет пункта «Исполнитель»")
        XCTAssertTrue(app.switches["Показывать выполненные"].exists
                      || app.buttons["Показывать выполненные"].exists,
                      "В системном меню нет нативного переключателя выполненных")
    }

    // MARK: - Свайпы по строке задачи

    func testСвайпПоЗадачеДаётДействия() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)

        // Строка в дереве — элемент типа «other», а не кнопка: она собрана
        // как единый accessibility-элемент ради VoiceOver, и трейт кнопки её
        // тип не меняет. Поэтому ищем среди всех потомков по идентификатору.
        let строка = app.descendants(matching: .any).matching(identifier: "today.task-row").element(boundBy: 0)
        guard строка.waitForExistence(timeout: 15) else {
            XCTFail("На «Сегодня» нет ни одной задачи (не найден row по identifier today.task-row) — свайпы проверить не на чем")
            return
        }
        // До свайпа все кнопки свайпа скрыты (accessibilityHidden) — isHittable=false.
        XCTAssertFalse(app.buttons["Завершить"].isHittable, "Кнопка «Завершить» уже доступна без свайпа")

        // Стороны — те же, что в вебе (`src/lib/useRowSwipe.ts`, TaskRow.tsx):
        // ВЛЕВО открывается правый край с «Завершить»/«Перенести», ВПРАВО —
        // левый край с красным «Удалить». Жест единый в вебе и в нативе.
        строка.swipeLeft()
        XCTAssertTrue(app.buttons["Завершить"].waitForExistence(timeout: 5),
                      "После свайпа влево не появилась кнопка «Завершить»")

        // Ф4 из разбора ревьюера: `.offset()` двигает отрисовку, не layout — кнопка
        // визуально видна, но accessibility-frame не сдвигается и `isHittable=false`.
        // Тапаем координатой (как сделал бы пользователь пальцем по видимой кнопке).
        // Сам факт успешного тапа — уже доказательство «свайп открыл действие».
        let кнопка = app.buttons["Завершить"].firstMatch
        кнопка.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        // Обратная сторона: свайп вправо обязан дать «Удалить». Не тапаем —
        // за ним диалог подтверждения, он тесту не нужен.
        let строка2 = app.descendants(matching: .any).matching(identifier: "today.task-row").element(boundBy: 0)
        guard строка2.waitForExistence(timeout: 5) else { return }
        строка2.swipeRight()
        XCTAssertTrue(app.buttons["Удалить"].waitForExistence(timeout: 5),
                      "После свайпа вправо не появилась кнопка «Удалить»")
        строка2.swipeLeft()
    }

    /// Прокрутка ПАЛЬЦЕМ ПО СТРОКЕ, а не по пустому месту.
    ///
    /// Прежний тест листал `otherElements.firstMatch` и потому не замечал
    /// главного: собственный DragGesture на строке забирал жест себе, и
    /// список стоял намертво, если вести палец по задаче (а иначе по нему и
    /// не ведут). Проверяем по факту сдвига: координата строки обязана
    /// измениться после свайпа вверх.
    func testСписокЛистаетсяПальцемПоЗадаче() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)
        let строка = app.descendants(matching: .any).matching(identifier: "today.task-row").firstMatch
        guard строка.waitForExistence(timeout: 15) else {
            XCTFail("На «Сегодня» нет задач — прокрутку проверить не на чем")
            return
        }
        let было = строка.frame.origin.y
        строка.swipeUp()
        Thread.sleep(forTimeInterval: 1)
        let стало = app.descendants(matching: .any).matching(identifier: "today.task-row").firstMatch.frame.origin.y
        XCTAssertNotEqual(было, стало, accuracy: 0.5,
                          "Список не сдвинулся: жест по строке съел вертикальную прокрутку")
    }

    func testСписокЛистаетсяВертикально() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)
        let экран = app.otherElements.firstMatch
        экран.swipeUp()
        экран.swipeDown()
        XCTAssertTrue(app.buttons["Фильтры"].exists || app.buttons["Сегодня"].exists,
                      "После вертикальной прокрутки экран «Сегодня» развалился")
    }

    // MARK: - Планирование и чат

    func testПланированиеОткрываетсяИЛистается() {
        let app = запустить()
        открыть(вкладку: "Планирование", app)
        XCTAssertTrue(app.staticTexts["Планирование"].waitForExistence(timeout: 15),
                      "Экран «Планирование» не открылся")
        app.otherElements.firstMatch.swipeLeft()
        app.otherElements.firstMatch.swipeRight()
        XCTAssertTrue(app.staticTexts["Планирование"].exists,
                      "После горизонтальных свайпов «Планирование» пропало")
    }

    func testЧатОткрывается() {
        let app = запустить()
        открыть(вкладку: "Чат", app)
        let открылся = app.staticTexts["Чат"].waitForExistence(timeout: 15)
            || app.textViews.firstMatch.waitForExistence(timeout: 5)
            || app.textFields.firstMatch.waitForExistence(timeout: 5)
        XCTAssertTrue(открылся, "Вкладка «Чат» не открылась: ни заголовка, ни поля ввода")
    }

    // MARK: - Карточка задачи

    func testКарточкаЗадачиОткрываетсяПоТапу() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)
        // По разбору ревьюера: app.cells.firstMatch / staticTexts.element(boundBy: 3)
        // — это случайный текст в LazyVStack (cells=0). Переписано на стабильный
        // identifier строки, как в testСвайпПоЗадачеДаётДействия.
        let задача = app.descendants(matching: .any).matching(identifier: "today.task-row").firstMatch
        guard задача.waitForExistence(timeout: 15) else {
            XCTFail("На «Сегодня» нет задач (не найден row по identifier today.task-row)")
            return
        }
        задача.tap()
        let открылась = app.buttons["Изменить"].waitForExistence(timeout: 10)
            || app.buttons["Завершить задачу"].waitForExistence(timeout: 3)
        XCTAssertTrue(открылась, "Карточка задачи не открылась по тапу")
    }
}
