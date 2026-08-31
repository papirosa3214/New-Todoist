import Foundation

/// `ApiNotification` — spec/API.md §3.7. `type` — открытый список
/// (`"assigned" | "completed" | "commented" | "subtask_created" | "new_task"
/// | string`), разбирается как `String`. `read` — SQLite 0/1.
public struct ApiNotification: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let userId: String?
    public let type: String
    public let taskId: String?
    public let text: String?
    public let read: Bool
    public let createdAt: String?
    /// Кто вызвал событие — `nil` у старых записей, созданных до появления поля.
    public let actorId: String?
    public let actorName: String?
    public let actorColor: String?
    public let actorAvatarUrl: String?
    public let actorInitials: String?
    public let userName: String?
    public let userColor: String?
    public let userInitials: String?
    public let taskTitle: String?

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case type
        case taskId = "task_id"
        case text, read
        case createdAt = "created_at"
        case actorId = "actor_id"
        case actorName = "actor_name"
        case actorColor = "actor_color"
        case actorAvatarUrl = "actor_avatar_url"
        case actorInitials = "actor_initials"
        case userName = "user_name"
        case userColor = "user_color"
        case userInitials = "user_initials"
        case taskTitle = "task_title"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        userId = try c.decodeIfPresent(String.self, forKey: .userId)
        type = try c.decode(String.self, forKey: .type)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        text = try c.decodeIfPresent(String.self, forKey: .text)
        read = try c.decodeIntBool(forKey: .read)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        actorId = try c.decodeIfPresent(String.self, forKey: .actorId)
        actorName = try c.decodeIfPresent(String.self, forKey: .actorName)
        actorColor = try c.decodeIfPresent(String.self, forKey: .actorColor)
        actorAvatarUrl = try c.decodeIfPresent(String.self, forKey: .actorAvatarUrl)
        actorInitials = try c.decodeIfPresent(String.self, forKey: .actorInitials)
        userName = try c.decodeIfPresent(String.self, forKey: .userName)
        userColor = try c.decodeIfPresent(String.self, forKey: .userColor)
        userInitials = try c.decodeIfPresent(String.self, forKey: .userInitials)
        taskTitle = try c.decodeIfPresent(String.self, forKey: .taskTitle)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(userId, forKey: .userId)
        try c.encode(type, forKey: .type)
        try c.encodeIfPresent(taskId, forKey: .taskId)
        try c.encodeIfPresent(text, forKey: .text)
        try c.encode(read ? 1 : 0, forKey: .read)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(actorId, forKey: .actorId)
        try c.encodeIfPresent(actorName, forKey: .actorName)
        try c.encodeIfPresent(actorColor, forKey: .actorColor)
        try c.encodeIfPresent(actorAvatarUrl, forKey: .actorAvatarUrl)
        try c.encodeIfPresent(actorInitials, forKey: .actorInitials)
        try c.encodeIfPresent(userName, forKey: .userName)
        try c.encodeIfPresent(userColor, forKey: .userColor)
        try c.encodeIfPresent(userInitials, forKey: .userInitials)
        try c.encodeIfPresent(taskTitle, forKey: .taskTitle)
    }

    public var createdAtDate: Date? { DateFormats.sqliteUTC(createdAt) }
}
