import Foundation

/// `ApiComment` — spec/API.md §3.6: поля `comments` + join `user_name/_color/
/// _avatar_url/_initials` + опциональные вложения.
public struct ApiComment: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let taskId: String?
    public let userId: String?
    public let text: String
    public let createdAt: String?
    public let userName: String?
    public let userColor: String?
    public let userAvatarUrl: String?
    public let userInitials: String?
    public let attachments: [ApiAttachment]?

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case userId = "user_id"
        case text
        case createdAt = "created_at"
        case userName = "user_name"
        case userColor = "user_color"
        case userAvatarUrl = "user_avatar_url"
        case userInitials = "user_initials"
        case attachments
    }

    public var createdAtDate: Date? { DateFormats.sqliteUTC(createdAt) }
}
