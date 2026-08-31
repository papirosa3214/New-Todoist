import SwiftUI

// Свайп строки — spec/SCREENS-2.md §0.6 (`useRowSwipe`), числа сверены живьём
// с `src/lib/useRowSwipe.ts`: ширина панели действия 88pt, направление
// фиксируется после 8px смещения и только если горизонталь весомее
// вертикали в 1.3 раза (иначе это прокрутка списка), строка остаётся
// открытой при смещении >36px ИЛИ броске быстрее 280px/с — симметрично в
// обе стороны (в отличие от строки задачи §3.3, где открытие/закрытие имеют
// РАЗНЫЕ пороги — тот случай уже занят `TodayTaskRow.swift`, чужой файл).
//
// Используется строкой проекта (`ProjectsScreen`) — свайп влево «Изменить»
// (`#007AFF`), вправо «Удалить» (`#FF3B30`).
struct DirectorySwipeRow<Content: View>: View {
    let onEdit: () -> Void
    let onDelete: () -> Void
    @ViewBuilder let content: () -> Content

    private let actionWidth: CGFloat = 88
    private let directionLock: CGFloat = 8
    private let directionBias: CGFloat = 1.3
    private let openPx: CGFloat = 36
    private let openVelocity: CGFloat = 280

    @State private var settledOffset: CGFloat = 0
    @State private var dragOffset: CGFloat = 0
    @State private var measuredHeight: CGFloat = 60

    private var offsetX: CGFloat { clamp(settledOffset + dragOffset) }

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                Button(action: { close(); onDelete() }) {
                    Image(systemName: "trash")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(.white)
                }
                .frame(width: max(offsetX, 0), height: measuredHeight)
                .background(Color.tfSwipeDelete)
                .opacity(offsetX > 0 ? 1 : 0)
                Spacer(minLength: 0)
                Button(action: { close(); onEdit() }) {
                    Image(systemName: "pencil")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(.white)
                }
                .frame(width: max(-offsetX, 0), height: measuredHeight)
                .background(Color.tfSwipeEdit)
                .opacity(offsetX < 0 ? 1 : 0)
            }
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))

            content()
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(key: DirectorySwipeHeightKey.self, value: geo.size.height)
                    }
                )
                .offset(x: offsetX)
                .gesture(swipeGesture)
        }
        .onPreferenceChange(DirectorySwipeHeightKey.self) { measuredHeight = $0 }
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private func close() {
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            settledOffset = 0
            dragOffset = 0
        }
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: directionLock)
            .onChanged { value in
                // Прокрутка списка не должна дёргать строку: игнорируем жест,
                // пока вертикаль весомее горизонтали в 1.3 раза (spec §0.6).
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) > abs(dy) * directionBias else { return }
                dragOffset = dx
            }
            .onEnded { value in
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) > abs(dy) * directionBias else { return }
                let velocity = value.predictedEndTranslation.width - dx
                let finalOffset = clamp(settledOffset + dx)
                withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
                    if settledOffset == 0 {
                        if finalOffset < -openPx || velocity < -openVelocity {
                            settledOffset = -actionWidth
                        } else if finalOffset > openPx || velocity > openVelocity {
                            settledOffset = actionWidth
                        } else {
                            settledOffset = 0
                        }
                    } else if settledOffset < 0 {
                        let shouldKeep = !(dx > openPx || velocity > openVelocity)
                        settledOffset = shouldKeep ? -actionWidth : 0
                    } else {
                        let shouldKeep = !(dx < -openPx || velocity < -openVelocity)
                        settledOffset = shouldKeep ? actionWidth : 0
                    }
                    dragOffset = 0
                }
            }
    }

    private func clamp(_ raw: CGFloat) -> CGFloat {
        if raw > actionWidth {
            let over = raw - actionWidth
            return actionWidth + (over * 30) / (30 + over)
        } else if raw < -actionWidth {
            let over = -raw - actionWidth
            return -actionWidth - (over * 30) / (30 + over)
        }
        return raw
    }
}

private struct DirectorySwipeHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 60
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
