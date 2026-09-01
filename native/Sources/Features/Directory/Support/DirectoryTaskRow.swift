import SwiftUI
import UIKit

// Строка задачи для ProjectTasksScreen — дубль `src/components/TaskRow.tsx`
// (общий компонент, которым пользуется чужой набор экранов), тем же приёмом
// дублирования, что `Features/Today/TodayTaskRow.swift` уже применил для
// «Сегодня» («точность спеки важнее переиспользования» — комментарий того
// файла). Не беру TodayTaskRow как есть: этому экрану нужно закрепление
// (`pinned`/`onTogglePin`, третий интерактивный элемент строки, которого у
// Today нет) и подавленный бейдж проекта (`showProjectBadge=false` — сам
// экран уже внутри одного проекта).
//
// ⚠️ Сверено с живым `TaskRow.tsx` 31.08.2026: `ProjectTasksScreen.tsx`
// вызывает `<TaskRow .../>` БЕЗ пропа `overdue` — он там всегда `false` по
// умолчанию, то есть просроченные задачи здесь показывают ОБЫЧНый бейдж
// срока (день+месяц, «· N дней»), а не красную пилюлю «Просрочено» — это не
// упрощение, так in the реальном коде, красная пилюля тут в принципе
// недостижима. Верхний файловый комментарий самого TaskRow.tsx про
// «точку-переключатель статуса» — устаревшая документация: в актуальном
// JSX такой кнопки уже нет (проверено построчно), дот-toggle реально
// существует только в LabelTasksScreen (см. её отдельную реализацию).
struct DirectoryTaskRow: View {
    let task: ApiTask
    let pinned: Bool
    let onOpen: () -> Void
    let onTogglePin: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void

    private let actionWidth: CGFloat = 84
    @State private var settledOffset: CGFloat = 0
    @State private var dragOffset: CGFloat = 0
    @State private var confirmDelete = false

    private var offsetX: CGFloat { clamp(settledOffset + dragOffset) }

    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                swipeActionButton(icon: "trash", label: "Удалить", width: max(offsetX, 0), visible: offsetX > 0) {
                    close(); confirmDelete = true
                }
                .background(Color.tfSwipeDelete)
                Spacer(minLength: 0)
                swipeActionButton(icon: "pencil", label: "Изменить", width: max(-offsetX, 0), visible: offsetX < 0) {
                    close(); onEdit()
                }
                .background(Color.tfSwipeEdit)
            }

            row
                .background(Color.tfBackground)
                .offset(x: offsetX)
                // UIKit-pan не забирает вертикальный жест у ScrollView.
                // Обычный DragGesture здесь делал начало прокрутки вязким:
                // список ждал, решит ли строка трактовать касание как свайп.
                .gesture(
                    HorizontalPan(
                        onBegin: { UIImpactFeedbackGenerator(style: .soft).impactOccurred() },
                        onChange: { dx in dragOffset = dx },
                        onEnd: { dx, velocity in settle(dx: dx, velocity: velocity) }
                    )
                )
        }
        .clipped()
        // Ближайший native-эквивалент своего нижнего экшн-листа из TaskRow.tsx
        // (красная «Удалить» текстом + отдельная карточка «Отмена») — тот же
        // приём, что уже выбрал TodayTaskRow.swift для идентичного узла.
        .confirmationDialog("Удалить задачу?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive, action: onDelete)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("«\(task.title)» будет удалена безвозвратно")
        }
    }

    private func swipeActionButton(icon: String, label: String, width: CGFloat, visible: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon).font(.system(size: 22, weight: .regular))
                Text(label).font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(.white)
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .opacity(visible ? 1 : 0)
    }

    private var row: some View {
        Button {
            if settledOffset != 0 { close() } else { onOpen() }
        } label: {
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 4) {
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

                    if let agentText = DirectoryAgentStateTag.text(task) {
                        Text(agentText)
                            .tfText(.meta)
                            .foregroundStyle(DirectoryAgentStateTag.color(task))
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
                            if let due = task.dueDate {
                                HStack(spacing: 3) {
                                    Text(DirectoryDate.formatDuePlain(due))
                                    Text("· \(DirectoryDate.formatDaysLeft(due))")
                                        .foregroundStyle(DirectoryDate.daysUntil(due) <= 3 ? Color.tfOrange : Color.tfDim)
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
                Spacer(minLength: TFSpacing.sm)
                // Закрепление — третий интерактивный узел строки (`onTogglePin`,
                // ProjectTasksScreen.tsx), не вложенная кнопка внутри кнопки:
                // тап по пину не должен открывать задачу.
                Button(action: onTogglePin) {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(pinned ? Color.tfOrange : Color.tfDim)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(TFTapScaleStyle())
            }
            .padding(.top, 9)
            .padding(.bottom, 12)
            .padding(.horizontal, TFSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }

    private var hasBadges: Bool {
        !task.subtasks.isEmpty || task.priority <= 3 || task.dueDate != nil || !task.labels.isEmpty
    }

    private func close() {
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            settledOffset = 0
            dragOffset = 0
        }
    }

    // Пороги 1:1 с `TaskRow.tsx`: открытие >36px/280px·с⁻¹, закрытие
    // обратным сдвигом >25px/250px·с⁻¹ — асимметрично, легче закрыть, чем открыть.
    private func settle(dx: CGFloat, velocity: CGFloat) {
        let finalOffset = clamp(settledOffset + dx)
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
                settledOffset = (dx > 25 || velocity > 250) ? 0 : -actionWidth
            } else {
                settledOffset = (dx < -25 || velocity < -250) ? 0 : actionWidth
            }
            dragOffset = 0
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

/// Статус агента плоским текстом — дубль `TodayAgentStateTag` (`Features/Today/TodayFilters.swift`,
/// чужой файл), те же тексты/цвета AGENT-PROTOCOL.md.
enum DirectoryAgentStateTag {
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
