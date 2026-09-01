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

    /// Размытие + подложка цветом фона.
    ///
    /// ⚠️ Подложка почти плотная (0.96) намеренно. При 0.78 материал в тёмной
    /// теме ПОДСВЕЧИВАЛ плашку: замер по кадру дал #1C1C1C у надписи против
    /// #171717 фона ниже — владелец увидел это как перевёрнутый градиент,
    /// «вверху светлее, внизу темнее». Совпадая с фоном, плотная часть глазу
    /// не видна вовсе: видно только то, что текст под ней погас, — а само
    /// затухание живёт в хвосте, где подложка тает и открывает размытую ленту.
    private var glass: some View {
        Rectangle()
            .fill(.ultraThinMaterial)
            .overlay(Color.tfBackground.opacity(0.96))
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
