import Foundation

// Форматы дат для раздела «Справочники» — свой локальный набор, а не импорт
// `Features/Today/TodayDate.swift` или `Features/Task/Support/TaskDateText.swift`
// (те чужие папки; писать в них нельзя, ARCHITECTURE.md правило 1). Тот же
// принцип дублирования уже применён в `TodayDate.swift` (её собственный
// комментарий объясняет, почему: у Core нет human-readable форматов, только
// парсинг). Раздел в отчёте — оркестратору свести все три копии.
//
// ⚠️ Группировка «Сегодня/Вчера» на экране Активности — ЕДИНСТВЕННОЕ место
// в этом файле, где день считается по таймзоне УСТРОЙСТВА, а не Москвы:
// сверено с живым `src/screens/ActivityScreen.tsx` (`dayKey` берёт
// `d.getFullYear()/getMonth()/getDate()` — локальные геттеры JS Date, то
// есть таймзона браузера/устройства). Уведомления и «срок» задачи, наоборот,
// парсятся в UTC/календарной дате — см. функции ниже, у каждой свой комментарий.
enum DirectoryDate {

    static let monthsShort = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
    static let monthsGenitiveFull = [
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    ]

    // MARK: - «31 авг» — короткая дата срока задачи (LabelTasksScreen/ProjectTasksScreen)

    /// `due_date` — календарная дата без времени, парсится в UTC (та же
    /// логика, что `Core/Common/DateFormats.calendarDate`) — чисто метка
    /// дня, не момент времени.
    static func dueShort(_ dueDate: String) -> String {
        guard let date = DateFormats.calendarDate(dueDate) else { return dueDate }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let comps = calendar.dateComponents([.day, .month], from: date)
        guard let day = comps.day, let month = comps.month else { return dueDate }
        return "\(day) \(monthsShort[month - 1])"
    }

    // MARK: - Уведомления: «вчера · 30 авг, 11:41» — относительное + абсолютное,
    // московское время (спека `lib/date.ts` §4.1, как и остальные human-readable
    // подписи в приложении — `created_at` парсится через `DateFormats.sqliteUTC`).

    static var moscow: TimeZone { TimeZone(identifier: "Europe/Moscow") ?? .current }

    static func relative(_ date: Date, now: Date = Date()) -> String {
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

    static func absolute(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = moscow
        let comps = calendar.dateComponents([.day, .month, .hour, .minute], from: date)
        let hm = String(format: "%02d:%02d", comps.hour ?? 0, comps.minute ?? 0)
        let month = monthsShort[max(0, min(11, (comps.month ?? 1) - 1))]
        return "\(comps.day ?? 1) \(month), \(hm)"
    }

    // MARK: - Строка задачи (ProjectTasksScreen/LabelTasksScreen) — `lib/date.ts`,
    // те же формулы, что `TodayDate.swift` (тот файл чужой, Features/Today —
    // дубль по тому же принципу, что и весь этот файл, см. шапку). Московское
    // время, НЕ таймзона устройства — «сегодня» в `daysUntil` должно совпадать
    // с тем, что покажет `/today` на другом телефоне в другом поясе.

    /// «31 авг» — обычный бейдж срока строки задачи (`formatDue` в `TaskRow.tsx`).
    static func formatDuePlain(_ dueDate: String) -> String {
        dueShort(dueDate)
    }

    /// МСК-«сегодня» как `YYYY-MM-DD` — та же формула, что `TodayDate.todayString()`.
    private static func todayStringMoscow() -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = moscow
        let comps = calendar.dateComponents([.year, .month, .day], from: Date())
        return String(format: "%04d-%02d-%02d", comps.year ?? 1970, comps.month ?? 1, comps.day ?? 1)
    }

    /// 0 — сегодня, 1 — завтра, отрицательное — просрочено (МСК).
    static func daysUntil(_ dueDate: String) -> Int {
        guard let target = calendarDate(dueDate), let base = calendarDate(todayStringMoscow()) else { return 0 }
        let seconds = target.timeIntervalSince(base)
        return Int((seconds / 86_400).rounded())
    }

    /// «осталось 3 дня» / «сегодня» / «завтра» / «вчера» / «просрочено на N дней».
    static func formatDaysLeft(_ dueDate: String) -> String {
        let d = daysUntil(dueDate)
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

    /// Календарная дата в UTC-полночь из `YYYY-MM-DD` — тот же парсер, что
    /// `dueShort` использует неявно через `DateFormats.calendarDate`.
    private static func calendarDate(_ raw: String) -> Date? {
        DateFormats.calendarDate(raw)
    }

    // MARK: - Активность: группировка выполненных задач по дню — ЛОКАЛЬНАЯ
    // таймзона устройства (см. предупреждение в шапке файла).

    /// `YYYY-MM-DD` по календарю УСТРОЙСТВА — ключ группы.
    static func dayKeyLocal(_ date: Date) -> String {
        let calendar = Calendar.current
        let comps = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", comps.year ?? 1970, comps.month ?? 1, comps.day ?? 1)
    }

    static func todayKeyLocal() -> String { dayKeyLocal(Date()) }

    static func addDaysLocal(_ key: String, _ days: Int) -> String {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return key }
        var calendar = Calendar.current
        calendar.timeZone = .current
        var comps = DateComponents()
        comps.year = parts[0]; comps.month = parts[1]; comps.day = parts[2]
        guard let base = calendar.date(from: comps),
              let shifted = calendar.date(byAdding: .day, value: days, to: base) else { return key }
        return dayKeyLocal(shifted)
    }

    /// «Сегодня» / «Вчера» / «31 августа» — заголовок группы CompletedTaskCard.
    static func groupLabel(_ key: String, today: String, yesterday: String) -> String {
        if key == today { return "Сегодня" }
        if key == yesterday { return "Вчера" }
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3, parts[1] >= 1, parts[1] <= 12 else { return key }
        return "\(parts[2]) \(monthsGenitiveFull[parts[1] - 1])"
    }

    /// «18:28» — время выполнения на карточке (локальное устройство, как в вебе).
    static func timeLocal(_ date: Date) -> String {
        let calendar = Calendar.current
        let comps = calendar.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", comps.hour ?? 0, comps.minute ?? 0)
    }
}
