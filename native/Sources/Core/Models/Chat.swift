import Foundation

/// `channel` — spec/API.md §3.9: `"owner"` — разговор владельца с
/// оркестратором, `"agents"` — переписка между исполнителями. Канал
/// проставляет СЕРВЕР по ролям отправителя/адресата, клиент его не выбирает.
public enum ChatChannel: String, Codable, Sendable, Hashable {
    case owner, agents
}

/// `kind` — русские литералы `"совещание" | "делегирование" | "находка" |
/// null` (spec §3.9). Технически закрытый список в документе, но сохраняем
/// `.other(_:)` защитным вариантом: одно неожиданное значение не должно
/// ронять декодирование всей ленты чата.
public enum ChatMessageKind: Sendable, Hashable {
    case meeting     // "совещание"
    case delegation  // "делегирование"
    case finding     // "находка"
    case other(String)

    public var rawValue: String {
        switch self {
        case .meeting: "совещание"
        case .delegation: "делегирование"
        case .finding: "находка"
        case .other(let v): v
        }
    }
}

extension ChatMessageKind: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        switch raw {
        case "совещание": self = .meeting
        case "делегирование": self = .delegation
        case "находка": self = .finding
        default: self = .other(raw)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// `ApiChatMessage` — spec/API.md §3.9.
public struct ApiChatMessage: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let channel: ChatChannel
    public let fromUserId: String?
    /// `nil` = «всем».
    public let toUserId: String?
    /// `nil` = сообщение не привязано к задаче.
    public let taskId: String?
    public let kind: ChatMessageKind?
    public let text: String
    public let createdAt: String?
    public let fromUserName: String?
    public let fromUserColor: String?
    public let fromUserAvatarUrl: String?
    public let fromUserInitials: String?
    /// Пусто при `toUserId == nil`.
    public let toUserName: String?
    public let toUserColor: String?
    public let taskTitle: String?
    public let attachments: [ApiChatAttachment]?

    enum CodingKeys: String, CodingKey {
        case id, channel
        case fromUserId = "from_user_id"
        case toUserId = "to_user_id"
        case taskId = "task_id"
        case kind, text
        case createdAt = "created_at"
        case fromUserName = "from_user_name"
        case fromUserColor = "from_user_color"
        case fromUserAvatarUrl = "from_user_avatar_url"
        case fromUserInitials = "from_user_initials"
        case toUserName = "to_user_name"
        case toUserColor = "to_user_color"
        case taskTitle = "task_title"
        case attachments
    }

    public var createdAtDate: Date? { DateFormats.sqliteUTC(createdAt) }
}

/// `ApiChatParticipant` — список возможных собеседников (spec §3.9).
public struct ApiChatParticipant: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let type: UserType
    public let role: UserRole?
    public let avatarColor: String?
    public let avatarUrl: String?
    public let initials: String?

    enum CodingKeys: String, CodingKey {
        case id, name, type, role
        case avatarColor = "avatar_color"
        case avatarUrl = "avatar_url"
        case initials
    }
}

// MARK: - ApiChatStats — ключи ДОСЛОВНО на русском (spec §3.9), нужны явные CodingKeys.

public struct ApiChatStatsEntry: Codable, Sendable, Hashable {
    public let id: String?
    public let name: String
    public let count: Int

    enum CodingKeys: String, CodingKey {
        case id
        case name = "имя"
        case count = "сообщений"
    }
}

public struct ApiChatStatsPair: Codable, Sendable, Hashable {
    public let fromId: String?
    public let from: String
    public let toId: String?
    public let to: String
    public let count: Int

    enum CodingKeys: String, CodingKey {
        case fromId = "от_id"
        case from = "от"
        case toId = "кому_id"
        case to = "кому"
        case count = "сообщений"
    }
}

public struct ApiChatStats: Codable, Sendable, Hashable {
    public let total: Int
    public let to: [ApiChatStatsEntry]
    public let from: [ApiChatStatsEntry]
    public let pairs: [ApiChatStatsPair]

    enum CodingKeys: String, CodingKey {
        case total = "всего"
        case to = "кому"
        case from = "от_кого"
        case pairs = "пары"
    }
}
