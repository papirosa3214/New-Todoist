import Foundation

/// `ApiNote` — spec/API.md §3.10/5.9. ⚠️ Спека даёт формат хранения (TipTap
/// JSON в `user_notes.content`, конвертация в markdown через `?format=markdown`)
/// и часть тела запроса (`{ folder_id?, content }`), но НЕ полную схему
/// таблицы `user_notes` — сервер этого места не вычитан построчно (spec §10).
/// Поэтому здесь только поля, прямо подтверждённые документом; исполнителю
/// экрана «Заметки» (Волна 2) при необходимости — свериться с живым ответом
/// сервера перед тем, как опираться на дополнительные поля.
public struct ApiNote: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let folderId: Int?
    /// `GET /notes/:id?format=markdown` отдаёт markdown-СТРОКУ вместо TipTap
    /// JSON — используй `content.stringValue` в этом случае, иначе структура
    /// узлов лежит в `content` как есть (`.object`/`.array`).
    public let content: JSONValue?
    public let createdAt: String?
    public let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case folderId = "folder_id"
        case content
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// `journal_folders` — дерево папок заметок (spec §3.10/5.9), самоссылка на
/// `parent_id`. Полная схема так же не вычитана построчно — только
/// подтверждённые поля.
public struct ApiJournalFolder: Codable, Identifiable, Sendable, Hashable {
    public let id: Int
    public let name: String
    public let parentId: Int?

    enum CodingKeys: String, CodingKey {
        case id, name
        case parentId = "parent_id"
    }
}
