import Foundation

// Тексты дат для экранов задачи — spec/SCREENS-1.md §4.1 (`lib/date.ts`).
// `Core/Common/DateFormats.swift` умеет только ПАРСИТЬ строки сервера в
// `Date` — человекочитаемые подписи («Сегодня, 31 авг.») там сознательно не
// заведены (не его слой), поэтому здесь свой набор функций поверх готового
// `Date`. Дни считаются по МОСКОВСКОМУ времени (spec §4.1) — задача со
// сроком «сегодня» не должна «уезжать» на соседний день из-за таймзоны
// устройства.
enum TaskDateText {

    static var moscow: TimeZone { TimeZone(identifier: "Europe/Moscow") ?? .current }

    /// Родительный падеж без точки — ровно как в спеке.
    static let monthsShort = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]

    private static func moscowCalendar() -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = moscow
        return cal
    }

    /// Разница в календарных днях между двумя датами по московскому времени.
    private static func dayDiff(_ date: Date, from reference: Date) -> Int {
        let cal = moscowCalendar()
        let a = cal.startOfDay(for: reference)
        let b = cal.startOfDay(for: date)
        return cal.dateComponents([.day], from: a, to: b).day ?? 0
    }

    /// `formatDueLabel` — «Срок»-подпись.
    static func dueLabel(_ date: Date, now: Date = Date()) -> String {
        let cal = moscowCalendar()
        let diff = dayDiff(date, from: now)
        let comps = cal.dateComponents([.day, .month, .year], from: date)
        let day = comps.day ?? 1
        let month = monthsShort[max(0, min(11, (comps.month ?? 1) - 1))]
        if diff == 0 { return "Сегодня, \(day) \(month)." }
        if diff == 1 { return "Завтра, \(day) \(month)." }
        let nowYear = cal.component(.year, from: now)
        if comps.year != nowYear { return "\(day) \(month) \(comps.year ?? nowYear)" }
        return "\(day) \(month)."
    }

    /// `formatDaysLeft` — короткая подпись «сколько осталось».
    static func daysLeft(_ date: Date, now: Date = Date()) -> String {
        let diff = dayDiff(date, from: now)
        switch diff {
        case 0: return "сегодня"
        case 1: return "завтра"
        case -1: return "вчера"
        case let d where d > 0: return "осталось \(d) \(ruDayWord(d))"
        default: return "просрочено на \(-diff) \(ruDayWord(-diff))"
        }
    }

    /// Русское склонение «день/дня/дней» — 11–14 всегда «дней».
    static func ruDayWord(_ n: Int) -> String {
        let n10 = n % 10, n100 = n % 100
        if n10 == 1 && n100 != 11 { return "день" }
        if (2...4).contains(n10) && !(12...14).contains(n100) { return "дня" }
        return "дней"
    }

    /// `formatTimeRange` — «13:45» без длительности, «13:45—14:30» с ней.
    /// Переход через полночь заворачивает конец на следующие сутки без второй даты.
    static func timeRange(start: String, durationMin: Int?) -> String {
        guard let durationMin, durationMin > 0,
              let (h, m) = DateFormats.localTimeComponents(start) else { return start }
        let totalStart = h * 60 + m
        let totalEnd = (totalStart + durationMin) % (24 * 60)
        let endH = totalEnd / 60, endM = totalEnd % 60
        return "\(start)—\(String(format: "%02d:%02d", endH, endM))"
    }

    /// `formatRelativeTime` — для комментариев/журнала.
    static func relativeTime(_ date: Date, now: Date = Date()) -> String {
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "только что" }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes) мин. назад" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) ч. назад" }
        let days = hours / 24
        if days == 1 { return "вчера" }
        return "\(days) дн. назад"
    }

    /// `formatAbsoluteTime` — абсолютное время рядом с относительным (год не пишется).
    static func absoluteTime(_ date: Date, now: Date = Date()) -> String {
        let cal = moscowCalendar()
        let hm = String(format: "%02d:%02d", cal.component(.hour, from: date), cal.component(.minute, from: date))
        if dayDiff(date, from: now) == 0 { return hm }
        let comps = cal.dateComponents([.day, .month], from: date)
        let month = monthsShort[max(0, min(11, (comps.month ?? 1) - 1))]
        return "\(comps.day ?? 1) \(month), \(hm)"
    }

    /// Буквы дней недели для мини-календаря — неделя с понедельника (spec §3.6).
    static let weekdayLetters = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]

    /// `Date → "YYYY-MM-DD"` для `due_date` — В МОСКОВСКОЙ таймзоне, а НЕ
    /// `DateFormats.calendarDateString` (та форматирует в UTC). `dueDate`
    /// в форме собирается как московская полночь (`MiniCalendarView`,
    /// быстрые кнопки «Сегодня»/«Завтра») — московская полночь это 21:00
    /// UTC ПРЕДЫДУЩИХ суток, UTC-форматтер даёт дату на день раньше
    /// выбранной. Разбор входящего `due_date` (`dueDateAsDate`, Core) тоже
    /// в UTC, но UTC-полночь через этот форматтер даёт тот же день — цикл
    /// «прочитать → показать → выбрать → сохранить» замкнут корректно.
    static func calendarDateStringMoscow(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = moscow
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
