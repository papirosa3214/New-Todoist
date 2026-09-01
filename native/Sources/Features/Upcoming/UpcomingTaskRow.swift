import SwiftUI
import UIKit

// Строка задачи вида «Список» — spec/SCREENS-1.md §3.3 (`TaskRow.tsx`),
// с проп-переопределением экрана «Планирование»: `maxLabels=1 showDueBadge=false`
// (§5.2). Раз срок никогда не рисуется здесь (и задача никогда не бывает
// просроченной — «Планирование» показывает только due_date ≥ сегодня, §5.2),
// содержимое строки уже покрывает `TFTaskRow` из `DesignSystem` дословно —
// здесь только добавлен свайп (`DesignSystem` его не умеет, см. отчёт).
struct UpcomingTaskRow: View {
    let task: ApiTask
    let onOpen: () -> Void
    let onComplete: () -> Void
    let onReschedule: () -> Void
    let onDelete: () -> Void

    /// Ширина зоны действия свайпа — `ACTION_W` (spec §3.3).
    private let actionWidth: CGFloat = 84
    private let openThreshold: CGFloat = 36
    private let openVelocity: CGFloat = 280
    private let closeThreshold: CGFloat = 25
    private let closeVelocity: CGFloat = 250
    @State private var settledOffset: CGFloat = 0
    @State private var dragOffset: CGFloat = 0
    @State private var confirmDelete = false

    private var offsetX: CGFloat { clamp(settledOffset + dragOffset) }

    var body: some View {
        ZStack {
            // Кнопки растут за пальцем и проявляются по ходу жеста —
            // разбор веб-модели в TodayTaskRow.
            HStack(spacing: 0) {
                actionButton(
                    icon: "trash", label: "Удалить",
                    identifier: "row.swipe.delete", color: .tfSwipeDelete
                ) { close(); confirmDelete = true }
                .frame(width: leftRevealWidth)
                .opacity(revealOpacity(leftRevealWidth))

                Spacer(minLength: 0)

                actionButton(
                    icon: "calendar", label: "Перенести",
                    identifier: "row.swipe.reschedule", color: .tfOrange
                ) { close(); onReschedule() }
                .frame(width: rightRevealWidth / 2)
                .opacity(revealOpacity(rightRevealWidth))

                actionButton(
                    icon: "checkmark", label: "Завершить",
                    identifier: "row.swipe.complete", color: .tfGreen
                ) { close(); onComplete() }
                .frame(width: rightRevealWidth / 2)
                .opacity(revealOpacity(rightRevealWidth))
            }
            .frame(maxHeight: .infinity)

            TFTaskRow(Self.model(for: task)) {
                if settledOffset != 0 { close() } else { onOpen() }
            }
            // Порядок как в TodayTaskRow: `accessibilityElement(children:)`
            // создаёт новый элемент и стирает всё, что задано выше.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(rowAccessibilityLabel)
            .accessibilityIdentifier("upcoming.task-row")
        // Строка ЯВЛЯЕТСЯ кнопкой, но `children: .ignore` собирает новый
        // элемент и трейт кнопки при этом теряется: в дереве строка
        // становится «Other», VoiceOver не говорит «кнопка», а тесты её не
        // находят среди `app.buttons`. Трейт возвращаем руками.
        .accessibilityAddTraits(.isButton)
            // Непрозрачный фон (веб `bg-bg`), иначе текст задачи читается
            // поверх цветной кнопки, пока строка над ней проезжает.
            .background(Color.tfBackground)
            .offset(x: offsetX)
// Свайп — на UIKit-распознавателе, см. HorizontalPan.swift:
            // SwiftUI-жест внутри ScrollView отбирает вертикальную прокрутку.
            .gesture(
                HorizontalPan(
                    onBegin: { UIImpactFeedbackGenerator(style: .soft).impactOccurred() },
                    onChange: { dx in dragOffset = dx },
                    onEnd: { dx, velocity in settle(dx: dx, velocity: velocity) }
                )
            )
        }
        .clipped()
        .confirmationDialog("Удалить задачу?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive, action: onDelete)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("«\(task.title)» будет удалена безвозвратно")
        }
    }

    /// Короткое имя для VoiceOver.
    private var rowAccessibilityLabel: String {
        if let projectName = task.projectName, !projectName.isEmpty {
            return "\(projectName), \(task.title)"
        }
        return task.title
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

    private var leftRevealWidth: CGFloat { max(offsetX, 0) }
    private var rightRevealWidth: CGFloat { max(-offsetX, 0) }

    private func revealOpacity(_ width: CGFloat) -> Double {
        min(1, Double(width / actionWidth) * 1.3)
    }

    private func actionButton(
        icon: String, label: String, identifier: String, color: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 22))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(color)
        }
        .buttonStyle(.plain)
        .clipped()
        .allowsHitTesting(abs(offsetX) >= actionWidth * 0.7)
        .accessibilityHidden(abs(offsetX) < actionWidth * 0.7)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    private func close() {
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            settledOffset = 0
            dragOffset = 0
        }
    }

    /// Пороги/резина — числа веба (`useRowSwipe.ts`): открытие >36px или
    /// >280px/с, закрытие обратным сдвигом >25px или >250px/с, за ACTION_W —
    /// «резина» `over×30/(30+over)`. Скорость приходит от UIKit в px/с.
    private func settle(dx: CGFloat, velocity: CGFloat) {
        let finalOffset = clamp(settledOffset + dx)
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            if settledOffset == 0 {
                if finalOffset < -openThreshold || velocity < -openVelocity {
                    settledOffset = -2 * actionWidth
                } else if finalOffset > openThreshold || velocity > openVelocity {
                    settledOffset = actionWidth
                } else {
                    settledOffset = 0
                }
            } else if settledOffset < 0 {
                settledOffset = (dx > closeThreshold || velocity > closeVelocity) ? 0 : -2 * actionWidth
            } else {
                settledOffset = (dx < -closeThreshold || velocity < -closeVelocity) ? 0 : actionWidth
            }
            dragOffset = 0
        }
    }

    private func clamp(_ raw: CGFloat) -> CGFloat {
        let limit = raw > 0 ? actionWidth : 2 * actionWidth
        if raw > limit {
            let over = raw - limit
            return limit + (over * 30) / (30 + over)
        } else if raw < -limit {
            let over = -raw - limit
            return -limit - (over * 30) / (30 + over)
        }
        return raw
    }
}

// Высота строки больше не измеряется: кнопки свайпа растягиваются на высоту
// ZStack, которую задаёт сама строка (веб: кнопка прибита `top: 0; bottom: 0`).

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
