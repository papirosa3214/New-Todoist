import SwiftUI

/// Подложка прибитой шапки: плотная часть накрывает полосу ЦЕЛИКОМ, а
/// затухание вынесено в хвост НИЖЕ полосы.
///
/// Зачем отдельно от `FrostedGlass`: тот распределяет градиент по всей своей
/// высоте, и когда фон уходит под статус-бар, плотные 46% приходятся на него,
/// а под самой полосой стекло уже прозрачное — 01.09.2026 на кадре сквозь
/// шапку читались строки задач вместе с аватарками. Владелец просил обратного:
/// «чтобы уже текст гасился, а не сквозь эту надпись прокручивался».
///
/// Хвост свисает ниже полосы (`padding(.bottom, -tail)` на месте применения),
/// поэтому лента уходит под шапку через «чётко → мутно → ничего», а не
/// обрывается линией.
public struct TFHeaderBackdrop: View {
    let tail: CGFloat

    public init(tail: CGFloat = 26) { self.tail = tail }

    public var body: some View {
        VStack(spacing: 0) {
            glass
            glass
                .mask(
                    LinearGradient(
                        stops: [
                            .init(color: .black, location: 0.00),
                            .init(color: .black.opacity(0.55), location: 0.38),
                            .init(color: .black.opacity(0.20), location: 0.68),
                            .init(color: .black.opacity(0.00), location: 1.00),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .frame(height: tail)
        }
        .allowsHitTesting(false)
    }

    /// Сплошной фон, БЕЗ размытия.
    ///
    /// Материал убран 01.09.2026 по просьбе владельца («убери у шапки этот
    /// эффект размытия»). Заодно ушла его побочка: `.ultraThinMaterial` в
    /// тёмной теме подсвечивал плашку (#1C1C1C против #171717 фона), и это
    /// читалось как перевёрнутый градиент. Теперь плотная часть точно
    /// совпадает с фоном экрана, а мягкий переход остаётся только в хвосте.
    private var glass: some View {
        Rectangle().fill(Color.tfBackground)
    }
}

#Preview("Подложка шапки") {
    ZStack(alignment: .top) {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(0..<12, id: \.self) { _ in
                Text("Строка задачи, которая уходит под шапку").foregroundStyle(.white)
            }
        }
        .padding(.top, 40)
        TFHeaderBackdrop().padding(.bottom, -26).frame(height: 100)
    }
    .background(Color.tfBackground)
}
