import SwiftUI
import UIKit

// `TimeWheel` — spec/SCREENS-1.md §3.7: единственный барабан времени начала,
// шаг 15 минут, центральная пилюля показывает интервал, если задана
// длительность. Цилиндр веба (угол между строками 25.5°, радиус ≈73.3pt)
// на native воспроизведён через нативный `.scrollTransition` (iOS 17+) —
// SwiftUI сам даёт фазу «насколько далеко от центра» для каждой строки при
// скролле с прилипанием, ручная 3D-геометрия через `GeometryReader` не
// нужна. Угол 25.5° взят как множитель поворота строки по мере ухода от
// центра — не пиксельная копия SVG-цилиндра веба, а то же число, тот же эффект.
struct TimeWheelView: View {
    @Binding var minutesOfDay: Int // 0...1439, шаг 15
    var durationMin: Int?

    @State private var scrolledID: Int?
    private let rowHeight: CGFloat = 34
    private let visibleRows = 5

    private var slots: [Int] { stride(from: 0, to: 24 * 60, by: 15).map { $0 } }

    var body: some View {
        ZStack {
            ScrollView(showsIndicators: false) {
                LazyVStack(spacing: 0) {
                    ForEach(slots, id: \.self) { slot in
                        Text(Self.label(slot))
                            .tfText(.body)
                            .fontWeight(slot == (scrolledID ?? minutesOfDay) ? .semibold : .regular)
                            .foregroundStyle(slot == (scrolledID ?? minutesOfDay) ? Color.tfText : Color.tfSub)
                            .frame(height: rowHeight)
                            .id(slot)
                            .scrollTransition(axis: .vertical) { content, phase in
                                content
                                    .rotation3DEffect(.degrees(phase.value * 25.5), axis: (x: 1, y: 0, z: 0))
                                    .opacity(1 - min(abs(phase.value), 1) * 0.75)
                                    .scaleEffect(1 - min(abs(phase.value), 1) * 0.18)
                            }
                    }
                }
                .scrollTargetLayout()
                .padding(.vertical, rowHeight * CGFloat(visibleRows - 1) / 2)
            }
            .frame(height: rowHeight * CGFloat(visibleRows))
            .scrollPosition(id: $scrolledID, anchor: .center)
            .scrollTargetBehavior(.viewAligned)

            // Центральная пилюля — не строка списка, а отдельная плашка поверх,
            // подсказывающая текущее значение живьём во время скролла.
            Text(pillText)
                .tfText(.body)
                .fontWeight(.semibold)
                .foregroundStyle(Color.tfText)
                .padding(.horizontal, TFSpacing.md)
                .padding(.vertical, TFSpacing.xs)
                .background(Color.tfCard2)
                .clipShape(Capsule())
                .allowsHitTesting(false)
        }
        .onAppear { scrolledID = minutesOfDay }
        .onChange(of: scrolledID) { oldValue, newValue in
            guard let newValue else { return }
            minutesOfDay = newValue
            fireHaptic(from: oldValue, to: newValue)
        }
    }

    private var pillText: String {
        let current = scrolledID ?? minutesOfDay
        return TaskDateText.timeRange(start: Self.label(current), durationMin: durationMin)
    }

    private static func label(_ minutes: Int) -> String {
        String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }

    /// Лёгкий тик на каждое деление 15 минут, более выраженный — на переходе через ровный час.
    private func fireHaptic(from oldValue: Int?, to newValue: Int) {
        guard oldValue != newValue else { return }
        let crossedHour = oldValue.map { $0 / 60 != newValue / 60 } ?? false
        UIImpactFeedbackGenerator(style: crossedHour ? .medium : .light).impactOccurred()
    }
}
