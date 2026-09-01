import SwiftUI

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
            BlurLayer(material: .ultraThinMaterial, axis: axis, profile: .strong)
            // Мягкий слой — эквивалент `backdrop-filter: blur(6px)` с растянутой маской.
            BlurLayer(material: .thinMaterial, axis: axis, profile: .soft)
            // Третий слой веба — подложка цветом фона (UI.tsx HEADER_TINT,
            // index.css `.nt-tabbar-menu::after`). Без неё заголовок и иконки
            // читаются не над любым содержимым: размытие оставляет цвет, и
            // светлая карточка под шапкой «просвечивает» в текст.
            tint
        }
        .allowsHitTesting(false)
    }

    /// Проценты дословно из `HEADER_TINT`: плотно у кромки, к середине тает.
    private var tint: some View {
        LinearGradient(
            stops: [
                .init(color: .tfBackground, location: 0.00),
                .init(color: .tfBackground, location: 0.46),
                .init(color: .tfBackground.opacity(0.74), location: 0.66),
                .init(color: .tfBackground.opacity(0.34), location: 0.84),
                .init(color: .tfBackground.opacity(0.00), location: 1.00),
            ],
            startPoint: axis == .top ? .top : .bottom,
            endPoint: axis == .top ? .bottom : .top
        )
    }
}

// MARK: - Слои размытия

private enum Profile { case strong, soft }

/// Один слой размытия с маской-градиентом.
///
/// ⚠️ Реализация переведена с `UIVisualEffectView` на материал SwiftUI
/// (01.09.2026): обёрнутый в `UIViewRepresentable` эффект размывал не
/// содержимое экрана, а пустоту — на кадре под таб-баром текст оставался
/// чётким. `.ultraThinMaterial`/`.thinMaterial` в `background` размывают
/// именно то, что лежит под ними в SwiftUI-иерархии, и маска к ним
/// применяется штатным `.mask`, без ручного управления слоями и их frame.
private struct BlurLayer: View {
    let material: Material
    let axis: FrostedGlass.Axis
    let profile: Profile

    var body: some View {
        Rectangle()
            .fill(material)
            .mask(alignment: .center) {
                LinearGradient(
                    stops: stops,
                    startPoint: axis == .top ? .top : .bottom,
                    endPoint: axis == .top ? .bottom : .top
                )
            }
    }

    /// Профили сняты с веба: UI.tsx `HEADER_FADE_STRONG`/`HEADER_FADE_SOFT`
    /// и index.css `.nt-tabbar-menu::before/::after` — цифры одинаковые,
    /// разное только направление (`to bottom` у шапки, `to top` у панели),
    /// и оно задаётся точками градиента, а не переворотом массива.
    private var stops: [Gradient.Stop] {
        let strong: [(CGFloat, CGFloat)] = [(0.00, 1), (0.40, 1), (0.62, 0.55), (0.80, 0.20), (0.94, 0)]
        let soft:   [(CGFloat, CGFloat)] = [(0.00, 1), (0.52, 1), (0.74, 0.50), (0.88, 0.18), (1.00, 0)]
        let points = profile == .strong ? strong : soft
        return points.map { .init(color: .black.opacity($0.1), location: $0.0) }
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
