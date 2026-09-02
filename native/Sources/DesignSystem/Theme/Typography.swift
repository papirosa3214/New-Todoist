import SwiftUI

// Типографика — шкала из 10 ступеней, spec/DESIGN-TOKENS.md §2.
// Гарнитура одна системная (San Francisco = `Font.system` на native, свой шрифт не заводим).
//
// НЕ перенесено с веба сознательно:
// - фиксированный line-height title-large (32px вместо обычных 1.x) — это
//   защита от обрезки выносных букв браузерным рендерером; SwiftUI текст
//   так не обрезает, поэтому берём обычный `.lineSpacing`, не жёсткий box;
// - letter-spacing (`tracking`) перенесён как есть числом из спеки — там,
//   где на устройстве не будет заметен зазор, можно убрать (спека сама
//   оговаривает это как «эффект уже несёт SF Pro»).
//
// Правило проекта: 16px (`.tfInput`) — ТОЛЬКО для текстовых полей (защита
// от системного зума iOS при фокусе на iOS-вебе; на native зума нет, но
// ступень держим зарезервированной, чтобы визуальный язык не расходился
// с вебом и будущими экранами).
public enum TFFont {
    /// Заголовок корневого экрана (`ScreenHeader variant="large"`).
    public static let titleLarge = Font.system(size: 28, weight: .bold)
    public static let titleLargeTracking: CGFloat = -0.84

    /// Заголовок карточки задачи.
    public static let taskTitle = Font.system(size: 20, weight: .semibold)
    public static let taskTitleTracking: CGFloat = -0.40

    /// Заголовок вторичного экрана/шторки (`variant="compact"`), «Готово» в навбаре.
    public static let title = Font.system(size: 17, weight: .semibold)
    public static let titleTracking: CGFloat = -0.20

    /// ТОЛЬКО текстовые поля — см. предупреждение выше.
    public static let input = Font.system(size: 16, weight: .regular)
    public static let inputTracking: CGFloat = -0.10

    /// Основной текст, название задачи в строке, редактор Дневника.
    public static let body = Font.system(size: 15, weight: .regular)
    public static let bodyTracking: CGFloat = -0.03

    /// Строка списка, пункт меню.
    public static let row = Font.system(size: 14, weight: .regular)

    /// Вторичное действие, подпись под строкой, описание задачи.
    public static let action = Font.system(size: 13, weight: .regular)
    public static let actionTracking: CGFloat = 0.10

    /// Мета-данные, статусы, счётчики, подпись пункта меню создания.
    public static let meta = Font.system(size: 12, weight: .medium)
    public static let metaTracking: CGFloat = 0.14

    /// Мелкая подпись, бейджи/пилюли строки задачи.
    public static let caption = Font.system(size: 11, weight: .medium)
    public static let captionTracking: CGFloat = 0.20

    /// Совсем мелкое: буквы недели, деления графика, счётчик на таббаре.
    public static let micro = Font.system(size: 10, weight: .medium)
    public static let microTracking: CGFloat = 0.25
}

/// Готовые модификаторы «размер + трекинг одним вызовом» — большинство мест
/// в UI используют пару размер/трекинг вместе, дублировать их на каждом Text не нужно.
public extension Text {
    func tfStyle(_ font: Font, tracking: CGFloat = 0) -> Text {
        self.font(font).tracking(tracking)
    }
}

public enum TFTextStyle {
    case titleLarge, taskTitle, title, input, body, row, action, meta, caption, micro

    var font: Font {
        switch self {
        case .titleLarge: TFFont.titleLarge
        case .taskTitle: TFFont.taskTitle
        case .title: TFFont.title
        case .input: TFFont.input
        case .body: TFFont.body
        case .row: TFFont.row
        case .action: TFFont.action
        case .meta: TFFont.meta
        case .caption: TFFont.caption
        case .micro: TFFont.micro
        }
    }

    var tracking: CGFloat {
        switch self {
        case .titleLarge: TFFont.titleLargeTracking
        case .taskTitle: TFFont.taskTitleTracking
        case .title: TFFont.titleTracking
        case .input: TFFont.inputTracking
        case .body: TFFont.bodyTracking
        case .row: 0
        case .action: TFFont.actionTracking
        case .meta: TFFont.metaTracking
        case .caption: TFFont.captionTracking
        case .micro: TFFont.microTracking
        }
    }
}

public extension View {
    /// Применяет ступень шкалы (шрифт + трекинг) целиком. Цвет текста задаётся отдельно —
    /// шкала про размер/начертание, а не про то, где текст первичный/вторичный.
    func tfText(_ style: TFTextStyle) -> some View {
        self.font(style.font).tracking(style.tracking)
    }
}
