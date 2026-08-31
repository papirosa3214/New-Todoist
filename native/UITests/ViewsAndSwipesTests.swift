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

    // MARK: - Свайпы по строке задачи

    func testСвайпПоЗадачеДаётДействия() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)

        let строка = app.cells.firstMatch.exists ? app.cells.firstMatch : app.staticTexts.element(boundBy: 3)
        guard строка.waitForExistence(timeout: 15) else {
            XCTFail("На «Сегодня» нет ни одной задачи — свайпы проверить не на чем")
            return
        }
        строка.swipeLeft()
        let естьДействие = app.buttons["Завершить"].waitForExistence(timeout: 3)
            || app.buttons["Перенести"].waitForExistence(timeout: 1)
            || app.buttons["Удалить"].waitForExistence(timeout: 1)
        XCTAssertTrue(естьДействие, "Свайп влево по задаче не открыл ни одного действия")

        строка.swipeRight()
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
        let задача = app.cells.firstMatch.exists ? app.cells.firstMatch : app.staticTexts.element(boundBy: 3)
        guard задача.waitForExistence(timeout: 15) else {
            XCTFail("На «Сегодня» нет задач — карточку не открыть")
            return
        }
        задача.tap()
        let открылась = app.buttons["Изменить"].waitForExistence(timeout: 10)
            || app.buttons["Завершить задачу"].waitForExistence(timeout: 3)
        XCTAssertTrue(открылась, "Карточка задачи не открылась по тапу")
    }
}
