import Foundation

/// `ApiProject` — spec/API.md §3.2. `pinned` — SQLite 0/1 в БД, приведено к
/// Bool декодером (см. `CodableHelpers`). `taskCount` — derived, только в
/// ответе API, не хранится как поле БД.
public struct ApiProject: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let color: String?
    public let ownerId: String?
    public let createdAt: String?
    public let position: Int?
    public let pinned: Bool
    public let notesFolderId: Int?
    public let taskCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, name, color
        case ownerId = "owner_id"
        case createdAt = "created_at"
        case position, pinned
        case notesFolderId = "notes_folder_id"
        case taskCount = "task_count"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        color = try c.decodeIfPresent(String.self, forKey: .color)
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
        pinned = try c.decodeIntBool(forKey: .pinned)
        notesFolderId = try c.decodeIfPresent(Int.self, forKey: .notesFolderId)
        taskCount = try c.decodeIfPresent(Int.self, forKey: .taskCount)
    }

    public init(
        id: String, name: String, color: String?, ownerId: String?, createdAt: String?,
        position: Int?, pinned: Bool, notesFolderId: Int?, taskCount: Int?
    ) {
        self.id = id; self.name = name; self.color = color; self.ownerId = ownerId
        self.createdAt = createdAt; self.position = position; self.pinned = pinned
        self.notesFolderId = notesFolderId; self.taskCount = taskCount
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(color, forKey: .color)
        try c.encodeIfPresent(ownerId, forKey: .ownerId)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(position, forKey: .position)
        try c.encode(pinned ? 1 : 0, forKey: .pinned)
        try c.encodeIfPresent(notesFolderId, forKey: .notesFolderId)
        try c.encodeIfPresent(taskCount, forKey: .taskCount)
    }
}
