import Foundation

/// `ApiAttachment` — spec/API.md §3.6. НЕ содержит байтов файла, только
/// метаданные — сами байты отдельным запросом `GET /api/attachments/:id`.
public struct ApiAttachment: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let taskId: String?
    public let commentId: String?
    public let userId: String?
    public let fileName: String
    public let mime: String?
    public let size: Int?
    public let createdAt: String?
    /// `'task' | 'comment'`, default `'comment'` — не закрытый в TS-типе список,
    /// разбираем как строку, а не enum (см. правило проекта: закрыты только
    /// поля с CHECK-constraint в БД).
    public let kind: String?
    public let chatMessageId: String?

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case commentId = "comment_id"
        case userId = "user_id"
        case fileName = "file_name"
        case mime, size
        case createdAt = "created_at"
        case kind
        case chatMessageId = "chat_message_id"
    }
}

/// Урезанный набор вложения в чате (`ApiChatAttachment`, spec §3.9) — без
/// `comment_id`/`created_at`.
public struct ApiChatAttachment: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let fileName: String
    public let mime: String?
    public let size: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case fileName = "file_name"
        case mime, size
    }
}
