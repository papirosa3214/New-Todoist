import Foundation
import Observation

/// Стор меток — та же простая стратегия, что `ProjectStore` (правки ждут
/// ответа сервера, без точечной оптимистики).
@MainActor
@Observable
public final class LabelStore {
    public private(set) var labels: [ApiLabel] = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let apiClient: APIClient

    public init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            labels = try await apiClient.labels()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    @discardableResult
    public func create(name: String, color: String? = nil) async -> ApiLabel? {
        do {
            let created = try await apiClient.createLabel(name: name, color: color)
            labels.append(created)
            return created
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    public func delete(labelId: String) async {
        let snapshot = labels
        labels.removeAll { $0.id == labelId }
        do {
            try await apiClient.deleteLabel(id: labelId)
        } catch {
            labels = snapshot
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
