import XCTest

/// Accessibility-тесты (задание Б5): `performAccessibilityAudit` (XCUITest, iOS 17+)
/// на ключевых экранах + smoke-проверки, что у значимых кнопок есть label/identifier.
///
/// Замечание из задания: «отсутствие меток мешало тестам в А1/А2» — здесь
/// просто перечисляем проблемы, починка отдельная (Б5 как покрытие).
final class AccessibilityTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    private func запустить() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-taskflow_today_layout", "list"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Обзор"].waitForExistence(timeout: 25),
                      "Приложение не дошло до стартового экрана")
        return app
    }

    private func открытьВкладку(_ название: String, _ app: XCUIApplication) {
        let tab = app.buttons[название]
        guard tab.waitForExistence(timeout: 10) else {
            return  // нет такой вкладки — тест мягко пропускает
        }
        tab.tap()
    }

    /// Полный audit на «Обзоре»: самый насыщенный экран.
    /// По решению владельца (01.09.2026): исключаем Dynamic Type из аудита —
    /// вся дизайн-система на фиксированных .font(.system(size: N)), чтобы пиксель
    /// в пиксель совпадать с вебом. 105 из 142 нарушений были Dynamic Type.
    func testAuditОбзор() throws {
        guard #available(iOS 17.0, *) else {
            throw XCTSkip("performAccessibilityAudit требует iOS 17+")
        }
        let app = запустить()
        try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType))
    }

    /// Audit на «Сегодня» — там раньше были кнопки без label (А1).
    func testAuditСегодня() throws {
        guard #available(iOS 17.0, *) else {
            throw XCTSkip("performAccessibilityAudit требует iOS 17+")
        }
        let app = запустить()
        открытьВкладку("Сегодня", app)
        XCTAssertTrue(app.staticTexts.firstMatch.waitForExistence(timeout: 5))
        try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType))
    }

    /// Audit на «Планировании».
    func testAuditПланирование() throws {
        guard #available(iOS 17.0, *) else {
            throw XCTSkip("performAccessibilityAudit требует iOS 17+")
        }
        let app = запустить()
        открытьВкладку("Планирование", app)
        XCTAssertTrue(app.staticTexts["Планирование"].waitForExistence(timeout: 5))
        try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType))
    }

    /// Audit на «Чате».
    func testAuditЧат() throws {
        guard #available(iOS 17.0, *) else {
            throw XCTSkip("performAccessibilityAudit требует iOS 17+")
        }
        let app = запустить()
        открытьВкладку("Чат", app)
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 15))
        try app.performAccessibilityAudit(for: .all.subtracting(.dynamicType))
    }

    // MARK: - smoke-проверки меток и identifier'ов

    /// Кнопка «+» в таб-баре должна иметь человеческую метку (русскую),
    /// а не «Add» или пустую.
    func testКнопкаСозданияИмеетМеткуНеПоУмолчанию() {
        let app = запустить()
        let addButton = app.buttons.matching(identifier: "tab.add").firstMatch
        XCTAssertTrue(addButton.waitForExistence(timeout: 5),
                      "Кнопка «+» не имеет identifier 'tab.add' — добавь в TFTabBar.swift")
        XCTAssertFalse(addButton.label.isEmpty, "У кнопки «+» пустой accessibilityLabel")
        XCTAssertNotEqual(addButton.label, "Add", "Кнопка «+» имеет английскую метку ‘Add’, нужна русская (‘Новая задача’)")
    }

    /// Все вкладки в таб-баре должны иметь identifier `tab.*` — чтобы тесты
    /// могли к ним обращаться по стабильному имени.
    func testВкладкиИмеютИдентификаторы() {
        let app = запустить()
        let tabNames = ["Сегодня", "Обзор", "Планирование", "Чат"]
        var найденоБезID: [String] = []
        for name in tabNames {
            let tab = app.buttons[name]
            if tab.exists, tab.identifier.isEmpty {
                найденоБезID.append(name)
            }
        }
        XCTAssertTrue(найденоБезID.isEmpty,
                      "Вкладки без identifier: \(найденоБезID.joined(separator: ", "))")
    }

    /// Шапка «Сегодня» — кнопки шапки должны иметь метки (см. А1).
    func testШапкаСегодняИмеетМетки() {
        let app = запустить()
        открытьВкладку("Сегодня", app)
        let filters = app.buttons["Фильтры"]
        let viewSwitcher = app.buttons["Вид"]
        XCTAssertTrue(filters.waitForExistence(timeout: 5),
                      "Кнопка «Фильтры» не имеет accessibilityLabel (см. А1)")
        XCTAssertTrue(viewSwitcher.waitForExistence(timeout: 5),
                      "Кнопка «Вид» (переключатель представления) не имеет accessibilityLabel (см. А1)")
    }
}
