import Foundation

/// Derived-состояние подзадачи (`withSubtaskState()`, вычисляется при КАЖДОЙ
/// отдаче, не хранится) — spec/API.md §3.5.
public enum SubtaskState: String, Codable, Sendable, Hashable {
    case done, running, pending, blocked
}

/// `ApiSubtask` — spec/API.md §3.5. `done` — SQLite 0/1, приведено к Bool.
public struct ApiSubtask: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let taskId: String?
    public let title: String
    public let done: Bool
    public let position: Int?
    public let agentState: AgentState?
    public let agentId: String?
    public let agentHeartbeatAt: String?
    /// Отчёт агента — максимум 400 символов (`RESULT_MAX`).
    public let result: String?
    public let agentSessionId: String?
    /// Derived, см. заголовок файла.
    public let state: SubtaskState?

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case title, done, position
        case agentState = "agent_state"
        case agentId = "agent_id"
        case agentHeartbeatAt = "agent_heartbeat_at"
        case result
        case agentSessionId = "agent_session_id"
        case state
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        title = try c.decode(String.self, forKey: .title)
        done = try c.decodeIntBool(forKey: .done)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
        agentState = try c.decodeIfPresent(AgentState.self, forKey: .agentState)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        agentHeartbeatAt = try c.decodeIfPresent(String.self, forKey: .agentHeartbeatAt)
        result = try c.decodeIfPresent(String.self, forKey: .result)
        agentSessionId = try c.decodeIfPresent(String.self, forKey: .agentSessionId)
        state = try c.decodeIfPresent(SubtaskState.self, forKey: .state)
    }

    public init(
        id: String, taskId: String?, title: String, done: Bool, position: Int?,
        agentState: AgentState?, agentId: String?, agentHeartbeatAt: String?,
        result: String?, agentSessionId: String?, state: SubtaskState?
    ) {
        self.id = id; self.taskId = taskId; self.title = title; self.done = done
        self.position = position; self.agentState = agentState; self.agentId = agentId
        self.agentHeartbeatAt = agentHeartbeatAt; self.result = result
        self.agentSessionId = agentSessionId; self.state = state
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(taskId, forKey: .taskId)
        try c.encode(title, forKey: .title)
        try c.encode(done ? 1 : 0, forKey: .done)
        try c.encodeIfPresent(position, forKey: .position)
        try c.encodeIfPresent(agentState, forKey: .agentState)
        try c.encodeIfPresent(agentId, forKey: .agentId)
        try c.encodeIfPresent(agentHeartbeatAt, forKey: .agentHeartbeatAt)
        try c.encodeIfPresent(result, forKey: .result)
        try c.encodeIfPresent(agentSessionId, forKey: .agentSessionId)
        try c.encodeIfPresent(state, forKey: .state)
    }
}
