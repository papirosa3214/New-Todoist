import SwiftUI

// Форма фильтров экрана — spec/SCREENS-1.md §4.3 (`lib/taskFilters.ts`).
// Не персистится (сбрасывается при уходе с экрана) — см. §4.4.
struct TodayTaskFilters: Equatable {
    var projectId: String?
    var labelId: String?
    /// nil — все, "__none" — без исполнителя, иначе id.
    var assigneeKey: String?
    var showCompleted: Bool = false

    static let empty = TodayTaskFilters()

    var isActive: Bool {
        projectId != nil || labelId != nil || assigneeKey != nil || showCompleted
    }
}

struct TodayFilterOption: Identifiable, Hashable {
    let id: String
    let label: String
    let color: Color
}

struct TodayAssigneeOption: Identifiable, Hashable {
    let id: String
    let name: String
    let color: Color
    let initials: String
}

enum TodayFilterEngine {
    static func matches(_ task: ApiTask, _ filters: TodayTaskFilters) -> Bool {
        if let projectId = filters.projectId, task.projectId != projectId { return false }
        if let labelId = filters.labelId, !task.labels.contains(where: { $0.id == labelId }) { return false }
        if filters.assigneeKey == "__none" {
            if task.assigneeId != nil { return false }
        } else if let assigneeKey = filters.assigneeKey, task.assigneeId != assigneeKey {
            return false
        }
        if !filters.showCompleted && task.status == .completed { return false }
        return true
    }

    static func filter(_ tasks: [ApiTask], _ filters: TodayTaskFilters) -> [ApiTask] {
        tasks.filter { matches($0, filters) }
    }

    /// Опции строятся из ПОЛНОГО набора задач (до фильтра) — вариант не исчезает
    /// из списка только потому, что активен другой фильтр (spec §4.3).
    static func projectOptions(_ tasks: [ApiTask]) -> [TodayFilterOption] {
        var seen = Set<String>()
        var result: [TodayFilterOption] = []
        for t in tasks {
            guard let id = t.projectId, let name = t.projectName, !seen.contains(id) else { continue }
            seen.insert(id)
            result.append(TodayFilterOption(id: id, label: name, color: Color(hex: t.projectColor ?? "#A6A6A6")))
        }
        return result.sorted { $0.label.localizedCompare($1.label) == .orderedAscending }
    }

    static func labelOptions(_ tasks: [ApiTask]) -> [TodayFilterOption] {
        var seen = Set<String>()
        var result: [TodayFilterOption] = []
        for t in tasks {
            for l in t.labels where !seen.contains(l.id) {
                seen.insert(l.id)
                result.append(TodayFilterOption(id: l.id, label: l.name, color: Color(hex: l.color ?? "#A6A6A6")))
            }
        }
        return result.sorted { $0.label.localizedCompare($1.label) == .orderedAscending }
    }

    static func assigneeOptions(_ tasks: [ApiTask]) -> (list: [TodayAssigneeOption], hasUnassigned: Bool) {
        var seen = Set<String>()
        var result: [TodayAssigneeOption] = []
        var hasUnassigned = false
        for t in tasks {
            if let id = t.assigneeId {
                if !seen.contains(id) {
                    seen.insert(id)
                    result.append(TodayAssigneeOption(
                        id: id,
                        name: t.assigneeName ?? "Без имени",
                        color: Color(hex: t.assigneeColor ?? "#A6A6A6"),
                        initials: t.assigneeInitials ?? "?"
                    ))
                }
            } else {
                hasUnassigned = true
            }
        }
        return (result.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }, hasUnassigned)
    }
}

// «Ждёт владельца»/«владелец задачи» — spec §5.1 + `lib/taskOwner.ts`.
enum TodayTaskOwner {
    static func isOwner(_ user: ApiUser?, _ task: ApiTask) -> Bool {
        guard let user else { return false }
        return user.role == .owner || user.id == task.creatorId
    }

    static func isWaitingForUser(_ task: ApiTask, _ user: ApiUser?) -> Bool {
        guard let user else { return false }
        return task.status == .active
            && task.parentId == nil
            && isOwner(user, task)
            && (task.agentState == .blocked || task.agentState == .review)
    }

    /// blocked впереди review.
    static func waitingSort(_ a: ApiTask, _ b: ApiTask) -> Bool {
        let ra = a.agentState == .blocked ? 0 : 1
        let rb = b.agentState == .blocked ? 0 : 1
        return ra < rb
    }

    /// Задача назначена ИИ-агенту (не человеку) — spec `isAgentAssignedTask`.
    static func isAgentAssigned(_ task: ApiTask, _ agents: [ApiUser]) -> Bool {
        guard let assigneeId = task.assigneeId else { return false }
        return agents.contains { $0.id == assigneeId && $0.type == .ai }
    }
}

// Статус агента плоским текстом — spec §3.11 `AgentStateTag` (вариант plain).
enum TodayAgentStateTag {
    static func text(_ task: ApiTask) -> String? {
        guard let state = task.agentState else { return nil }
        if state == .inProgress, task.agentStale == true {
            return "Агент пропал"
        }
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
