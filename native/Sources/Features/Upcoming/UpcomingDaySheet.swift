import SwiftUI

// Раскрытый день — spec/SCREENS-1.md §3.6. Две формы одного и того же
// набора данных: `DayStrip` (внутри месячной сетки, полосой между неделями)
// и `DaySheetContent` (нижняя шторка недельного вида).

/// Полоса раскрытого дня в месячной сетке — между его неделей и следующей.
/// Кнопки «Свернуть» нет намеренно: повторный тап по тому же дню закрывает
/// (решение владельца, зафиксировано в спеке §3.6).
struct UpcomingDayStrip: View {
    let date: String
    let tasks: [ApiTask]
    let onTaskTap: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                let (_, month) = UpcomingDate.yearMonth(date)
                Text("\(UpcomingDate.day(date)) \(UpcomingDate.monthsGen[month]),")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.tfText)
                Text(UpcomingDate.weekdaysFull[UpcomingDate.monFirst(UpcomingDate.jsWeekday(date))])
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.tfText)
            }

            if tasks.isEmpty {
                Text("Ничего не запланировано")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.tfDim)
                    .padding(.vertical, 8)
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(tasks, id: \.id) { task in
                            UpcomingDayListRow(task: task, checkboxSize: 13, titleSize: 13, timeSize: 11) {
                                onTaskTap(task.id)
                            }
                        }
                    }
                }
                .frame(maxHeight: 180)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.tfCard)
    }
}

/// Содержимое нижней шторки раскрытого дня — используется только в
/// НЕДЕЛЬНОМ виде (spec §3.6). Подключается через общий `.tfBottomSheet`
/// (`DesignSystem`) — заголовок и «Готово» уже даёт его хром.
struct UpcomingDaySheetContent: View {
    let date: String
    let tasks: [ApiTask]
    let onTaskTap: (String) -> Void
    let onPrevDay: () -> Void
    let onNextDay: () -> Void

    @State private var dragOffset: CGFloat = 0

    var body: some View {
        Group {
            if tasks.isEmpty {
                Text("На этот день ничего не запланировано")
                    .tfText(.action)
                    .foregroundStyle(Color.tfDim)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            } else {
                VStack(spacing: 6) {
                    ForEach(tasks, id: \.id) { task in
                        UpcomingDayListRow(task: task, checkboxSize: 16, titleSize: 14, timeSize: 12) {
                            onTaskTap(task.id)
                        }
                    }
                }
                .padding(.bottom, TFSpacing.lg)
            }
        }
        .offset(x: dragOffset)
        // Свайп день назад/вперёд — порог commit 60px (spec: DaySheet.tsx, handlePointerUp).
        .gesture(
            DragGesture(minimumDistance: 8)
                .onChanged { value in
                    let raw = value.translation.width
                    dragOffset = abs(raw) > 80 ? (raw > 0 ? 1 : -1) * (80 + (abs(raw) - 80) * 0.35) : raw
                }
                .onEnded { value in
                    let dx = value.translation.width
                    withAnimation(.easeOut(duration: 0.2)) { dragOffset = 0 }
                    if abs(dx) >= 60 {
                        if dx < 0 { onNextDay() } else { onPrevDay() }
                    }
                }
        )
    }
}
