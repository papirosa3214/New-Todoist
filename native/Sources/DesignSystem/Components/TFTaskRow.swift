import SwiftUI

// Строка задачи — spec/DESIGN-TOKENS.md §4 «Строка задачи» + spec/SCREENS-1.md §3.3.
// Порядок содержимого сверху вниз (буквально по спеке, не додумано):
// 1. бейдж проекта — #Название, цвет проекта, БЕЗ заливки фона;
// 2. заголовок: (опц.) аватар 20px слева + название;
// 3. описание — максимум 2 строки;
// 4. (опц.) статус агента плоским текстом без подложки;
// 5. ряд бейджей: подзадачи N/M → приоритет (P1–P3, P4 не рисуется) →
//    «Просрочено» → срок(+«· N дн.») → метки.
//
// Чекбокса завершения задачи в строке НЕТ — убран целиком 18.08.2026 (владелец).
// Приоритет читается только флагом-иконкой, «выполнено» — зачёркиванием названия.
// Завершение — отдельной полноширинной кнопкой на экране самой задачи, не тут.
public struct TFTaskRowModel {
    public var projectName: String?
    public var projectColor: Color?
    public var assigneeInitials: String?
    public var assigneeColor: Color?
    public var title: String
    public var isDone: Bool
    public var description: String?
    public var agentStatus: String?
    public var agentStatusColor: Color?
    public var subtasksDone: Int?
    public var subtasksTotal: Int?
    public var priority: TaskPriority?
    public var isOverdue: Bool
    public var dueText: String?
    public var labels: [(title: String, color: Color)]

    public init(
        projectName: String? = nil,
        projectColor: Color? = nil,
        assigneeInitials: String? = nil,
        assigneeColor: Color? = nil,
        title: String,
        isDone: Bool = false,
        description: String? = nil,
        agentStatus: String? = nil,
        agentStatusColor: Color? = nil,
        subtasksDone: Int? = nil,
        subtasksTotal: Int? = nil,
        priority: TaskPriority? = nil,
        isOverdue: Bool = false,
        dueText: String? = nil,
        labels: [(title: String, color: Color)] = []
    ) {
        self.projectName = projectName
        self.projectColor = projectColor
        self.assigneeInitials = assigneeInitials
        self.assigneeColor = assigneeColor
        self.title = title
        self.isDone = isDone
        self.description = description
        self.agentStatus = agentStatus
        self.agentStatusColor = agentStatusColor
        self.subtasksDone = subtasksDone
        self.subtasksTotal = subtasksTotal
        self.priority = priority
        self.isOverdue = isOverdue
        self.dueText = dueText
        self.labels = labels
    }
}

public struct TFTaskRow: View {
    let model: TFTaskRowModel
    let action: () -> Void

    public init(_ model: TFTaskRowModel, action: @escaping () -> Void) {
        self.model = model
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            // Асимметричный паддинг 9 сверху / 12 снизу (не 16/16) — намеренно
            // (спека): визуальный воздух над/под текстом иначе не совпадает.
            VStack(alignment: .leading, spacing: 4) {
                if let projectName = model.projectName {
                    Text("#\(projectName)")
                        .tfText(.caption)
                        .foregroundStyle(model.projectColor ?? .tfSub)
                }

                HStack(spacing: TFSpacing.sm) {
                    if let initials = model.assigneeInitials {
                        TFAvatar(size: .sm, initials: initials, tint: model.assigneeColor ?? Color(hex: "#A6A6A6"))
                    }
                    Text(model.title)
                        .tfText(.body)
                        .foregroundStyle(model.isDone ? Color.tfSub : Color.tfText)
                        .strikethrough(model.isDone)
                        .lineLimit(1)
                }

                if let description = model.description {
                    Text(description)
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                        .lineLimit(2)
                }

                if let status = model.agentStatus {
                    Text(status)
                        .tfText(.meta)
                        .foregroundStyle(model.agentStatusColor ?? Color.tfTeal)
                }

                if hasBadges {
                    HStack(spacing: TFSpacing.xs) {
                        if let done = model.subtasksDone, let total = model.subtasksTotal {
                            TFPill("\(done)/\(total)", color: .tfSub, solidBackground: .tfCard)
                        }
                        // P4 намеренно не рисуется — спека прямо это оговаривает.
                        if let priority = model.priority, priority != .low {
                            TFPriorityFlag(priority)
                        }
                        if model.isOverdue {
                            TFOverduePill()
                        } else if let due = model.dueText {
                            TFDuePill(due)
                        }
                        ForEach(model.labels, id: \.title) { label in
                            TFLabelPill(label.title, color: label.color)
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
    }

    private var hasBadges: Bool {
        model.subtasksTotal != nil || (model.priority != nil && model.priority != .low)
            || model.isOverdue || model.dueText != nil || !model.labels.isEmpty
    }
}

#Preview("Строка задачи") {
    VStack(spacing: 0) {
        TFTaskRow(TFTaskRowModel(
            projectName: "AI Control Center",
            projectColor: .tfPink,
            assigneeInitials: "МК",
            title: "Собрать дизайн-систему",
            description: "Токены, компоненты, таббар и меню создания — первая волна нативной сборки.",
            subtasksDone: 2,
            subtasksTotal: 5,
            priority: .urgent,
            isOverdue: true,
            labels: [("UX/UI", .tfPurple)]
        )) {}
        TFDivider(inset: TFSpacing.lg)
        TFTaskRow(TFTaskRowModel(
            title: "Готовая задача",
            isDone: true,
            dueText: "Завтра · 2 дн."
        )) {}
    }
    .background(Color.tfBackground)
}
