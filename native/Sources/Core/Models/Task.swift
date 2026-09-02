import Foundation

/// `status` — spec/API.md §3.4, CHECK-constraint в БД, закрытый список.
public enum TaskStatus: String, Codable, Sendable, Hashable {
    case active, completed
}

/// `agent_state` — НЕЗАВИСИМОЕ от `status` поле (spec §7): пока агент работает
/// над задачей, `status` весь срок остаётся `active`. Матрица допустимых
/// переходов — на сервере (`canTransition()`), клиент её не дублирует.
public enum AgentState: String, Codable, Sendable, Hashable {
    case inProgress = "in_progress"
    case blocked
    case review
}

/// `ApiTask` — spec/API.md §3.4. Приоритет — обычный `Int` 1...4 (сервер не
/// именует уровни текстом, меньше = важнее); сопоставление в цвет/подпись —
/// дело UI-слоя (`TaskPriority` в `DesignSystem`), Core от него не зависит.
public struct ApiTask: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let description: String?
    /// `'YYYY-MM-DD' | nil` — календарная дата, см. `DateFormats.calendarDate`.
    public let dueDate: String?
    public let projectId: String?
    public let priority: Int
    public let assigneeId: String?
    public let creatorId: String?
    public let status: TaskStatus
    public let createdAt: String?
    public let updatedAt: String?
    public let completedAt: String?
    public let agentState: AgentState?
    public let agentHeartbeatAt: String?
    public let position: Int?
    public let agentSessionId: String?
    /// `'HH:MM'` локальное, nil = задача без времени в календаре.
    public let startTime: String?
    public let durationMin: Int?
    public let pinned: Bool
    /// Есть только в живой БД, НЕ создаётся системой миграций (spec §12 п.6) —
    /// на свежесозданной с нуля базе может отсутствовать вовсе.
    public let parentId: String?

    // MARK: Derived (hydrateTask()/withAgentStale())

    /// `agent_heartbeat_at` старше 15 минут при непустом `agent_state`
    /// («агент пропал») — ОТДЕЛЬНОЕ число от аренды `LEASE_MINUTES=5`, не путать.
    public let agentStale: Bool?
    public let agentStartedAt: String?
    /// ТОЛЬКО в `GET /api/tasks` (список), завязано на текущую сессию.
    public let mine: Bool?
    public let assigneeName: String?
    public let assigneeColor: String?
    public let assigneeAvatarUrl: String?
    public let assigneeInitials: String?
    public let projectName: String?
    public let projectColor: String?
    public let labels: [ApiLabel]
    public let subtasks: [ApiSubtask]
    /// Только `GET /api/tasks/:id` — дочерние задачи (`parent_id` = этот id).
    public let children: [ApiTask]?
    /// Только `GET /api/tasks/:id`.
    public let comments: [ApiComment]?
    /// Только `GET /api/tasks/:id`.
    public let events: [ApiTaskEvent]?
    /// Только `GET /api/tasks/:id` — файлы самой задачи (`kind='task'`).
    public let attachments: [ApiAttachment]?

    enum CodingKeys: String, CodingKey {
        case id, title, description
        case dueDate = "due_date"
        case projectId = "project_id"
        case priority
        case assigneeId = "assignee_id"
        case creatorId = "creator_id"
        case status
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case completedAt = "completed_at"
        case agentState = "agent_state"
        case agentHeartbeatAt = "agent_heartbeat_at"
        case position
        case agentSessionId = "agent_session_id"
        case startTime = "start_time"
        case durationMin = "duration_min"
        case pinned
        case parentId = "parent_id"
        case agentStale = "agent_stale"
        case agentStartedAt = "agent_started_at"
        case mine
        case assigneeName = "assignee_name"
        case assigneeColor = "assignee_color"
        case assigneeAvatarUrl = "assignee_avatar_url"
        case assigneeInitials = "assignee_initials"
        case projectName = "project_name"
        case projectColor = "project_color"
        case labels, subtasks, children, comments, events, attachments
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        priority = try c.decodeIfPresent(Int.self, forKey: .priority) ?? 1
        assigneeId = try c.decodeIfPresent(String.self, forKey: .assigneeId)
        creatorId = try c.decodeIfPresent(String.self, forKey: .creatorId)
        status = try c.decode(TaskStatus.self, forKey: .status)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
        agentState = try c.decodeIfPresent(AgentState.self, forKey: .agentState)
        agentHeartbeatAt = try c.decodeIfPresent(String.self, forKey: .agentHeartbeatAt)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
        agentSessionId = try c.decodeIfPresent(String.self, forKey: .agentSessionId)
        startTime = try c.decodeIfPresent(String.self, forKey: .startTime)
        durationMin = try c.decodeIfPresent(Int.self, forKey: .durationMin)
        pinned = try c.decodeIntBool(forKey: .pinned)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        agentStale = try c.decodeIfPresent(Bool.self, forKey: .agentStale)
        agentStartedAt = try c.decodeIfPresent(String.self, forKey: .agentStartedAt)
        mine = try c.decodeIfPresent(Bool.self, forKey: .mine)
        assigneeName = try c.decodeIfPresent(String.self, forKey: .assigneeName)
        assigneeColor = try c.decodeIfPresent(String.self, forKey: .assigneeColor)
        assigneeAvatarUrl = try c.decodeIfPresent(String.self, forKey: .assigneeAvatarUrl)
        assigneeInitials = try c.decodeIfPresent(String.self, forKey: .assigneeInitials)
        projectName = try c.decodeIfPresent(String.self, forKey: .projectName)
        projectColor = try c.decodeIfPresent(String.self, forKey: .projectColor)
        labels = try c.decodeIfPresent([ApiLabel].self, forKey: .labels) ?? []
        subtasks = try c.decodeIfPresent([ApiSubtask].self, forKey: .subtasks) ?? []
        children = try c.decodeIfPresent([ApiTask].self, forKey: .children)
        comments = try c.decodeIfPresent([ApiComment].self, forKey: .comments)
        events = try c.decodeIfPresent([ApiTaskEvent].self, forKey: .events)
        attachments = try c.decodeIfPresent([ApiAttachment].self, forKey: .attachments)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(dueDate, forKey: .dueDate)
        try c.encodeIfPresent(projectId, forKey: .projectId)
        try c.encode(priority, forKey: .priority)
        try c.encodeIfPresent(assigneeId, forKey: .assigneeId)
        try c.encodeIfPresent(creatorId, forKey: .creatorId)
        try c.encode(status, forKey: .status)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try c.encodeIfPresent(completedAt, forKey: .completedAt)
        try c.encodeIfPresent(agentState, forKey: .agentState)
        try c.encodeIfPresent(agentHeartbeatAt, forKey: .agentHeartbeatAt)
        try c.encodeIfPresent(position, forKey: .position)
        try c.encodeIfPresent(agentSessionId, forKey: .agentSessionId)
        try c.encodeIfPresent(startTime, forKey: .startTime)
        try c.encodeIfPresent(durationMin, forKey: .durationMin)
        try c.encode(pinned ? 1 : 0, forKey: .pinned)
        try c.encodeIfPresent(parentId, forKey: .parentId)
        try c.encodeIfPresent(agentStale, forKey: .agentStale)
        try c.encodeIfPresent(agentStartedAt, forKey: .agentStartedAt)
        try c.encodeIfPresent(mine, forKey: .mine)
        try c.encodeIfPresent(assigneeName, forKey: .assigneeName)
        try c.encodeIfPresent(assigneeColor, forKey: .assigneeColor)
        try c.encodeIfPresent(assigneeAvatarUrl, forKey: .assigneeAvatarUrl)
        try c.encodeIfPresent(assigneeInitials, forKey: .assigneeInitials)
        try c.encodeIfPresent(projectName, forKey: .projectName)
        try c.encodeIfPresent(projectColor, forKey: .projectColor)
        try c.encode(labels, forKey: .labels)
        try c.encode(subtasks, forKey: .subtasks)
        try c.encodeIfPresent(children, forKey: .children)
        try c.encodeIfPresent(comments, forKey: .comments)
        try c.encodeIfPresent(events, forKey: .events)
        try c.encodeIfPresent(attachments, forKey: .attachments)
    }

    // MARK: Удобные вычисляемые даты (raw-строки остаются полями — см. DateFormats)

    public var createdAtDate: Date? { DateFormats.sqliteUTC(createdAt) }
    public var updatedAtDate: Date? { DateFormats.sqliteUTC(updatedAt) }
    public var completedAtDate: Date? { DateFormats.sqliteUTC(completedAt) }
    public var dueDateAsDate: Date? { DateFormats.calendarDate(dueDate) }
    public var isDueToday: Bool { dueDate == DateFormats.todayString() }
}
