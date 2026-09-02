import SwiftUI

// Кнопки — spec/DESIGN-TOKENS.md §4 «Кнопки». Три вида, все 48px/12px радиус/15px 600.
// Нажатие — не тень/подъём, а `tap-scale` (0.94, мгновенно, без анимации на снятие);
// на native ближайший честный эквивалент — `.scaleEffect` без implicit animation delay.
public enum TFButtonVariant {
    case primary   // red-solid фон (НЕ tfRed — контраст под белый текст, см. Color+Palette)
    case secondary // card2 фон + рамка stroke
    case outline   // прозрачный фон + рамка stroke, текст sub

    var background: Color {
        switch self {
        case .primary: .tfRedSolid
        case .secondary: .tfCard2
        case .outline: .clear
        }
    }

    var foreground: Color {
        switch self {
        case .primary: .white
        case .secondary: .tfText
        case .outline: .tfSub
        }
    }

    var hasStroke: Bool {
        switch self {
        case .primary: false
        case .secondary, .outline: true
        }
    }
}

/// Полноширинная кнопка (`Button`, UI.tsx). Иконка опциональна — используется,
/// например, в «Завершить задачу» (check 16px) / «Открыть заново» (sync).
public struct TFButton: View {
    let title: String
    let icon: String?
    let variant: TFButtonVariant
    let isEnabled: Bool
    let action: () -> Void

    @State private var isPressed = false

    public init(
        _ title: String,
        icon: String? = nil,
        variant: TFButtonVariant = .primary,
        isEnabled: Bool = true,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.icon = icon
        self.variant = variant
        self.isEnabled = isEnabled
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: TFSpacing.sm) {
                if let icon {
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                }
                Text(title)
                    .tfText(.body)
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .frame(height: TFButtonMetrics.height)
            .foregroundStyle(variant.foreground)
            .background(variant.background)
            .overlay {
                if variant.hasStroke {
                    RoundedRectangle(cornerRadius: TFButtonMetrics.radius)
                        .strokeBorder(Color.tfStroke, lineWidth: TFBorder.width)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: TFButtonMetrics.radius))
        }
        .buttonStyle(TFTapScaleStyle())
        .opacity(isEnabled ? 1 : 0.5)
        .disabled(!isEnabled)
    }
}

/// Кнопка-иконка (`background: transparent`, зона 44×44, иконка 18px) — шапка экрана,
/// действия в бейджах/строках. Отклик `tap-scale`.
public struct TFIconButton: View {
    let icon: String
    let size: CGFloat
    let action: () -> Void

    public init(_ icon: String, size: CGFloat = TFIconSize.sm, action: @escaping () -> Void) {
        self.icon = icon
        self.size = size
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: size, weight: .regular))
                .foregroundStyle(Color.tfText)
                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                .contentShape(Rectangle())
        }
        .buttonStyle(TFTapScaleStyle())
    }
}

/// `tap-scale`: scale(0.94) мгновенно на нажатие, без анимации на отпускание —
/// снимается «щелчком», не плавным возвратом (спека §4 «Кнопки»).
public struct TFTapScaleStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}

/// `tap-row`: подсветка фона строки списка/карточки при нажатии.
public struct TFTapRowStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.white.opacity(0.04) : .clear)
    }
}

/// `tap-fade`: полноширинные CTA/текстовые ссылки — просадка непрозрачности, не масштаба.
public struct TFTapFadeStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

#Preview("Кнопки") {
    VStack(spacing: TFSpacing.md) {
        TFButton("Завершить задачу", icon: "checkmark", variant: .primary) {}
        TFButton("Открыть задачу заново", icon: "arrow.triangle.2.circlepath", variant: .secondary) {}
        TFButton("Отмена", variant: .outline) {}
        TFButton("Недоступно", variant: .primary, isEnabled: false) {}
        HStack {
            TFIconButton("line.3.horizontal.decrease") {}
            TFIconButton("ellipsis") {}
        }
    }
    .padding()
    .background(Color.tfBackground)
}
