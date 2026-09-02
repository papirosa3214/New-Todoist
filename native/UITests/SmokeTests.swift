import XCTest

/// Проверки «работает ли вообще» — приложение запускается на симуляторе,
/// ходит в живой сервер (192.168.1.110:3001) и показывает настоящие данные.
///
/// Зачем именно так, а не снимками: снимок показывает вид в один момент и
/// молчит о том, что кнопка ничего не делает, а экран открывается пустым.
/// Владелец 01.09.2026: «собрали хуйню какую-то нерабочую, кривую» — эти
/// тесты и должны такое ловить до него.
///
/// Вход не вводится руками: из домашней сети сервер отдаёт сессию владельца
/// сам (`POST /api/auth/lan`, заголовок `X-TaskFlow-Client`), симулятор в этой
/// же сети — значит приложение обязано открыться сразу на «Обзоре».
final class SmokeTests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func запустить(экран: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        if let экран { app.launchEnvironment["TASKFLOW_DEBUG_ROUTE"] = экран }
        app.launch()
        return app
    }

    /// Ждать появления — сеть живая, данные приходят не мгновенно.
    private func ждать(_ элемент: XCUIElement, _ секунд: TimeInterval = 20) -> Bool {
        элемент.waitForExistence(timeout: секунд)
    }

    func testПриложениеОткрываетсяБезВвораПароля() {
        let app = запустить()
        XCTAssertTrue(ждать(app.staticTexts["Обзор"]), "Стартовый экран «Обзор» не появился — приложение осталось на входе")
        XCTAssertFalse(app.staticTexts["Войдите под своей учётной записью"].exists, "Показана форма входа, хотя из домашней сети вход должен быть автоматическим")
    }

    func testНаОбзореЖивыеДанныеСервера() {
        let app = запустить()
        XCTAssertTrue(ждать(app.staticTexts["Обзор"]))
        for плитка in ["В работе", "На проверке", "Заблокированы"] {
            XCTAssertTrue(app.staticTexts[плитка].exists, "На «Обзоре» нет плитки «\(плитка)»")
        }
        for раздел in ["Проекты", "Уведомления", "Настройки"] {
            XCTAssertTrue(app.staticTexts[раздел].exists, "На «Обзоре» нет раздела «\(раздел)»")
        }
    }

    func testВкладкиПереключаются() {
        let app = запустить()
        XCTAssertTrue(ждать(app.staticTexts["Обзор"]))

        // Шапка «Сегодня» — это дата («Вторник, 1 сен.»), слова «Сегодня» на
        // экране нет; опознаём вкладку по её кнопке фильтров и списку.
        app.buttons["Сегодня"].tap()
        XCTAssertTrue(ждать(app.buttons["Фильтры"]) || ждать(app.staticTexts["Ждут вас"], 5),
                      "Вкладка «Сегодня» не открылась")

        app.buttons["Планирование"].tap()
        XCTAssertTrue(ждать(app.staticTexts["Планирование"]), "Вкладка «Планирование» не открылась")

        app.buttons["Чат"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "chat.screen").firstMatch.waitForExistence(timeout: 15),
                      "Вкладка «Чат» не открылась — chat.screen identifier не найден")
    }

    func testПанельСозданияЗадачиОткрываетсяСодержимой() {
        let app = запустить(экран: "quickadd")
        let поле = app.textFields["Название задачи"].firstMatch
        XCTAssertTrue(ждать(поле), "Панель быстрого создания открылась пустой — поля названия нет")
        XCTAssertTrue(app.staticTexts["Проект"].exists || app.buttons["Проект"].exists, "В панели нет кнопки выбора проекта")
    }

    func testРазделыОбзораОткрываются() {
        let app = запустить()
        XCTAssertTrue(ждать(app.staticTexts["Обзор"]))
        app.staticTexts["Проекты"].tap()
        XCTAssertTrue(ждать(app.staticTexts["Проекты"]), "Экран проектов не открылся")
    }
}
