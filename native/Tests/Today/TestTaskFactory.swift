import Foundation
@testable import TaskFlow

/// Фабрика тестовых ApiTask — собирает задачу через JSON, чтобы покрывать
/// edge cases декодирования (числовые булевы, отсутствующие поля, null-даты).
enum TestTaskFactory {

    /// Главный конструктор — собирает ApiTask из JSON, все параметры опциональны.
    static func makeTask(
        id: String,
        title: String = "Task",
        description: String? = nil,
        dueDate: String? = nil,
        projectId: String? = nil,
        projectName: String? = nil,
        projectColor: String? = nil,
        assigneeId: String? = nil,
        assigneeName: String? = nil,
        assigneeInitials: String? = nil,
        creatorId: String? = "u-owner",
        status: TaskStatus = .active,
        priority: Int = 1,
        parentId: String? = nil,
        labels: [(id: String, name: String)] = [],
        agentState: AgentState? = nil
    ) -> ApiTask {
        var json: [String: Any] = [
            "id": id,
            "title": title,
            "priority": priority,
            "status": status == .completed ? "completed" : "active",
            "pinned": 0,
            "creator_id": creatorId ?? "u-owner"
        ]
        if let description { json["description"] = description }
        if let dueDate { json["due_date"] = dueDate }
        if let projectId { json["project_id"] = projectId }
        if let projectName { json["project_name"] = projectName }
        if let projectColor { json["project_color"] = projectColor }
        if let assigneeId { json["assignee_id"] = assigneeId }
        if let assigneeName { json["assignee_name"] = assigneeName }
        if let assigneeInitials { json["assignee_initials"] = assigneeInitials }
        if let parentId { json["parent_id"] = parentId }
        if let agentState {
            let str: String
            switch agentState {
            case .inProgress: str = "in_progress"
            case .blocked: str = "blocked"
            case .review: str = "review"
            }
            json["agent_state"] = str
        }
        if !labels.isEmpty {
            json["labels"] = labels.map { ["id": $0.id, "name": $0.name] }
        }
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! JSONDecoder().decode(ApiTask.self, from: data)
    }

    /// Короткая форма — только id + labelIds, всё остальное по умолчанию.
    static func make(
        _ id: String,
        projectId: String? = nil,
        labelIds: [String] = [],
        assigneeId: String? = nil,
        status: TaskStatus = .active
    ) -> ApiTask {
        let labels = labelIds.map { (id: $0, name: "Label \($0)") }
        return makeTask(
            id: id, projectId: projectId, assigneeId: assigneeId, status: status, labels: labels
        )
    }
}
