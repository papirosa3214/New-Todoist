import Foundation

// Относительное/абсолютное время сообщений и активности — 1:1 портирование
// `src/lib/date.ts` (`formatRelativeTime`/`formatAbsoluteTime`), потому что
// в spec/DESIGN-TOKENS.md готовой формулы нет, а числа в скриншоте
// (chat.png: «3 дн. назад · 29 авг, 04:49») — вывод именно этих двух
// функций. Общий помощник, а не приватный кусок ChatBubble: тем же форматом
// пользуются и агенты (AgentRow — «последнее действие»), и любой будущий
// экран этой папки.
enum RelativeTime {

    /// «5 мин. назад» / «вчера» — веб (`date.ts`) считает от локальных часов
    /// устройства, без таймзоны — переносим буквально.
    static func relative(from date: Date) -> String {
        let diffMin = Int((Date().timeIntervalSince(date) / 60).rounded())
        if diffMin < 1 { return "только что" }
        if diffMin < 60 { return "\(diffMin) мин. назад" }
        let diffH = Int((Double(diffMin) / 60).rounded())
        if diffH < 24 { return "\(diffH) ч. назад" }
        let diffD = Int((Double(diffH) / 24).rounded())
        if diffD == 1 { return "вчера" }
        return "\(diffD) дн. назад"
    }

    /// «02:50» (сегодня) / «28 авг, 23:15» (раньше) — ПО МОСКВЕ, буквально
    /// как в вебе (`formatAbsoluteTime`): показывает не таймзону устройства,
    /// а московское время события, чтобы можно было сверить с «5 мин назад».
    /// Год не показываем — та же причина, что в вебе (виден в шапке ленты).
    static func absoluteMoscow(from date: Date) -> String {
        let moscow = TimeZone(identifier: "Europe/Moscow")!
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = moscow

        let comps = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let hh = String(format: "%02d", comps.hour ?? 0)
        let mm = String(format: "%02d", comps.minute ?? 0)

        let todayComps = cal.dateComponents([.year, .month, .day], from: Date())
        let sameDay = comps.year == todayComps.year && comps.month == todayComps.month && comps.day == todayComps.day
        if sameDay { return "\(hh):\(mm)" }

        // Родительный падеж-сокращение месяца — как в ru-RU Intl вывод веба
        // («29 авг», «5 мая»), не системные символы DateFormatter (те дают
        // другую форму, напр. «февр.»).
        let months = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
        let day = comps.day ?? 1
        let month = months[max(0, min(11, (comps.month ?? 1) - 1))]
        return "\(day) \(month), \(hh):\(mm)"
    }
}
