import SwiftUI

// Строка задачи вида «Список» — spec/SCREENS-1.md §3.3 (`TaskRow.tsx`),
// с проп-переопределением экрана «Планирование»: `maxLabels=1 showDueBadge=false`
// (§5.2). Раз срок никогда не рисуется здесь (и задача никогда не бывает
// просроченной — «Планирование» показывает только due_date ≥ сегодня, §5.2),
// содержимое строки уже покрывает `TFTaskRow` из `DesignSystem` дословно —
// здесь только добавлен свайп (`DesignSystem` его не умеет, см. отчёт).
struct UpcomingTaskRow: View {
    let task: ApiTask
    let onOpen: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    /// Ширина зоны действия свайпа — `ACTION_W` (spec §3.3).
    private let actionWidth: CGFloat = 84
    @State private var settledOffset: CGFloat = 0
    @State private var dragOffset: CGFloat = 0
    @State private var confirmDelete = false
    @State private var measuredHeight: CGFloat = 60

    private var offsetX: CGFloat { clamp(settledOffset + dragOffset) }

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                Button(action: { close(); confirmDelete = true }) {
                    Image(systemName: "trash").font(.system(size: 22)).foregroundStyle(.white)
                }
                .frame(width: max(offsetX, 0), height: measuredHeight)
                .background(Color.tfSwipeDelete)
                .opacity(offsetX > 0 ? 1 : 0)
                Spacer(minLength: 0)
                Button(action: { close(); onEdit() }) {
                    Image(systemName: "pencil").font(.system(size: 22)).foregroundStyle(.white)
                }
                .frame(width: max(-offsetX, 0), height: measuredHeight)
                .background(Color.tfSwipeEdit)
                .opacity(offsetX < 0 ? 1 : 0)
            }

            TFTaskRow(Self.model(for: task)) {
                if settledOffset != 0 { close() } else { onOpen() }
            }
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: UpcomingRowHeightKey.self, value: geo.size.height)
                }
            )
            .offset(x: offsetX)
            .gesture(swipeGesture)
        }
        .onPreferenceChange(UpcomingRowHeightKey.self) { measuredHeight = $0 }
        .clipped()
        .confirmationDialog("Удалить задачу?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive, action: onDelete)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("«\(task.title)» будет удалена безвозвратно")
        }
    }

    static func model(for task: ApiTask) -> TFTaskRowModel {
        TFTaskRowModel(
            projectName: task.projectName,
            projectColor: task.projectColor.map { Color(hex: $0) },
            assigneeInitials: task.assigneeId != nil ? task.assigneeInitials : nil,
            assigneeColor: task.assigneeColor.map { Color(hex: $0) },
            title: task.title,
            isDone: task.status == .completed,
            description: (task.description?.isEmpty == false) ? task.description : nil,
            agentStatus: UpcomingAgentStateTag.text(task),
            agentStatusColor: UpcomingAgentStateTag.color(task),
            subtasksDone: task.subtasks.isEmpty ? nil : task.subtasks.count { $0.done },
            subtasksTotal: task.subtasks.isEmpty ? nil : task.subtasks.count,
            priority: TaskPriority(rawValue: task.priority),
            isOverdue: false, // «Планирование» никогда не показывает просроченное (спека §5.2)
            dueText: nil,     // showDueBadge=false (спека §5.2)
            labels: task.labels.prefix(1).map { ($0.name, Color(hex: $0.color ?? "#A6A6A6")) } // maxLabels=1
        )
    }

    private func close() {
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            settledOffset = 0
            dragOffset = 0
        }
    }

    /// Пороги/резина — те же числа, что и spec §3.3/§4 «Строка задачи»: открытие
    /// >36px или >280px/с, закрытие обратным сдвигом >25px или >250px/с,
    /// за ACTION_W — rubber-band `over×30/(30+over)`.
    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in dragOffset = value.translation.width }
            .onEnded { value in
                let velocity = value.predictedEndTranslation.width - value.translation.width
                let finalOffset = clamp(settledOffset + value.translation.width)
                withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
                    if settledOffset == 0 {
                        if finalOffset < -36 || velocity < -280 {
                            settledOffset = -actionWidth
                        } else if finalOffset > 36 || velocity > 280 {
                            settledOffset = actionWidth
                        } else {
                            settledOffset = 0
                        }
                    } else if settledOffset < 0 {
                        let dx = value.translation.width
                        settledOffset = (dx > 25 || velocity > 250) ? 0 : -actionWidth
                    } else {
                        let dx = value.translation.width
                        settledOffset = (dx < -25 || velocity < -250) ? 0 : actionWidth
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

private struct UpcomingRowHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 60
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Статус агента плоским текстом — spec §3.11 `AgentStateTag` (вариант «plain», без подложки).
enum UpcomingAgentStateTag {
    static func text(_ task: ApiTask) -> String? {
        guard let state = task.agentState else { return nil }
        if state == .inProgress, task.agentStale == true { return "Агент пропал" }
        switch state {
        case .inProgress: return "в работе"
        case .blocked: return "заблокировано"
        case .review: return "на проверке"
        }
    }

    static func color(_ task: ApiTask) -> Color {
        guard let state = task.agentState else { return .tfTeal }
        if state == .inProgress, task.agentStale == true { return .tfCoral }
        switch state {
        case .inProgress: return .tfTeal
        case .blocked: return .tfOrange
        case .review: return .tfBlue
        }
    }
}
