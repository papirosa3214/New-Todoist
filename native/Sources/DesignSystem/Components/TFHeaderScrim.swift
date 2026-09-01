import SwiftUI

// Подложка шапки — ГРАДИЕНТ, один на все экраны (владелец 01.09.2026:
// «ты градиент всем сделай тогда лучше»). Стопы дословно те, что уже стояли
// на экране «Сегодня» (`headerFrost`): плотно у верхней кромки, к низу
// растворяется, поэтому лента под шапкой затухает, а заголовок и кнопки
// остаются чёткими.
//
// Не `FrostedGlass`: тот даёт два слоя реального размытия (UIVisualEffectView).
// Владелец выбрал именно градиент — чистое затухание цветом, без блюра.
public struct TFHeaderScrim: View {
    public init() {}

    public var body: some View {
        LinearGradient(
            stops: [
                .init(color: Color.tfBackground.opacity(0.96), location: 0.00),
                .init(color: Color.tfBackground.opacity(0.90), location: 0.42),
                .init(color: Color.tfBackground.opacity(0.58), location: 0.68),
                .init(color: Color.tfBackground.opacity(0.18), location: 0.86),
                .init(color: Color.tfBackground.opacity(0.00), location: 1.00),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .allowsHitTesting(false)
    }
}
