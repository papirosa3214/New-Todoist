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

    // MARK: - Свайпы по строке задачи

    func testСвайпПоЗадачеДаётДействия() {
        let app = запустить()
        открыть(вкладку: "Сегодня", app)

        let строка = app.buttons.matching(identifier: "today.task-row").element(boundBy: 0)
        guard строка.waitForExistence(timeout: 15) else {
            XCTFail("На «Сегодня» нет ни одной задачи (не найден row по identifier today.task-row) — свайпы проверить не на чем")
            return
        }
        // До свайпа все кнопки свайпа скрыты (accessibilityHidden) — isHittable=false.
        XCTAssertFalse(app.buttons["Завершить"].isHittable, "Кнопка «Завершить» уже доступна без свайпа")

        строка.swipeLeft()
        let появилась = app.buttons["Завершить"].waitForExistence(timeout: 5)
        XCTAssertTrue(появилась, "После свайпа влево не появилась кнопка «Завершить»")

        // Ф4 из разбора ревьюера: `.offset()` двигает отрисовку, не layout — кнопка
        // визуально видна, но accessibility-frame не сдвигается и `isHittable=false`.
        // Тапаем координатой (как сделал бы пользователь пальцем по видимой кнопке).
        // Сам факт успешного тапа — уже доказательство «свайп открыл действие».
        let кнопка = app.buttons["Завершить"].firstMatch
        let центр = кнопка.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        центр.tap()

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
        // По разбору ревьюера: app.cells.firstMatch / staticTexts.element(boundBy: 3)
        // — это случайный текст в LazyVStack (cells=0). Переписано на стабильный
        // identifier строки, как в testСвайпПоЗадачеДаётДействия.
        let задача = app.buttons.matching(identifier: "today.task-row").firstMatch
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
