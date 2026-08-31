import SwiftUI

// Карточка/секция и мелкие структурные примитивы — из общих правил спеки
// (радиус `xl`=16 для карточек, толщина границы 1px `stroke`, отступ экрана 16px).

/// Обёртка карточки общего назначения (статистика в «Обзоре», пункты списка
/// настроек и т.п.) — фон `card`, радиус 16px, без рамки по умолчанию (рамка
/// нужна только там, где карточка на том же фоне, что и подложка — задаётся снаружи).
public struct TFCard<Content: View>: View {
    let content: Content
    let padding: CGFloat

    public init(padding: CGFloat = TFSpacing.lg, @ViewBuilder content: () -> Content) {
        self.padding = padding
        self.content = content()
    }

    public var body: some View {
        content
            .padding(padding)
            .background(Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }
}

/// Заголовок секции (капс/приглушённый текст над группой карточек — «Пользовательские
/// настройки», «Общие» на settings.png). Не своя карточка, просто текст с отступами экрана.
public struct TFSectionHeader: View {
    let title: String
    public init(_ title: String) { self.title = title }
    public var body: some View {
        Text(title)
            .tfText(.action)
            .foregroundStyle(Color.tfSub)
            .padding(.horizontal, TFSpacing.screenHorizontal)
    }
}

/// Строка настроек/справочника с цветным квадратом-иконкой слева, заголовком,
/// подписью и шевроном справа (settings.png, overview.png) — универсальный
/// «пункт меню», из которого собираются списки настроек/справочников.
public struct TFListRow: View {
    let icon: String
    let iconTint: Color
    let title: String
    let subtitle: String?
    let trailing: AnyView?
    let action: (() -> Void)?

    public init(
        icon: String,
        iconTint: Color = .tfRed,
        title: String,
        subtitle: String? = nil,
        trailing: AnyView? = nil,
        action: (() -> Void)? = nil
    ) {
        self.icon = icon
        self.iconTint = iconTint
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing
        self.action = action
    }

    public var body: some View {
        let row = HStack(spacing: TFSpacing.md) {
            RoundedRectangle(cornerRadius: TFRadius.md)
                .fill(iconTint.opacity(0.18))
                .frame(width: 40, height: 40)
                .overlay {
                    Image(systemName: icon)
                        .font(.system(size: TFIconSize.sm))
                        .foregroundStyle(iconTint)
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .tfText(.body)
                    .foregroundStyle(Color.tfText)
                if let subtitle {
                    Text(subtitle)
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                        .lineLimit(1)
                }
            }
            Spacer()
            if let trailing {
                trailing
            } else if action != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.tfDim)
            }
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.vertical, TFSpacing.md)
        .contentShape(Rectangle())

        if let action {
            Button(action: action) { row }.buttonStyle(TFTapRowStyle())
        } else {
            row
        }
    }
}

/// Разделитель между строками внутри карточки-списка (`TFListRow` и подобных) —
/// 1px `stroke`, вставляется вручную между строками (спека держит инсет
/// разный по месту, поэтому не делаем это неявным поведением контейнера).
///
/// `dimmed` — вариант `stroke/50` (спека §4 «Строка задачи»: разделитель между
/// строками списка задач вдвое прозрачнее обычного, Tailwind `/50` умножает
/// альфу цвета на 50%, а не задаёт непрозрачность заново).
public struct TFDivider: View {
    let inset: CGFloat
    let dimmed: Bool
    public init(inset: CGFloat = 0, dimmed: Bool = false) {
        self.inset = inset
        self.dimmed = dimmed
    }
    public var body: some View {
        Rectangle()
            .fill(Color.tfStroke.opacity(dimmed ? 0.5 : 1))
            .frame(height: TFBorder.width)
            .padding(.leading, inset)
    }
}

#Preview("Карточки и списки") {
    ScrollView {
        VStack(alignment: .leading, spacing: TFSpacing.xl) {
            TFSectionHeader("Пользовательские настройки")
            TFCard(padding: 0) {
                VStack(spacing: 0) {
                    TFListRow(icon: "moon", title: "Тема", trailing: AnyView(Text("Тёмная").tfText(.body).foregroundStyle(Color.tfSub)))
                    TFDivider(inset: TFSpacing.lg + 40 + TFSpacing.md)
                    TFListRow(icon: "photo", title: "Иконка", trailing: AnyView(Text("Pure Minimal Glass").tfText(.body).foregroundStyle(Color.tfSub)), action: {})
                }
            }
        }
        .padding(.vertical, TFSpacing.lg)
    }
    .background(Color.tfBackground)
}
