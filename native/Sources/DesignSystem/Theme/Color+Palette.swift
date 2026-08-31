import SwiftUI

// Палитра TaskFlow — числа 1:1 из spec/DESIGN-TOKENS.md §1, не подбирались на глаз.
//
// Токены поверхности (bg/card/card2/stroke/text/sub/dim) — единственные 7,
// которые меняются между тёмной и светлой темой (спека §7). Акцентные цвета
// одинаковы в обеих темах намеренно — это цвета приоритетов/меток/статусов,
// не оформления поверхности, поэтому у них нет dark/light-варианта.
//
// project.yml сейчас принудительно ставит UIUserInterfaceStyle: Dark (правка
// вне этой папки), поэтому светлая тема на живом приложении пока недостижима —
// но токены заведены оба, как того требует спека, и видны через
// `.environment(\.colorScheme, .light)` в превью.
public extension Color {

    /// Строит динамический цвет: разные hex для тёмной/светлой темы, как в web `:root[data-theme]`.
    private static func dynamic(dark: String, light: String) -> Color {
        Color(uiColor: UIColor { trait in
            trait.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
    }

    // MARK: Поверхность (переключается темой)

    /// Фон экрана, самый нижний слой глубины.
    static let tfBackground = dynamic(dark: "#171717", light: "#f4f4f5")
    /// Поверхность: карточки, шапка, шторка, поле, панель таббара.
    static let tfCard = dynamic(dark: "#242424", light: "#ffffff")
    /// Элемент внутри карточки: подложка тумблера, выпадающее меню, чип.
    static let tfCard2 = dynamic(dark: "#2b2b2b", light: "#ececee")
    /// Основной текст, активная иконка таббара.
    static let tfText = dynamic(dark: "#ffffff", light: "#171717")
    /// Вторичный текст (подписи, второй уровень важности).
    static let tfSub = dynamic(dark: "#a6a6a6", light: "#5c5c5c")
    /// Третий уровень: подписи "можно не читать", неактивная иконка таббара.
    static let tfDim = dynamic(dark: "#949494", light: "#9a9a9a")

    /// Единственная граница/разделитель — полупрозрачная белая (тёмная) / чёрная (светлая), не сплошной цвет.
    static let tfStroke = Color(uiColor: UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor.white.withAlphaComponent(0.09)
            : UIColor.black.withAlphaComponent(0.09)
    })

    // MARK: Акценты (одинаковы в обеих темах)

    /// Единственный акцент приложения — активная вкладка/пункт, «сегодня», просрочка, удаление.
    /// Как заливку под белый текст НЕ использовать — контраст 4.08:1, ниже нормы 4.5. См. `tfRedSolid`.
    static let tfRed = Color(hex: "#e44332")
    /// Заливка ИМЕННО под белый текст 15px/600 (`Button variant="primary"`) — контраст 4.67:1.
    static let tfRedSolid = Color(hex: "#d63a28")
    /// Приоритет P2, предупреждения.
    static let tfOrange = Color(hex: "#ff9a14")
    /// Прикладной цвет меток/категорий.
    static let tfPink = Color(hex: "#ff7a8a")
    /// Приоритет P3, статус «на проверке».
    static let tfBlue = Color(hex: "#4a9fd8")
    /// Прикладной цвет меток/категорий.
    static let tfPurple = Color(hex: "#a78bfa")
    /// Прикладной цвет; маркер-выделитель в заметках.
    static let tfYellow = Color(hex: "#f7d038")
    /// Ошибки, «агент пропал» — тревожное состояние, не путать с `tfRed`-акцентом.
    static let tfCoral = Color(hex: "#ff6b6b")
    /// Статус «в работе» (агент), единый зелёный/бирюзовый акцент состояния.
    static let tfTeal = Color(hex: "#35b8a3")
    /// Тот же смысловой ряд, что teal — темнее и насыщеннее.
    static let tfGreen = Color(hex: "#15937e")

    // MARK: Служебные — вне токенов темы, не переключаются намеренно (системные/брендовые)

    /// Свайп-действие строки задачи «Изменить» — буквальный iOS-цвет жеста.
    static let tfSwipeEdit = Color(hex: "#007AFF")
    /// Свайп-действие строки задачи «Удалить» — буквальный iOS-цвет жеста.
    static let tfSwipeDelete = Color(hex: "#FF3B30")
}

/// Приоритеты задач — отдельная константа (`lib/priority.ts` в вебе), не завязана на токены темы:
/// буквальные hex для API/иконки, одинаковы в обеих темах.
public enum TaskPriority: Int, CaseIterable, Sendable {
    case urgent = 1   // P1 «Срочный»
    case high = 2     // P2 «Высокий»
    case medium = 3   // P3 «Средний»
    case low = 4      // P4 «Низкий»

    public var color: Color {
        switch self {
        case .urgent: Color(hex: "#E44332")
        case .high: Color(hex: "#FF9A14")
        case .medium: Color(hex: "#4A9FD8")
        case .low: Color(hex: "#A6A6A6")
        }
    }

    public var label: String {
        switch self {
        case .urgent: "Срочный"
        case .high: "Высокий"
        case .medium: "Средний"
        case .low: "Низкий"
        }
    }
}

// MARK: - Hex → UIColor/Color

extension UIColor {
    /// Парсер `#RRGGBB` — единственный способ завести цвет в проекте (спека: hex-литералы только тут, не в разметке экранов).
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var rgb: UInt64 = 0
        Scanner(string: s).scanHexInt64(&rgb)
        if s.count < 6 { s = String(repeating: "0", count: 6 - s.count) + s }
        let r = Double((rgb >> 16) & 0xFF) / 255
        let g = Double((rgb >> 8) & 0xFF) / 255
        let b = Double(rgb & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}

public extension Color {
    /// Тот же парсер для мест, где нужен именно `Color`, а не `UIColor` (акценты без dark/light-варианта).
    init(hex: String) {
        self.init(uiColor: UIColor(hex: hex))
    }
}
