import Foundation

/// Уведомления — spec/API.md §5.7.
public extension APIClient {
    func notifications() async throws -> [ApiNotification] {
        try await request(.get, "/notifications")
    }

    func markNotificationRead(id: String) async throws -> ApiNotification {
        try await request(.patch, "/notifications/\(id)", body: ["read": true] as [String: Bool])
    }

    func deleteNotification(id: String) async throws {
        let _: APIOkResponse = try await request(.delete, "/notifications/\(id)")
    }
}
