import SwiftUI

// Вид «Список» — spec §5.1. Секции сверху вниз: «Ждут вас» → «Просрочено» →
// дата-заголовок (только если выше уже была секция) → задачи на сегодня.
// `AppleCalendarEvents` (события календаря устройства) — вне спеки Волны 1
// (`spec/NATIVE-PARTS.md` относит интеграцию с системным календарём к
// более поздней волне), здесь не рисуется.
struct TodayListView: View {
    let waitingTasks: [ApiTask]
    let overdueTasks: [ApiTask]
    let todayTasks: [ApiTask]
    let today: String
    let onOpen: (ApiTask) -> Void
    let onEdit: (ApiTask) -> Void
    let onDelete: (ApiTask) -> Void

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if !waitingTasks.isEmpty {
                sectionHeader("Ждут вас", icon: "person.crop.circle.badge.clock", color: .tfText)
                ForEach(waitingTasks) { task in
                    TodayTaskRow(task: task, overdue: task.dueDate != nil && task.dueDate! < today,
                                 onOpen: { onOpen(task) }, onEdit: { onEdit(task) }, onDelete: { onDelete(task) })
                }
            }
            if !overdueTasks.isEmpty {
                sectionHeader("Просрочено", color: .tfRed)
                ForEach(overdueTasks) { task in
                    TodayTaskRow(task: task, overdue: true,
                                 onOpen: { onOpen(task) }, onEdit: { onEdit(task) }, onDelete: { onDelete(task) })
                }
            }
            if !todayTasks.isEmpty && (!overdueTasks.isEmpty || !waitingTasks.isEmpty) {
                Text(TodayDate.formatDueLabel(today))
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.tfSub)
                    .padding(.horizontal, TFSpacing.xs)
                    .padding(.top, TFSpacing.md)
                    .padding(.bottom, 6)
            }
            ForEach(todayTasks) { task in
                TodayTaskRow(task: task, overdue: false,
                             onOpen: { onOpen(task) }, onEdit: { onEdit(task) }, onDelete: { onDelete(task) })
            }
        }
    }

    private func sectionHeader(_ title: String, icon: String? = nil, color: Color) -> some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Color.tfText)
            }
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, TFSpacing.xs)
        .padding(.top, TFSpacing.md)
        .padding(.bottom, 6)
    }
}
