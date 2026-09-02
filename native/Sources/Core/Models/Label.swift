import Foundation

/// `ApiLabel` — spec/API.md §3.3. Без derived-полей, отдаётся как есть.
public struct ApiLabel: Codable, Identifiable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let color: String?
    public let ownerId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, color
        case ownerId = "owner_id"
    }
}
