import Foundation

// Форматы дат для «Сегодня»/«Лента дня» — spec/SCREENS-1.md §4.1 (`lib/date.ts`).
//
// ⚠️ Локальный дубль, а не `DateFormats.todayString()` из Core: спека §4.1
// требует «сегодня» строго по московскому времени (Europe/Moscow), а живой
// `Core/Common/DateFormats.swift` считает по таймзоне УСТРОЙСТВА — расхождение
// со спекой, которое я не могу поправить (файл чужой, Core правит только
// каркасный исполнитель). Здесь — правильный по спеке вариант, локально для
// этого экрана; `RootShellView` (бейдж таббара «Сегодня») тем временем
// продолжает считать по устройству — сказано в отчёте, сводить оркестратору.
enum TodayDate {
    static let moscow = TimeZone(identifier: "Europe/Moscow")!

    /// «Сегодня» строго по МСК, независимо от таймзоны телефона (spec §4.1).
    static func todayString() -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = moscow
        let comps = calendar.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", comps.year ?? 1970, comps.month ?? 1, comps.day ?? 1)
    }

    static func addDays(_ dateStr: String, _ days: Int) -> String {
        guard let date = calendarDate(dateStr) else { return dateStr }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let shifted = calendar.date(byAdding: .day, value: days, to: date) else { return dateStr }
        return calendarDateString(shifted)
    }

    /// Разбор `YYYY-MM-DD` в UTC-полночь — чисто календарная метка, без сдвига по зоне устройства.
    static func calendarDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: raw)
    }

    static func calendarDateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    /// Родительный падеж без точки — «янв, фев, … , авг, …».
    static let monthsShort = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
    static let weekdaysFull = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"]
    static let weekdaysShort = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]

    private static func dayMonth(_ dateStr: String) -> (day: Int, month: String, year: Int, weekday: Int)? {
        guard let d = calendarDate(dateStr) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let comps = calendar.dateComponents([.day, .month, .year, .weekday], from: d)
        guard let day = comps.day, let month = comps.month, let year = comps.year, let weekday = comps.weekday else { return nil }
        // Calendar.weekday: 1=воскресенье…7=суббота — совпадает с индексом weekdaysFull.
        return (day, monthsShort[month - 1], year, weekday - 1)
    }

    /// «Сегодня, 31 авг.» / «Завтра, 1 сен.» / «31 авг.» / «31 авг 2027» (другой год).
    static func formatDueLabel(_ dateStr: String) -> String {
        guard let (day, month, year, _) = dayMonth(dateStr) else { return dateStr }
        let today = todayString()
        let tomorrow = addDays(today, 1)
        if dateStr == today { return "Сегодня, \(day) \(month)." }
        if dateStr == tomorrow { return "Завтра, \(day) \(month)." }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = moscow
        let currentYear = calendar.component(.year, from: Date())
        if year != currentYear { return "\(day) \(month) \(year)" }
        return "\(day) \(month)."
    }

    /// «Вторник 1» — старый формат крупного заголовка. Оставлен для мест,
    /// которым действительно нужны и день недели, и число.
    static func formatWeekdayDateLabel(_ dateStr: String) -> String {
        guard let (day, _, _, weekday) = dayMonth(dateStr) else { return dateStr }
        return "\(weekdaysFull[weekday]) \(day)"
    }

    /// «Вторник» — крупный заголовок «Сегодня». Число намеренно не дублируем:
    /// оно появляется только в компактной дате («1 сентября») после схлопывания
    /// большого заголовка.
    static func formatWeekdayLabel(_ dateStr: String) -> String {
        guard let (_, _, _, weekday) = dayMonth(dateStr) else { return dateStr }
        return weekdaysFull[weekday]
    }

    /// «1 сентября» — компактная дата в схлопнутой шапке: месяц целиком.
    static func formatDayMonthFull(_ dateStr: String) -> String {
        guard let (day, _, _, _) = dayMonth(dateStr), let d = calendarDate(dateStr) else { return dateStr }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = moscow
        let index = calendar.component(.month, from: d) - 1
        return "\(day) \(monthsGenitive[index])"
    }

    static let monthsGenitive = ["января", "февраля", "марта", "апреля", "мая", "июня",
                                 "июля", "августа", "сентября", "октября", "ноября", "декабря"]

    /// «31 авг. · Понедельник» — заголовок колонки «Сегодня» на доске (spec §5.1, formatColumnDateLabel).
    static func formatColumnDateLabel(_ dateStr: String) -> String {
        guard let (day, month, _, weekday) = dayMonth(dateStr) else { return dateStr }
        return "\(day) \(month). · \(weekdaysFull[weekday])"
    }

    /// «Чт 31» — подпись колонки дня в виде «часы» (DayColumnsHeader, здесь не используется —
    /// «Сегодня» всегда одна колонка, но оставлено для точности со спекой §3.5).
    static func formatDayColumnLabel(_ dateStr: String) -> String {
        guard let (day, _, _, weekday) = dayMonth(dateStr) else { return dateStr }
        return "\(weekdaysShort[weekday]) \(day)"
    }

    /// Сколько суток до срока: 0 — сегодня, 1 — завтра, отрицательное — просрочено.
    static func daysUntil(_ dateStr: String) -> Int {
        guard let target = calendarDate(dateStr), let base = calendarDate(todayString()) else { return 0 }
        let seconds = target.timeIntervalSince(base)
        return Int((seconds / 86_400).rounded())
    }

    /// «осталось 3 дня» / «сегодня» / «просрочено на 2 дня».
    static func formatDaysLeft(_ dateStr: String) -> String {
        let d = daysUntil(dateStr)
        if d == 0 { return "сегодня" }
        if d == 1 { return "завтра" }
        if d == -1 { return "вчера" }
        let n = abs(d)
        let hundred = n % 100
        let unit = n % 10
        let word: String
        if hundred >= 11 && hundred <= 14 { word = "дней" }
        else if unit == 1 { word = "день" }
        else if unit >= 2 && unit <= 4 { word = "дня" }
        else { word = "дней" }
        return d > 0 ? "осталось \(n) \(word)" : "просрочено на \(n) \(word)"
    }

    /// Простая дата без относительного префикса — «31 авг» (обычный бейдж срока в строке задачи).
    static func formatDuePlain(_ dateStr: String) -> String {
        guard let (day, month, _, _) = dayMonth(dateStr) else { return dateStr }
        return "\(day) \(month)"
    }
}
