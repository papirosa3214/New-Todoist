import Foundation

/// Задачи — spec/API.md §5.1, и агентский протокол работы над задачей — §5.2/§7.
public extension APIClient {

    /// `includeChildren` — query `include_children` (spec §5.1).
    func tasks(includeChildren: Bool = false) async throws -> [ApiTask] {
        var query: [URLQueryItem] = []
        if includeChildren { query.append(URLQueryItem(name: "include_children", value: "true")) }
        return try await request(.get, "/tasks", query: query)
    }

    /// 404, если задача не видна по роли вызывающего (spec §2.3).
    func task(id: String) async throws -> ApiTask {
        try await request(.get, "/tasks/\(id)")
    }

    /// Тело создания — строго типизированная структура (в отличие от PATCH,
    /// здесь все поля известны заранее, партиальность не нужна).
    struct NewTaskRequest: Encodable, Sendable {
        public var title: String
        public var description: String?
        public var dueDate: String?
        public var startTime: String?
        public var durationMin: Int?
        public var projectId: String?
        public var assigneeId: String?
        public var priority: Int?
        public var parentId: String?
        public var labelIds: [String]?
        public var subtasks: [String]?

        enum CodingKeys: String, CodingKey {
            case title, description
            case dueDate = "due_date"
            case startTime = "start_time"
            case durationMin = "duration_min"
            case projectId = "project_id"
            case assigneeId = "assignee_id"
            case priority
            case parentId = "parent_id"
            case labelIds = "label_ids"
            case subtasks
        }

        public init(
            title: String, description: String? = nil, dueDate: String? = nil,
            startTime: String? = nil, durationMin: Int? = nil, projectId: String? = nil,
            assigneeId: String? = nil, priority: Int? = nil, parentId: String? = nil,
            labelIds: [String]? = nil, subtasks: [String]? = nil
        ) {
            self.title = title; self.description = description; self.dueDate = dueDate
            self.startTime = startTime; self.durationMin = durationMin; self.projectId = projectId
            self.assigneeId = assigneeId; self.priority = priority; self.parentId = parentId
            self.labelIds = labelIds; self.subtasks = subtasks
        }
    }

    func createTask(_ payload: NewTaskRequest) async throws -> ApiTask {
        try await request(.post, "/tasks", body: payload)
    }

    /// Партиальное обновление — `[String: JSONValue]`, а не типизированная
    /// структура: PATCH шлёт РОВНО те поля, что нужно поменять (см. комментарий
    /// в `JSONValue`). Разрешённые поля сервером — `title, description,
    /// due_date, start_time, duration_min, project_id, parent_id, priority,
    /// assignee_id, status, position, pinned` (остальные молча игнорируются).
    /// ⚠️ Смена `status` требует роль owner/orchestrator — агенту 403 (spec §9 п.1).
    func patchTask(id: String, fields: [String: JSONValue]) async throws -> ApiTask {
        try await request(.patch, "/tasks/\(id)", body: fields)
    }

    /// Только создатель задачи ИЛИ владелец — оркестратору 403 (spec §5.1).
    func deleteTask(id: String) async throws {
        let _: APIOkResponse = try await request(.delete, "/tasks/\(id)")
    }

    // MARK: - Агентский протокол (spec §5.2/§7) — на карточке задачи владелец
    // видит статус агента/аренду, поэтому клиенту нужно уметь их читать; сами
    // мутации (claim/heartbeat/state) пригодятся экрану «Работа агента».

    func claimTask(id: String, sessionId: String? = nil) async throws -> ApiTask {
        var body: [String: JSONValue] = [:]
        if let sessionId { body["session_id"] = .string(sessionId) }
        return try await request(.post, "/tasks/\(id)/claim", body: body)
    }

    func heartbeatTask(id: String, sessionId: String? = nil) async throws -> ApiTask {
        var body: [String: JSONValue] = [:]
        if let sessionId { body["session_id"] = .string(sessionId) }
        return try await request(.post, "/tasks/\(id)/heartbeat", body: body)
    }

    /// Комментарий ОБЯЗАТЕЛЕН при переходе в `blocked`/`review` и при
    /// `review → in_progress` — без него сервер отвечает 400 (spec §7).
    func setTaskAgentState(id: String, state: AgentState?, comment: String? = nil) async throws -> ApiTask {
        var body: [String: JSONValue] = ["state": state.map { JSONValue.string($0.rawValue) } ?? .null]
        if let comment { body["comment"] = .string(comment) }
        return try await request(.post, "/tasks/\(id)/state", body: body)
    }

    func agentRules() async throws -> [String] {
        struct Response: Decodable { let rules: [String] }
        let response: Response = try await request(.get, "/agent/rules")
        return response.rules
    }
}
