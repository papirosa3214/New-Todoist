import SwiftUI

// Подложка шапки — ГРАДИЕНТ, один на все экраны (владелец 01.09.2026:
// «ты градиент всем сделай тогда лучше»). Стопы дословно те, что уже стояли
// на экране «Сегодня» (`headerFrost`): плотно у верхней кромки, к низу
// растворяется, поэтому лента под шапкой затухает, а заголовок и кнопки
// остаются чёткими.
//
// Внутри — `FrostedGlass` (два слоя реального размытия) и тёмный градиент
// поверх: владелец просил и «потемнее», и чтобы размытие в чате осталось.
public struct TFHeaderScrim: View {
    /// Куда смотрит плотная часть: `.top` — шапка (плотно у верхней кромки,
    /// тает вниз), `.bottom` — нижняя панель и панель ввода чата.
    public enum Axis { case top, bottom }

    let axis: Axis

    public init(axis: Axis = .top) { self.axis = axis }

    public var body: some View {
        ZStack {
            // Реальное размытие: под шапкой и панелью ввода контент мутнеет,
            // а не просто затемняется (владелец 01.09.2026: «в чате тоже
            // размытие эффект, а то мне показалось, что нет»).
            FrostedGlass(axis: axis == .top ? .top : .bottom)
            затемнение
        }
        .allowsHitTesting(false)
    }

    /// Тёмный слой поверх размытия — «потемнее» из той же просьбы.
    private var затемнение: some View {
        LinearGradient(
            stops: [
                // Чёрный, а не цвет фона: владелец 01.09.2026 просил «потемнее»
                // и шапку, и нижнюю панель — под ними не должно просвечивать.
                .init(color: .black.opacity(1.00), location: 0.00),
                .init(color: .black.opacity(0.94), location: 0.45),
                .init(color: .black.opacity(0.62), location: 0.70),
                .init(color: .black.opacity(0.22), location: 0.87),
                .init(color: .black.opacity(0.00), location: 1.00),
            ],
            startPoint: axis == .top ? .top : .bottom,
            endPoint: axis == .top ? .bottom : .top
        )
    }
}
