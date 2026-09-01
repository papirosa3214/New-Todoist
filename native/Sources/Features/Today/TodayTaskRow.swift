import SwiftUI

// Строка задачи со свайпом — spec/SCREENS-1.md §3.3 + живой `TaskRow.tsx`.
//
// НЕ переиспользует `TFTaskRow` из DesignSystem целиком: тот не умеет
// свайп (влево — «Изменить», вправо — «Удалить») и рисует «Просрочено» БЕЗ
// даты, а живой веб-код (TaskRow.tsx, строка ~549) печатает «Просрочено,
// {formatDueLabel}» — точность спеки важнее переиспользования здесь.
// Мелкие бейджи-примитивы (TFPill/TFPriorityFlag/TFAvatar/цвета) взяты из
// DesignSystem как есть. В отчёте — оркестратору свести оба варианта.
struct TodayTaskRow: View {
    let task: ApiTask
    /// TodayScreen передаёт true для просроченных задач — красная пилюля с датой
    /// вместо обычного бейджа срока (spec: `overdue` проп TaskRow.tsx).
    let overdue: Bool
    let onOpen: () -> Void
    let onComplete: () -> Void
    let onReschedule: () -> Void
    let onDelete: () -> Void

    private let actionWidth: CGFloat = 84
    /// Точка покоя строки: 0 (закрыта), −actionWidth («Завершить» открыта),
    /// −2×actionWidth («Завершить» + «Перенести» открыты), +actionWidth («Удалить» открыта).
    @State private var settledOffset: CGFloat = 0
    @State private var dragOffset: CGFloat = 0
    @State private var confirmDelete = false
    @State private var measuredHeight: CGFloat = 60

    private var offsetX: CGFloat { clamp(settledOffset + dragOffset) }

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                Button(action: { close(); onComplete() }) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(.white)
                }
                .frame(width: actionWidth, height: measuredHeight)
                .background(Color.tfGreen)
                .opacity(offsetX < 0 ? 1 : 0)
                .accessibilityHidden(offsetX >= 0)
                .accessibilityLabel("Завершить")
                .accessibilityIdentifier("row.swipe.complete")
                Button(action: { close(); onReschedule() }) {
                    Image(systemName: "calendar")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(.white)
                }
                .frame(width: actionWidth, height: measuredHeight)
                .background(Color.tfOrange)
                .opacity(offsetX < 0 ? 1 : 0)
                .accessibilityHidden(offsetX >= 0)
                .accessibilityLabel("Перенести")
                .accessibilityIdentifier("row.swipe.reschedule")
                Spacer(minLength: 0)
                Button(action: { close(); confirmDelete = true }) {
                    Image(systemName: "trash")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(.white)
                }
                .frame(width: actionWidth, height: measuredHeight)
                .background(Color.tfSwipeDelete)
                .opacity(offsetX > 0 ? 1 : 0)
                .accessibilityHidden(offsetX <= 0)
                .accessibilityLabel("Удалить")
                .accessibilityIdentifier("row.swipe.delete")
            }

            row
                .background(
                    GeometryReader { geo in
                        Color.tfBackground.preference(key: RowHeightKey.self, value: geo.size.height)
                    }
                )
                .offset(x: offsetX)
                .highPriorityGesture(swipeGesture)
        }
        .onPreferenceChange(RowHeightKey.self) { measuredHeight = $0 }
        .clipped()
        .confirmationDialog("Удалить задачу?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive, action: onDelete)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("«\(task.title)» будет удалена безвозвратно")
        }
    }

    private var row: some View {
        Button {
            if settledOffset != 0 {
                close()
            } else {
                onOpen()
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                if let projectName = task.projectName {
                    HStack(spacing: 3) {
                        Image(systemName: "number")
                            .font(.system(size: 10))
                        Text(projectName)
                    }
                    .tfText(.caption)
                    .foregroundStyle(Color(hex: task.projectColor ?? "#A6A6A6"))
                    .lineLimit(1)
                }

                HStack(spacing: TFSpacing.sm) {
                    if let initials = task.assigneeInitials, task.assigneeId != nil {
                        TFAvatar(size: .sm, initials: initials, tint: Color(hex: task.assigneeColor ?? "#A6A6A6"))
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
                        .lineLimit(2)
                }

                if let agentText = TodayAgentStateTag.text(task) {
                    Text(agentText)
                        .tfText(.meta)
                        .foregroundStyle(TodayAgentStateTag.color(task))
                }

                if hasBadges {
                    HStack(spacing: TFSpacing.xs) {
                        if !task.subtasks.isEmpty {
                            let done = task.subtasks.count { $0.done }
                            TFPill("\(done)/\(task.subtasks.count)", color: .tfSub, solidBackground: .tfCard)
                        }
                        if task.priority <= 3, let priority = TaskPriority(rawValue: task.priority) {
                            TFPriorityFlag(priority)
                        }
                        if overdue, let due = task.dueDate {
                            TFPill("Просрочено, \(TodayDate.formatDueLabel(due))", color: .tfRed, backgroundOpacity: 0.15)
                        } else if let due = task.dueDate {
                            HStack(spacing: 3) {
                                Text(TodayDate.formatDuePlain(due))
                                Text("· \(TodayDate.formatDaysLeft(due))")
                                    .foregroundStyle(TodayDate.daysUntil(due) <= 3 ? Color.tfOrange : Color.tfDim)
                            }
                            .tfText(.caption)
                            .foregroundStyle(Color.tfSub)
                            .padding(.horizontal, TFSpacing.sm)
                            .padding(.vertical, 2)
                            .background(Color.tfCard)
                            .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
                        }
                        ForEach(task.labels, id: \.id) { label in
                            TFLabelPill(label.name, color: Color(hex: label.color ?? "#A6A6A6"))
                        }
                    }
                }
            }
            .padding(.top, 9)
            .padding(.bottom, 12)
            .padding(.horizontal, TFSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
        .accessibilityIdentifier("today.task-row")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(rowAccessibilityLabel)
    }

    private var hasBadges: Bool {
        !task.subtasks.isEmpty || task.priority <= 3 || overdue || task.dueDate != nil || !task.labels.isEmpty
    }

    /// Короткое имя для VoiceOver: название задачи, опционально проект.
    /// Без проекта и бейджей — одна строка; с проектом — «Проект, Задача».
    private var rowAccessibilityLabel: String {
        if let projectName = task.projectName, !projectName.isEmpty {
            return "\(projectName), \(task.title)"
        }
        return task.title
    }

    private func close() {
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            settledOffset = 0
            dragOffset = 0
        }
    }

    // Тот же порог/резина, что в TaskRow.tsx (§3.3): открытие >36px или >280px/с,
    // закрытие обратным сдвигом >25px или >250px/с, за ACTION_W — rubber-band over×30/(30+over).
    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                dragOffset = value.translation.width
            }
            .onEnded { value in
                let velocity = value.predictedEndTranslation.width - value.translation.width
                let finalOffset = clamp(settledOffset + value.translation.width)
                withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
                    if settledOffset == 0 {
                        if finalOffset < -72 || velocity < -360 {
                            settledOffset = -2 * actionWidth
                        } else if finalOffset < -36 || velocity < -280 {
                            settledOffset = -actionWidth
                        } else if finalOffset > 36 || velocity > 280 {
                            settledOffset = actionWidth
                        } else {
                            settledOffset = 0
                        }
                    } else if settledOffset < 0 {
                        let dx = value.translation.width
                        let shouldKeep = !(dx > 25 || velocity > 250)
                        if shouldKeep {
                            settledOffset = (settledOffset == -actionWidth || dx > actionWidth / 2)
                                ? -2 * actionWidth
                                : -actionWidth
                        } else {
                            settledOffset = 0
                        }
                    } else {
                        let dx = value.translation.width
                        let shouldKeep = !(dx < -25 || velocity < -250)
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

private struct RowHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 60
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
