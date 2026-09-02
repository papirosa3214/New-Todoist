import SwiftUI

// Доска «Сегодня» — spec §3.4/§5.1: колонки «Ждут вас»/«Просрочено»/«Сегодня»,
// БЕЗ группировки по проектам (владелец, прямое решение) — поэтому drag
// между колонками здесь не пишет `project_id` (в вебе карточка просто
// отскакивает назад). Сортировку ВНУТРИ колонки (поле `position`) native-
// версия НЕ делает — не хватает времени в рамках этой сдачи, честно
// оставлено недоделанным (см. отчёт), карточки только открываются тапом.
struct TodayBoardView: View {
    let columns: [TodayBoardColumn]
    let onOpenTask: (String) -> Void
    let onReschedule: () -> Void
    let onAddTask: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: TFSpacing.md) {
                ForEach(columns) { column in
                    columnView(column)
                        .frame(width: 260)
                }
            }
            .padding(.horizontal, TFSpacing.lg)
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
    }

    private func columnView(_ column: TodayBoardColumn) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            HStack {
                Text(column.title)
                    .tfText(.title)
                    .fontWeight(.semibold)
                    .foregroundStyle(column.titleIsRed ? Color.tfRed : Color.tfText)
                Spacer()
                if column.id == .overdue {
                    Button("Перенести", action: onReschedule)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.tfRed)
                }
            }

            if column.tasks.isEmpty {
                Text("Нет задач")
                    .tfText(.action)
                    .foregroundStyle(Color.tfDim)
                    .frame(maxWidth: .infinity, minHeight: 60)
                    .overlay {
                        RoundedRectangle(cornerRadius: TFRadius.lg)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                            .foregroundStyle(Color.tfStroke)
                    }
            } else {
                VStack(spacing: TFSpacing.sm) {
                    ForEach(column.tasks) { task in
                        boardCard(task)
                    }
                }
            }

            if column.id == .today {
                Button(action: onAddTask) {
                    HStack(spacing: TFSpacing.sm) {
                        Image(systemName: "plus")
                        Text("Добавить задачу")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.tfRed)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(Color.tfRed.opacity(0.05))
                    .overlay {
                        RoundedRectangle(cornerRadius: TFRadius.lg)
                            .strokeBorder(Color.tfRed.opacity(0.4), lineWidth: 1)
                    }
                }
            }
        }
    }

    private func boardCard(_ task: ApiTask) -> some View {
        Button(action: { onOpenTask(task.id) }) {
            VStack(alignment: .leading, spacing: 4) {
                if let projectName = task.projectName {
                    Text("#\(projectName)")
                        .tfText(.caption)
                        .foregroundStyle(Color(hex: task.projectColor ?? "#A6A6A6"))
                }
                HStack(spacing: TFSpacing.md) {
                    if let initials = task.assigneeInitials, task.assigneeId != nil {
                        TFAvatar(size: .xs, initials: initials, tint: Color(hex: task.assigneeColor ?? "#A6A6A6"))
                    }
                    Text(task.title)
                        .tfText(.body)
                        .foregroundStyle(task.status == .completed ? Color.tfSub : Color.tfText)
                        .strikethrough(task.status == .completed)
                        .lineLimit(1)
                }
                if let description = task.description, !description.isEmpty {
                    Text(description)
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                        .lineLimit(1)
                }
                if let agentText = TodayAgentStateTag.text(task) {
                    Text(agentText)
                        .tfText(.caption)
                        .foregroundStyle(TodayAgentStateTag.color(task))
                }
                HStack(spacing: TFSpacing.xs) {
                    if !task.subtasks.isEmpty {
                        let done = task.subtasks.count { $0.done }
                        TFPill("\(done)/\(task.subtasks.count)", color: .tfSub, solidBackground: .tfCard2)
                    }
                    if let due = task.dueDate {
                        TFPill(TodayDate.formatDuePlain(due), color: .tfSub, solidBackground: .tfCard2)
                    }
                    if let label = task.labels.first {
                        TFLabelPill(label.name, color: Color(hex: label.color ?? "#A6A6A6"))
                    }
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 12)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
        .buttonStyle(TFTapScaleStyle())
    }
}
