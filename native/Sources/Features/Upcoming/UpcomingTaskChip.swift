import SwiftUI

// Плашка задачи в ячейке недели/месяца — spec/SCREENS-1.md §3.6 `TaskChip`.
// Два вида: обычная (неделя, 19pt, чекбокс+время) и `compact` (месяц, 15pt,
// без чекбокса и времени — ячейка слишком узкая).
struct UpcomingTaskChip: View {
    let task: ApiTask
    let compact: Bool
    let onTap: () -> Void

    private var isDone: Bool { task.status == .completed }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: compact ? 4 : 6) {
                if !compact {
                    ZStack {
                        RoundedRectangle(cornerRadius: 3)
                            .strokeBorder(Color.tfDim, lineWidth: 1)
                            .background(
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(isDone ? Color.tfDim.opacity(0.3) : .clear)
                            )
                        if isDone {
                            Image(systemName: "checkmark")
                                .font(.system(size: 7, weight: .bold))
                                .foregroundStyle(Color.tfSub)
                        }
                    }
                    .frame(width: 10, height: 10)
                }
                Text(task.title)
                    .font(.system(size: compact ? 9 : 11))
                    .foregroundStyle(isDone ? Color.tfSub : Color.tfText)
                    .strikethrough(isDone)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if !compact, let time = task.startTime {
                    Text(time)
                        .font(.system(size: 10))
                        .monospacedDigit()
                        .foregroundStyle(Color.tfDim)
                }
            }
            .padding(.horizontal, compact ? 4 : 6)
            .frame(height: compact ? 15 : 19)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.tfCard2)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
            .opacity(compact && isDone ? 0.45 : 1)
        }
        .buttonStyle(.plain)
    }
}

/// Строка задачи внутри `DayStrip`/`DaySheet` — чекбокс + название + время,
/// отличаются только размером (spec §3.6: DayStrip компактнее DaySheet).
struct UpcomingDayListRow: View {
    let task: ApiTask
    let checkboxSize: CGFloat
    let titleSize: CGFloat
    let timeSize: CGFloat
    let onTap: () -> Void

    private var isDone: Bool { task.status == .completed }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: checkboxSize * 0.3)
                        .strokeBorder(Color.tfDim, lineWidth: checkboxSize > 14 ? 2 : 1)
                        .background(
                            RoundedRectangle(cornerRadius: checkboxSize * 0.3)
                                .fill(isDone ? Color.tfDim.opacity(0.3) : .clear)
                        )
                    if isDone {
                        Image(systemName: "checkmark")
                            .font(.system(size: checkboxSize * 0.55, weight: .bold))
                            .foregroundStyle(Color.tfSub)
                    }
                }
                .frame(width: checkboxSize, height: checkboxSize)

                Text(task.title)
                    .font(.system(size: titleSize))
                    .foregroundStyle(isDone ? Color.tfSub : Color.tfText)
                    .strikethrough(isDone)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let range = UpcomingDate.formatTimeRange(task.startTime, task.durationMin) {
                    Text(range)
                        .font(.system(size: timeSize))
                        .monospacedDigit()
                        .foregroundStyle(Color.tfDim)
                }
            }
            .padding(.horizontal, checkboxSize > 14 ? 12 : 8)
            .padding(.vertical, checkboxSize > 14 ? 10 : 6)
            .background(Color.tfCard2)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapMenuStyle())
    }
}
