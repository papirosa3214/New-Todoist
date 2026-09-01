import SwiftUI
import UIKit

// Затухание шапки и таб-бара как в вебе `ScreenHeader` / `AnimatedTabBar`:
// сплошной плашки нет, только два слоя blur со сдвинутыми масками
// (сильный обрывается раньше, мягкий тянется дальше — отсюда «чётко →
// мутно → ничего», а не линия). Прозрачный фон, без border-b.
//
// Реализация через UIVisualEffectView (UIKit blur): SwiftUI `.ultraThinMaterial`
// даёт ОДИН слой размытия, без масок — граница получалась резкой.
// Два UIVisualEffectView с разным blur + CAGradientLayer-маска делают то же,
// что в вебе `backdrop-filter: blur(20px) + blur(6px)` поверх `mask-image`.
//
// Направление задаётся `axis`:
//   .top — плотно у верхней кромки (шапка: «к середине мутнеет, к верху
//          исчезает», как `ScreenHeader` в UI.tsx HEADER_FADE_*).
//   .bottom — плотно у нижней кромки (таб-бар: «под панелью не должно
//             просвечивать ничего», как `index.css .nt-tabbar-menu::before/::after`).
public struct FrostedGlass: View {
    public enum Axis { case top, bottom }
    let axis: Axis

    public init(axis: Axis) { self.axis = axis }

    public var body: some View {
        ZStack {
            // Сильный слой — эквивалент `backdrop-filter: blur(20px)` с жёсткой маской.
            BlurLayer(strength: .systemUltraThinMaterialLight, axis: axis, profile: .strong)
            // Мягкий слой — эквивалент `backdrop-filter: blur(6px)` с растянутой маской.
            BlurLayer(strength: .systemThinMaterialLight, axis: axis, profile: .soft)
        }
        .allowsHitTesting(false)
    }
}

// MARK: - UIViewRepresentable

private enum Profile { case strong, soft }

private struct BlurLayer: UIViewRepresentable {
    let strength: UIBlurEffect.Style
    let axis: FrostedGlass.Axis
    let profile: Profile

    func makeUIView(context: Context) -> UIVisualEffectView {
        let effect = UIBlurEffect(style: strength)
        let view = UIVisualEffectView(effect: effect)
        view.backgroundColor = .clear
        view.layer.mask = makeMask(axis: axis, profile: profile)
        return view
    }

    func updateUIView(_ uiView: UIVisualEffectView, context: Context) {}

    /// Профили сняты с веба. UI.tsx HEADER_FADE_STRONG/SOFT и index.css
    /// `.nt-tabbar-menu::before/::after` имеют одинаковые цифры — разное
    /// только направление (to bottom для шапки, to top для таб-бара).
    private func makeMask(axis: FrostedGlass.Axis, profile: Profile) -> CAGradientLayer {
        let strongPoints: [CGFloat] = [0.0, 0.0, 0.55, 0.78, 0.94, 1.0]
        let strongAlphas: [CGFloat] = [1, 1, 0.55, 0.20, 0.00, 0.00]
        let softPoints:   [CGFloat] = [0.0, 0.10, 0.52, 0.84, 1.0, 1.0]
        let softAlphas:   [CGFloat] = [1, 1, 0.74, 0.34, 0.00, 0.00]
        let points = profile == .strong ? strongPoints : softPoints
        let alphas = profile == .strong ? strongAlphas : softAlphas
        // Для шапки (axis: .top): opacity=1 у y=0, opacity=0 у y=1 — плотно к верху.
        // Для таб-бара (axis: .bottom): наоборот.
        let layer = CAGradientLayer()
        switch axis {
        case .top:
            layer.startPoint = CGPoint(x: 0.5, y: 0)
            layer.endPoint   = CGPoint(x: 0.5, y: 1)
            layer.locations  = points.map { NSNumber(value: Double($0)) }
            layer.colors     = alphas.map { UIColor.white.withAlphaComponent($0).cgColor }
        case .bottom:
            layer.startPoint = CGPoint(x: 0.5, y: 1)
            layer.endPoint   = CGPoint(x: 0.5, y: 0)
            layer.locations  = points.map { 1 - NSNumber(value: Double($0)) }
            layer.colors     = alphas.reversed().map { UIColor.white.withAlphaComponent($0).cgColor }
        }
        return layer
    }
}

// MARK: - Preview

#Preview("Затухание сверху (шапка)") {
    VStack(spacing: 0) {
        FrostedGlass(axis: .top).frame(height: 80)
        Color.blue.opacity(0.5)
    }
}

#Preview("Затухание снизу (таб-бар)") {
    VStack(spacing: 0) {
        Color.blue.opacity(0.5)
        FrostedGlass(axis: .bottom).frame(height: 80)
    }
}
