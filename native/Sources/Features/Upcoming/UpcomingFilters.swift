import SwiftUI

// Фильтры экрана — spec/SCREENS-1.md §4.3 (`lib/taskFilters.ts`) + §3.9
// (`TaskFilterSheet`). Свой локальный дубль формы фильтров, не общий тип
// из `Features/Today` — экраны сдаются по одному (`ARCHITECTURE.md` п.1),
// у каждого своя копия ровно того, что описывает спека.
struct UpcomingTaskFilters: Equatable {
    var projectId: String?
    var labelId: String?
    /// nil — все, "__none" — без исполнителя, иначе id.
    var assigneeKey: String?
    var showCompleted = false

    static let empty = UpcomingTaskFilters()

    var isActive: Bool {
        projectId != nil || labelId != nil || assigneeKey != nil || showCompleted
    }
}

struct UpcomingFilterOption: Identifiable, Hashable {
    let id: String
    let label: String
    let color: Color
}

struct UpcomingAssigneeOption: Identifiable, Hashable {
    let id: String
    let name: String
    let color: Color
    let initials: String
}

enum UpcomingFilterEngine {
    static func matches(_ task: ApiTask, _ filters: UpcomingTaskFilters) -> Bool {
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

    static func filter(_ tasks: [ApiTask], _ filters: UpcomingTaskFilters) -> [ApiTask] {
        tasks.filter { matches($0, filters) }
    }

    /// Опции строятся из ПОЛНОГО набора задач раздела (до фильтра проекта) —
    /// вариант не исчезает из списка только потому, что сейчас сужено чем-то другим (spec §4.3).
    static func projectOptions(_ tasks: [ApiTask]) -> [UpcomingFilterOption] {
        var seen = Set<String>()
        var result: [UpcomingFilterOption] = []
        for t in tasks {
            guard let id = t.projectId, let name = t.projectName, !seen.contains(id) else { continue }
            seen.insert(id)
            result.append(UpcomingFilterOption(id: id, label: name, color: Color(hex: t.projectColor ?? "#A6A6A6")))
        }
        return result.sorted { $0.label.localizedCompare($1.label) == .orderedAscending }
    }

    static func labelOptions(_ tasks: [ApiTask]) -> [UpcomingFilterOption] {
        var seen = Set<String>()
        var result: [UpcomingFilterOption] = []
        for t in tasks {
            for l in t.labels where !seen.contains(l.id) {
                seen.insert(l.id)
                result.append(UpcomingFilterOption(id: l.id, label: l.name, color: Color(hex: l.color ?? "#A6A6A6")))
            }
        }
        return result.sorted { $0.label.localizedCompare($1.label) == .orderedAscending }
    }

    static func assigneeOptions(_ tasks: [ApiTask]) -> (list: [UpcomingAssigneeOption], hasUnassigned: Bool) {
        var seen = Set<String>()
        var result: [UpcomingAssigneeOption] = []
        var hasUnassigned = false
        for t in tasks {
            if let id = t.assigneeId {
                if !seen.contains(id) {
                    seen.insert(id)
                    result.append(UpcomingAssigneeOption(
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

    /// Задача назначена ИИ-агенту, а не человеку — `isAgentAssignedTask` (spec §5.2):
    /// такие задачи на «Планировании» не показываются вовсе.
    static func isAgentAssigned(_ task: ApiTask, _ agents: [ApiUser]) -> Bool {
        // `assignee_type` приходит в самой задаче: не ждём отдельный запрос
        // списка агентов и не смешиваем поручения с личным планированием.
        task.assigneeType == .ai
    }
}

/// Список агентов только ради фильтра `isAgentAssigned` выше — в `Core` нет
/// общего `AgentStore` (только Task/Project/Label/Notification, см.
/// `TaskFlowApp.swift`), заводить его самому нельзя (Core правит только
/// каркасный исполнитель). Свой `APIClient()` безопасен: он не хранит
/// состояние сессии, токен читает из Keychain на каждый запрос сам
/// (комментарий в `APIClient.swift`), поэтому второй экземпляр — не второй
/// источник правды, просто ещё один клиент того же REST API.
@MainActor
@Observable
final class UpcomingAgentsProvider {
    private(set) var agents: [ApiUser] = []
    private let client = APIClient()

    func load() async {
        agents = (try? await client.agents()) ?? []
    }
}
