import Foundation
import Observation

/// Стор уведомлений — загрузка + приём `notification:new` по WS (spec §4.1).
@MainActor
@Observable
public final class NotificationStore {
    public private(set) var notifications: [ApiNotification] = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    public var unreadCount: Int { notifications.count(where: { !$0.read }) }

    private let apiClient: APIClient

    public init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            notifications = try await apiClient.notifications()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    public func markRead(id: String) async {
        guard let index = notifications.firstIndex(where: { $0.id == id }) else { return }
        do {
            notifications[index] = try await apiClient.markNotificationRead(id: id)
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    public func apply(_ event: RealtimeEvent) {
        if case .notificationNew(let notification) = event {
            // Дедуп по id — страховка на случай дублирующего события с WS
            // (напр. короткое окно двойного реконнекта), не должно давать
            // одно и то же уведомление в списке дважды.
            guard !notifications.contains(where: { $0.id == notification.id }) else { return }
            notifications.insert(notification, at: 0)
        }
    }
}
