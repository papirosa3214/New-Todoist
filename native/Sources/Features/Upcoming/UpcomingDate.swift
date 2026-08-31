import Foundation

// Даты/форматы для «Планирования» — spec/SCREENS-1.md §4.1 (`lib/date.ts`)
// + константы месяцев/дней, снятые буквально с `UpcomingCalendar.tsx` и
// `UpcomingScreen.tsx` (там СВОИ массивы месяцев, отдельные от lib/date.ts —
// см. комментарий у MONTHS_ABBR_DOT в исходнике).
//
// ⚠️ Локальный дубль дневной математики, не общий `Core/DateFormats`: тот
// живёт по таймзоне УСТРОЙСТВА (`todayString()`), а спека §4.1 требует
// «сегодня» строго по Europe/Moscow — расхождение, которое я не вправе
// поправить в Core (правит только каркасный исполнитель). Своя копия здесь,
// чтобы «Планирование» не молчаливо разъезжалось с вебом на устройстве в
// другом часовом поясе. Так же не завишу от `Features/Today` — экраны
// сдаются по одному (`spec/ARCHITECTURE.md` п.1), общий тип оттуда сцепил
// бы сборку моего экрана с чужим файлом.
enum UpcomingDate {
    static let moscow = TimeZone(identifier: "Europe/Moscow")!
    private static let utc = TimeZone(identifier: "UTC")!

    private static var utcCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = utc
        return cal
    }

    /// «Сегодня» строго по МСК (spec §4.1), а не по устройству.
    static func todayString() -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = moscow
        let c = cal.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", c.year ?? 1970, c.month ?? 1, c.day ?? 1)
    }

    /// `YYYY-MM-DD` → полночь UTC (чистая календарная метка, без сдвига по зоне устройства).
    static func calendarDate(_ raw: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = utc
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: raw)
    }

    static func calendarDateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = utc
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func addDays(_ dateStr: String, _ n: Int) -> String {
        guard let d = calendarDate(dateStr), let shifted = utcCalendar.date(byAdding: .day, value: n, to: d) else {
            return dateStr
        }
        return calendarDateString(shifted)
    }

    /// 0=воскресенье … 6=суббота — как `Date.getDay()` в JS (Foundation отдаёт 1=вс…7=сб).
    static func jsWeekday(_ dateStr: String) -> Int {
        guard let d = calendarDate(dateStr) else { return 0 }
        return utcCalendar.component(.weekday, from: d) - 1
    }

    /// Понедельник недели, в которую попадает `dateStr` — spec §3.6, `mondayOf` в `UpcomingCalendar.tsx`.
    static func mondayOf(_ dateStr: String) -> String {
        let dow = jsWeekday(dateStr)
        let shift = dow == 0 ? -6 : -(dow - 1)
        return addDays(dateStr, shift)
    }

    /// «Доминирующий» месяц недели — по ЧЕТВЕРГУ (понедельник+3): неделя на стыке
    /// месяцев принадлежит тому, где лежит её большая часть (spec §5.2, `weekMonth`).
    static func weekMonth(monday: String) -> (year: Int, month: Int) {
        let thursday = addDays(monday, 3)
        guard let d = calendarDate(thursday) else { return (1970, 0) }
        let c = utcCalendar.dateComponents([.year, .month], from: d)
        return (c.year ?? 1970, (c.month ?? 1) - 1) // month здесь 0-based, как JS getMonth()
    }

    /// 42 даты (6 недель по 7 дней) месячной сетки — с понедельника недели,
    /// содержащей 1-е число `month` (0-based) `year`.
    static func monthGridDates(year: Int, month: Int) -> [String] {
        var comps = DateComponents()
        comps.year = year
        comps.month = month + 1
        comps.day = 1
        guard let first = utcCalendar.date(from: comps) else { return [] }
        let dow = utcCalendar.component(.weekday, from: first) - 1 // 0=вс
        let lead = dow == 0 ? 6 : dow - 1
        let startStr = addDays(calendarDateString(first), -lead)
        return (0..<42).map { addDays(startStr, $0) }
    }

    /// Год/месяц (0-based) для `YYYY-MM-DD`.
    static func yearMonth(_ dateStr: String) -> (year: Int, month: Int) {
        guard let d = calendarDate(dateStr) else { return (1970, 0) }
        let c = utcCalendar.dateComponents([.year, .month], from: d)
        return (c.year ?? 1970, (c.month ?? 1) - 1)
    }

    static func day(_ dateStr: String) -> Int {
        guard let d = calendarDate(dateStr) else { return 1 }
        return utcCalendar.component(.day, from: d)
    }

    // MARK: - Тексты

    /// `lib/date.ts` MONTHS_SHORT — родительный падеж БЕЗ точки.
    static let monthsShort = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
    /// `UpcomingCalendar.tsx` MONTHS_NOM — именительный падеж, полные слова (заголовок «Список»/«Неделя»).
    static let monthsNom = [
        "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
        "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
    ]
    /// `UpcomingCalendar.tsx` MONTHS_GEN — родительный падеж (DayStrip/DaySheet: «31 августа»).
    static let monthsGen = [
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ]
    /// `UpcomingScreen.tsx` MONTHS_ABBR_DOT — с точкой, для заголовка ленты/большой сетки списка.
    static let monthsAbbrDot = [
        "Янв.", "Февр.", "Март", "Апр.", "Май", "Июнь",
        "Июль", "Авг.", "Сент.", "Окт.", "Нояб.", "Дек.",
    ]
    /// `WEEKDAYS_SHORT` (`UpcomingCalendar.tsx`) — понедельник первым, заголовки сеток недели/месяца.
    static let weekdaysShort = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    /// `WEEKDAYS` (`UpcomingScreen.tsx`) — то же, ЗАГЛАВНЫМИ, для большой сетки списка.
    static let weekdaysUpper = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"]
    /// `WEEKDAY_LETTERS` (MiniMonth) — одна буква.
    static let weekdayLetters = ["П", "В", "С", "Ч", "П", "С", "В"]
    /// `WEEKDAYS_FULL` — понедельник первым, для DayStrip/DaySheet.
    static let weekdaysFull = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]
    /// Индекс 0=вс…6=сб (JS getDay) → Пн-первым (0…6).
    static func monFirst(_ jsDow: Int) -> Int { (jsDow + 6) % 7 }

    /// `formatTimeRange` (spec §4.1) — «13:45» без длительности, «13:45—14:30» с ней.
    static func formatTimeRange(_ start: String?, _ durationMin: Int?) -> String? {
        guard let start else { return nil }
        guard let durationMin else { return start }
        guard let (h, m) = DateFormats.localTimeComponents(start) else { return start }
        let totalEnd = (h * 60 + m + durationMin) % (24 * 60)
        let eh = totalEnd / 60
        let em = totalEnd % 60
        return "\(start)—\(String(format: "%02d:%02d", eh, em))"
    }

    /// `formatFullDate` (`UpcomingScreen.tsx`) — заголовок дня в виде «Список»:
    /// «20 авг · сегодня · Четверг» / «20 авг · Четверг».
    static func formatFullDate(_ dateStr: String) -> String {
        let (_, month) = yearMonth(dateStr)
        let d = day(dateStr)
        let jsDow = jsWeekday(dateStr)
        let weekday = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"][jsDow]
        let isToday = dateStr == todayString()
        let suffix = isToday ? " · сегодня · \(weekday)" : " · \(weekday)"
        return "\(d) \(monthsShort[month])\(suffix)"
    }

    /// `formatDayColumnLabel` (`DayHours.tsx`) — «Ср 19», заголовок колонки дня в виде «Три дня».
    static func formatDayColumnLabel(_ dateStr: String) -> String {
        let jsDow = jsWeekday(dateStr)
        return "\(["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][jsDow]) \(day(dateStr))"
    }

    /// `groupByDate` (`UpcomingCalendar.tsx`) — один проход по списку вместо
    /// фильтра на каждую ячейку сетки; внутри дня — по времени начала, задачи
    /// без времени идут первыми (`nil` сортируется раньше любой строки "HH:MM").
    static func groupByDate(_ tasks: [ApiTask]) -> [String: [ApiTask]] {
        var map: [String: [ApiTask]] = [:]
        for t in tasks {
            guard let due = t.dueDate else { continue }
            map[due, default: []].append(t)
        }
        for key in map.keys {
            map[key]?.sort { ($0.startTime ?? "") < ($1.startTime ?? "") }
        }
        return map
    }
}
