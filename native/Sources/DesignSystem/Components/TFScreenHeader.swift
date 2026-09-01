import SwiftUI

// Шапка экрана (`ScreenHeader`) — spec/DESIGN-TOKENS.md §4.
// Оба варианта: прибита к окну (на native — просто верх NavigationStack/View,
// `position: fixed` — веб-приём против резиновой оттяжки iOS, здесь не нужен),
// двухслойный блюр под шапкой заменяем на `.ultraThinMaterial` — SwiftUI
// сам даёт многослойное размытие с градиентным затуханием по краю.
public struct TFScreenHeader: View {
    public enum Variant {
        case large   // корневые вкладки: h1 28px/700 слева, высота полосы min 56px
        case compact // вложенные экраны: заголовок 17px/600 по центру, высота 48px
    }

    let variant: Variant
    let title: String
    /// Только для `.compact` — обычно nil (свайп от края вместо кнопки «назад»,
    /// `BackButton` в вебе оставлен только для экрана регистрации).
    let leading: (() -> AnyView)?
    let actions: [TFHeaderAction]
    /// Опциональная строка ПОД заголовком, внутри той же шапки (например,
    /// переключатель каналов в чате, SCREENS-2 §0.1) — уезжает и затухает вместе с шапкой.
    let below: (() -> AnyView)?

    public init(
        _ title: String,
        variant: Variant = .large,
        leading: (() -> AnyView)? = nil,
        actions: [TFHeaderAction] = [],
        below: (() -> AnyView)? = nil
    ) {
        self.title = title
        self.variant = variant
        self.leading = leading
        self.actions = actions
        self.below = below
    }

    public var body: some View {
        VStack(spacing: 0) {
            ZStack {
                switch variant {
                case .large:
                    HStack {
                        Text(title)
                            .tfText(.titleLarge)
                            .foregroundStyle(Color.tfText)
                            .lineLimit(1)
                        Spacer()
                        actionsRow
                    }
                case .compact:
                    HStack {
                        Group {
                            if let leading { leading() } else { Color.clear.frame(width: TFHitTarget.min) }
                        }
                        Spacer()
                        actionsRow
                    }
                    Text(title)
                        .tfText(.title)
                        .foregroundStyle(Color.tfText)
                        .lineLimit(1)
                        .allowsHitTesting(false)
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .frame(height: variant == .large ? 56 : 48)

            below?()
        }
        // Шапка лежит в safeAreaInset вызывающего экрана — штатный
        // toolbarBackground сюда не доходит. Явный `.background(.ultraThinMaterial)` —
        // полупрозрачный blur, как в вебе (frosted glass). Color.tfCard был
        // бы сплошным и не соответствовал бы вебу.
        .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private var actionsRow: some View {
        if !actions.isEmpty {
            HStack(spacing: TFSpacing.headerActionsGap) {
                ForEach(actions) { action in
                    TFIconButton(action.icon, size: 18, action: action.handler)
                }
            }
        }
    }
}

/// Кнопка-действие в шапке — только иконка 18px в зоне 44×44, без подписи и подложки.
public struct TFHeaderAction: Identifiable {
    public let id = UUID()
    let icon: String
    let handler: () -> Void

    public init(icon: String, handler: @escaping () -> Void) {
        self.icon = icon
        self.handler = handler
    }
}

extension TFScreenHeader.Variant: Equatable {}

#Preview("Шапка — large") {
    VStack(spacing: 0) {
        TFScreenHeader(
            "Обзор",
            variant: .large,
            actions: [TFHeaderAction(icon: "magnifyingglass") {}]
        )
        Spacer()
    }
    .background(Color.tfBackground)
}

#Preview("Шапка — compact") {
    VStack(spacing: 0) {
        TFScreenHeader("Метки", variant: .compact)
        Spacer()
    }
    .background(Color.tfBackground)
}
