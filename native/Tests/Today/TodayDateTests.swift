import XCTest
@testable import TaskFlow

/// Юнит-тесты на `TodayDate` — чистые функции форматирования и арифметики дат.
/// Без сети, без UI, без мока Moscow-таймзоны в часах (завязано на Date()).
final class TodayDateTests: XCTestCase {

    // MARK: addDays — границы месяца/года

    func testAddDaysВнутриМесяца() {
        XCTAssertEqual(TodayDate.addDays("2026-09-15", 5), "2026-09-20")
    }

    func testAddDaysЧерезГраницуМесяца() {
        // 28 февраля + 3 дня → 3 марта
        XCTAssertEqual(TodayDate.addDays("2026-02-28", 3), "2026-03-03")
    }

    func testAddDaysВисокосныйГод() {
        // 2028 — високосный; 29 февраля + 1 день
        XCTAssertEqual(TodayDate.addDays("2028-02-29", 1), "2028-03-01")
    }

    func testAddDaysЧерезГраницуГода() {
        XCTAssertEqual(TodayDate.addDays("2026-12-31", 1), "2027-01-01")
    }

    func testAddDaysОтрицательное() {
        XCTAssertEqual(TodayDate.addDays("2026-09-15", -5), "2026-09-10")
    }

    func testAddDaysНевалиднаяДатаВозвращаетИсходную() {
        XCTAssertEqual(TodayDate.addDays("not-a-date", 3), "not-a-date")
    }

    // MARK: daysUntil — относительные сутки

    func testDaysUntilСегодня() {
        let today = TodayDate.todayString()
        XCTAssertEqual(TodayDate.daysUntil(today), 0)
    }

    func testDaysUntilЗавтра() {
        let tomorrow = TodayDate.addDays(TodayDate.todayString(), 1)
        XCTAssertEqual(TodayDate.daysUntil(tomorrow), 1)
    }

    func testDaysUntilВчера() {
        let yesterday = TodayDate.addDays(TodayDate.todayString(), -1)
        XCTAssertEqual(TodayDate.daysUntil(yesterday), -1)
    }

    func testDaysUntilНеделяВперёд() {
        let week = TodayDate.addDays(TodayDate.todayString(), 7)
        XCTAssertEqual(TodayDate.daysUntil(week), 7)
    }

    func testDaysUntilНевалиднаяДата() {
        XCTAssertEqual(TodayDate.daysUntil("not-a-date"), 0)
    }

    // MARK: formatDaysLeft — склонения и спецслучаи

    func testFormatDaysLeftСегодня() {
        XCTAssertEqual(TodayDate.formatDaysLeft(TodayDate.todayString()), "сегодня")
    }

    func testFormatDaysLeftЗавтра() {
        let tomorrow = TodayDate.addDays(TodayDate.todayString(), 1)
        XCTAssertEqual(TodayDate.formatDaysLeft(tomorrow), "завтра")
    }

    func testFormatDaysLeftВчера() {
        let yesterday = TodayDate.addDays(TodayDate.todayString(), -1)
        XCTAssertEqual(TodayDate.formatDaysLeft(yesterday), "вчера")
    }

    func testFormatDaysLeft1День() {
        let d = TodayDate.addDays(TodayDate.todayString(), 2)
        XCTAssertEqual(TodayDate.formatDaysLeft(d), "осталось 2 дня")
    }

    func testFormatDaysLeft5Дней() {
        let d = TodayDate.addDays(TodayDate.todayString(), 5)
        XCTAssertEqual(TodayDate.formatDaysLeft(d), "осталось 5 дней")
    }

    func testFormatDaysLeft11Дней() {
        // 11..14 — особое исключение в русском склонении: «дней», не «дней» (но 11 попадает в исключение)
        let d = TodayDate.addDays(TodayDate.todayString(), 11)
        XCTAssertEqual(TodayDate.formatDaysLeft(d), "осталось 11 дней")
    }

    func testFormatDaysLeft21День() {
        // 21 — снова «день» (1, 21, 31…)
        let d = TodayDate.addDays(TodayDate.todayString(), 21)
        XCTAssertEqual(TodayDate.formatDaysLeft(d), "осталось 21 день")
    }

    func testFormatDaysLeftПросрочено() {
        let d = TodayDate.addDays(TodayDate.todayString(), -3)
        XCTAssertEqual(TodayDate.formatDaysLeft(d), "просрочено на 3 дня")
    }

    // MARK: formatDueLabel — относительные подписи

    func testFormatDueLabelСегодня() {
        XCTAssertTrue(TodayDate.formatDueLabel(TodayDate.todayString()).hasPrefix("Сегодня,"))
    }

    func testFormatDueLabelЗавтра() {
        let tomorrow = TodayDate.addDays(TodayDate.todayString(), 1)
        XCTAssertTrue(TodayDate.formatDueLabel(tomorrow).hasPrefix("Завтра,"))
    }

    func testFormatDueLabelДругойГод() {
        // 2030 — заведомо другой год от текущего
        XCTAssertTrue(TodayDate.formatDueLabel("2030-03-15").contains("2030"))
    }

    func testFormatDueLabelНевалиднаяВозвращаетИсходную() {
        XCTAssertEqual(TodayDate.formatDueLabel("xxx"), "xxx")
    }

    // MARK: formatWeekdayDateLabel — день недели + дата

    func testFormatWeekdayDateLabelСодержитДеньНедедели() {
        let result = TodayDate.formatWeekdayDateLabel("2026-09-01")  // известно: вторник
        XCTAssertTrue(result.contains("Вторник"), "Ожидали «Вторник» в \(result)")
    }

    func testFormatWeekdayDateLabelНевалиднаяВозвращаетИсходную() {
        XCTAssertEqual(TodayDate.formatWeekdayDateLabel("xxx"), "xxx")
    }

    // MARK: formatWeekdayLabel — только день недели для большой шапки

    func testFormatWeekdayLabelВозвращаетТолькоДеньНедели() {
        XCTAssertEqual(TodayDate.formatWeekdayLabel("2026-09-01"), "Вторник")
    }

    func testFormatWeekdayLabelНевалиднаяВозвращаетИсходную() {
        XCTAssertEqual(TodayDate.formatWeekdayLabel("xxx"), "xxx")
    }

    // MARK: calendarDate / calendarDateString — round-trip

    func testCalendarDateRoundTrip() {
        XCTAssertEqual(TodayDate.calendarDateString(TodayDate.calendarDate("2026-09-15")!), "2026-09-15")
    }

    func testCalendarDateEmptyВозвращаетNil() {
        XCTAssertNil(TodayDate.calendarDate(""))
        XCTAssertNil(TodayDate.calendarDate(nil))
    }

    // MARK: formatColumnDateLabel / formatDuePlain / formatDayColumnLabel

    func testFormatColumnDateLabelСодержитДеньНедедели() {
        let result = TodayDate.formatColumnDateLabel("2026-09-01")
        XCTAssertTrue(result.contains("Вторник"))
    }

    func testFormatDuePlain() {
        XCTAssertEqual(TodayDate.formatDuePlain("2026-09-15"), "15 сен")
    }

    func testFormatDayColumnLabel() {
        XCTAssertEqual(TodayDate.formatDayColumnLabel("2026-09-01"), "Вт 1")
    }
}
