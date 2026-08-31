import SwiftUI

// Бейджи/пилюли строки задачи — spec/DESIGN-TOKENS.md §4 «Строка задачи».
// Пилюля: px-2 py-0.5 (8px/2px), радиус `rounded` (4px, служебный — вне
// основной шкалы, самый мелкий элемент интерфейса), текст 11px (caption).
public struct TFPill: View {
    let text: String
    let color: Color
    /// Доля альфы фона под текстом — приоритет/просрочка используют разные значения (15% против 26≈15%).
    let backgroundOpacity: Double
    /// Фон = `card` (срок), а не цвет + альфа — единственное исключение из общего правила пилюли.
    let solidBackground: Color?

    public init(_ text: String, color: Color, backgroundOpacity: Double = 0.15, solidBackground: Color? = nil) {
        self.text = text
        self.color = color
        self.backgroundOpacity = backgroundOpacity
        self.solidBackground = solidBackground
    }

    public var body: some View {
        Text(text)
            .tfText(.caption)
            .foregroundStyle(solidBackground == nil ? color : Color.tfText)
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, 2)
            .background(solidBackground ?? color.opacity(backgroundOpacity))
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
    }
}

/// Флаг приоритета (12px иконка, цвет из таблицы `TaskPriority`) — используется
/// без подложки, просто цветной значок в ряду бейджей строки.
public struct TFPriorityFlag: View {
    let priority: TaskPriority

    public init(_ priority: TaskPriority) {
        self.priority = priority
    }

    public var body: some View {
        Image(systemName: "flag.fill")
            .font(.system(size: 12))
            .foregroundStyle(priority.color)
    }
}

/// Метка (label) — пилюля, фон = цвет метки + альфа `26`(hex)≈15%, как в спеке.
public struct TFLabelPill: View {
    let title: String
    let color: Color

    public init(_ title: String, color: Color) {
        self.title = title
        self.color = color
    }

    public var body: some View {
        TFPill(title, color: color, backgroundOpacity: 0.15)
    }
}

/// «Просрочено» — фиксированная пилюля `red`/15%, текст тот же цвет.
public struct TFOverduePill: View {
    public init() {}
    public var body: some View {
        TFPill("Просрочено", color: .tfRed, backgroundOpacity: 0.15)
    }
}

/// Срок (дата/время) — фон `card` (не альфа акцента), текст `sub`.
public struct TFDuePill: View {
    let text: String
    public init(_ text: String) { self.text = text }
    public var body: some View {
        Text(text)
            .tfText(.caption)
            .foregroundStyle(Color.tfSub)
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, 2)
            .background(Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
    }
}

/// Тег раздела «Second Brain» и подобные акцентные плашки на карточках
/// (`overview.png` — «SECOND BRAIN» на карточке «Сводка недели») — та же
/// геометрия пилюли, но фон/текст берутся снаружи, а не выводятся из токена.
public struct TFAccentTag: View {
    let text: String
    let color: Color

    public init(_ text: String, color: Color) {
        self.text = text
        self.color = color
    }

    public var body: some View {
        Text(text)
            .tfText(.caption)
            .fontWeight(.semibold)
            .foregroundStyle(color)
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, 2)
            .background(color.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
    }
}

#Preview("Бейджи") {
    VStack(alignment: .leading, spacing: TFSpacing.md) {
        HStack(spacing: TFSpacing.sm) {
            TFPriorityFlag(.urgent)
            TFPriorityFlag(.high)
            TFPriorityFlag(.medium)
            TFPriorityFlag(.low)
        }
        HStack(spacing: TFSpacing.sm) {
            TFOverduePill()
            TFDuePill("Завтра, 14:00")
            TFLabelPill("Важно", color: .tfRed)
            TFLabelPill("UX/UI", color: .tfPurple)
        }
        TFAccentTag("SECOND BRAIN", color: .tfPink)
    }
    .padding()
    .background(Color.tfBackground)
}
