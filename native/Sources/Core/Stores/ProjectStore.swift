import Foundation
import Observation

/// Стор проектов — загрузка + кэш в памяти. Проекты меняются редко
/// относительно задач, поэтому без точечной оптимистики: правки ждут ответа
/// сервера (spec §8 — так делает и веб для не-drag&drop мутаций).
@MainActor
@Observable
public final class ProjectStore {
    public private(set) var projects: [ApiProject] = []
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
            projects = try await apiClient.projects()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    @discardableResult
    public func create(name: String, color: String? = nil, withDocs: Bool = false) async -> ApiProject? {
        do {
            let created = try await apiClient.createProject(name: name, color: color, withDocs: withDocs)
            projects.append(created)
            return created
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
            return nil
        }
    }

    public func delete(projectId: String) async {
        let snapshot = projects
        projects.removeAll { $0.id == projectId }
        do {
            try await apiClient.deleteProject(id: projectId)
        } catch {
            projects = snapshot
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
