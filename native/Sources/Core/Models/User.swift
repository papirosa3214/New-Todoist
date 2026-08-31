import Foundation

/// Роль в системе — spec/API.md §2.3. ЧЕТЫРЕ круга видимости, не три
/// (устаревшее `AGENT-API.md`, см. spec §9 п.2): владелец / оркестратор /
/// агент (`type=ai`) / самозарегистрированный человек (тоже `role=agent`,
/// отличие только в `type=human`). `viewer` в CHECK-constraint есть, но по
/// факту нигде не используется — считать зарезервированным.
public enum UserRole: String, Codable, Sendable, Hashable {
    case owner, agent, viewer, orchestrator
}

public enum UserType: String, Codable, Sendable, Hashable {
    case human, ai
}

public enum UserPresenceStatus: String, Codable, Sendable, Hashable {
    case online, offline
}

/// `remaining` в API документирован как `number | string` (spec §3.1) — сервер
/// не гарантирует один и тот же тип, разбираем обе формы.
public enum RemainingValue: Codable, Sendable, Hashable {
    case number(Double)
    case text(String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .text(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let v): try container.encode(v)
        case .text(let v): try container.encode(v)
        }
    }
}

public struct UserLimits: Codable, Sendable, Hashable {
    public let remaining: RemainingValue?
}

/// `ApiUser` — spec/API.md §3.1. Derived-поля (`activity`, `online`,
/// `last_action*`, `limits`) приходят ТОЛЬКО из `GET /api/agents` — проверено
/// живым запросом 31.08.2026. В задачах/комментариях/чате приходит другой,
/// укороченный набор (`assignee_name`/`_color`/... прямо на самой сущности) —
/// эти поля живут в соответствующих моделях (`ApiTask`, `ApiComment`...), не здесь.
public struct ApiUser: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let email: String?
    public let role: UserRole
    public let type: UserType
    public let avatarColor: String?
    public let initials: String?
    public let status: UserPresenceStatus?
    public let createdAt: String?
    /// ⚠️ Число, а не `Bool`: sqlite хранит булево как 0/1, и `/api/auth/login`
    /// отдаёт строку пользователя как есть (`SELECT *` минус секреты), то есть
    /// `"is_system_bot": 0`. Swift такой JSON в `Bool` не разбирает — вход
    /// падал с «Не удалось разобрать ответ сервера» (01.09.2026, поймано на
    /// живом телефоне). У `/api/auth/me` этого поля в выборке нет, поэтому
    /// там ошибка не всплывала. Читать через `isSystemBotFlag`.
    public let isSystemBot: Int?
    public let createdBy: String?
    public let avatarUrl: String?
    public let avatarUrlWorking: String?
    public let avatarUrlBlocked: String?
    /// Есть в живой БД, но НЕ создаётся системой миграций (spec §12 п.6) —
    /// на свежей базе может отсутствовать. Формат — ISO8601 с миллисекундами,
    /// ОТДЕЛЬНЫЙ от sqlite-формата остальных `*_at` (проверено живым запросом).
    public let lastSeenAt: String?

    // Derived — только GET /api/agents
    public let activity: String?
    public let online: Bool?
    public let lastAction: String?
    public let lastActionTitle: String?
    public let limits: UserLimits?

    enum CodingKeys: String, CodingKey {
        case id, name, email, role, type
        case avatarColor = "avatar_color"
        case initials, status
        case createdAt = "created_at"
        case isSystemBot = "is_system_bot"
        case createdBy = "created_by"
        case avatarUrl = "avatar_url"
        case avatarUrlWorking = "avatar_url_working"
        case avatarUrlBlocked = "avatar_url_blocked"
        case lastSeenAt = "last_seen_at"
        case activity, online
        case lastAction = "last_action"
        case lastActionTitle = "last_action_title"
        case limits
    }

    /// Системный бот? — человеческий вид сырого 0/1 из sqlite.
    public var isSystemBotFlag: Bool { (isSystemBot ?? 0) != 0 }

    public var lastSeenDate: Date? { DateFormats.iso8601(lastSeenAt) }
    public var createdAtDate: Date? { DateFormats.sqliteUTC(createdAt) }
}
