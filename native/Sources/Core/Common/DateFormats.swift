import Foundation

/// Единая точка разбора дат сервера — spec/API.md §1: ТРИ разных формата,
/// не путать. Форматтеры переиспользуются под общей блокировкой: создание
/// `DateFormatter` дорого и раньше происходило для каждой видимой строки при
/// каждом проходе SwiftUI body. Блокировка сохраняет корректность, если
/// парсинг однажды будет вызван не только с главного потока.
public enum DateFormats {
    private static let formatterLock = NSLock()

    private static let sqliteFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    private static let calendarFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let localDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = .autoupdatingCurrent
        formatter.locale = .autoupdatingCurrent
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static func locked<T>(_ work: () -> T) -> T {
        formatterLock.lock()
        defer { formatterLock.unlock() }
        return work()
    }

    /// `created_at`/`updated_at`/`completed_at`/... — SQLite `DATETIME('now')`,
    /// UTC, БЕЗ суффикса `T`/`Z` (пример: `"2026-08-31 12:00:00"`). Наивный
    /// `Date(from:)` в Swift распознал бы это как ЛОКАЛЬНОЕ время — здесь
    /// явно фиксируем UTC, как предписывает спека.
    ///
    /// Живой сервер проверен 31.08.2026: `users.last_seen_at` (добавлено мимо
    /// системы миграций, см. spec/API.md §12 п.6) реально приходит в ДРУГОМ
    /// формате — полный ISO8601 с миллисекундами и суффиксом `Z`
    /// (`"2026-08-31T16:22:53.438Z"`), не как остальные `*_at`. Поэтому здесь
    /// пробуем sqlite-формат первым, ISO8601 — запасным вариантом.
    public static func sqliteUTC(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        if let date = locked({ sqliteFormatter.date(from: raw) }) { return date }
        return iso8601(raw)
    }

    /// Полноценный ISO8601, опционально с миллисекундами — на практике встречен
    /// у `last_seen_at` (проверено живым запросом к :3001, 31.08.2026).
    public static func iso8601(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return locked {
            isoWithFraction.date(from: raw) ?? isoPlain.date(from: raw)
        }
    }

    /// `due_date` — календарная дата БЕЗ времени, `YYYY-MM-DD`. Разбирается в
    /// UTC намеренно: это чистая календарная метка ("31 августа"), а не момент
    /// времени — парсинг в локальной таймзоне устройства мог бы съехать на
    /// соседний день у пользователей восточнее UTC ближе к полуночи.
    public static func calendarDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return locked { calendarFormatter.date(from: raw) }
    }

    /// Обратное преобразование — `Date` → `YYYY-MM-DD` для отправки в `due_date`.
    public static func calendarDateString(_ date: Date) -> String {
        locked { calendarFormatter.string(from: date) }
    }

    /// Сегодняшняя календарная дата в формате `YYYY-MM-DD` — для сравнения с
    /// `due_date` (бейдж таббара «Сегодня», экран «Сегодня»). Намеренно системная
    /// таймзона устройства, НЕ UTC: due_date — это про календарный день
    /// пользователя, а не абсолютный момент.
    public static func todayString() -> String {
        locked {
            localDayFormatter.calendar = .autoupdatingCurrent
            localDayFormatter.timeZone = .autoupdatingCurrent
            return localDayFormatter.string(from: Date())
        }
    }

    /// `start_time` — `HH:MM`, локальное время суток, НЕ привязано к таймзоне.
    /// Разбирается в компоненты, а не в `Date` — абсолютного момента тут нет,
    /// это "на какой час дня" ставить блок в календаре (spec §1).
    public static func localTimeComponents(_ raw: String?) -> (hour: Int, minute: Int)? {
        guard let raw, let colonIndex = raw.firstIndex(of: ":") else { return nil }
        let hourPart = raw[raw.startIndex..<colonIndex]
        let minutePart = raw[raw.index(after: colonIndex)...]
        guard let hour = Int(hourPart), let minute = Int(minutePart) else { return nil }
        return (hour, minute)
    }
}
