import Foundation
import Observation

/// Стор задач — загрузка, кэш в памяти, оптимистичные изменения с откатом,
/// приём реалтайм-событий. spec/API.md §8: у веба списки инвалидируются
/// целиком при любой мутации (react-query, довольно грубо) — здесь сделано
/// ТОЧЕЧНО (заменить/добавить/убрать один элемент), это не расхождение с
/// контрактом сервера, только другая (более дешёвая) стратегия кэша на
/// стороне клиента, спека явно разрешает это решать автору клиента.
@MainActor
@Observable
public final class TaskStore {
    public private(set) var tasks: [ApiTask] = []
    public private(set) var isLoading = false
    public var errorMessage: String?

    private let apiClient: APIClient

    public init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    /// `silent` — обновление в фоне, без спиннера. Нужно для рефетча после
    /// переподключения: спиннер вставлялся блоком в начало ленты, список
    /// прыгал, и владелец видел это как «экран моргает сам по себе».
    public func load(silent: Bool = false) async {
        if !silent { isLoading = true }
        errorMessage = nil
        defer { if !silent { isLoading = false } }
        do {
            tasks = try await apiClient.tasks()
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    /// Партиальная правка с оптимистичным откликом: локальная копия меняется
    /// СРАЗУ через `apply`, запрос уходит в фоне; при ошибке — откат к
    /// снимку до правки (spec §8: у веба это точечный приём, не универсальный,
    /// используется в первую очередь для быстрых визуальных изменений вроде
    /// перетаскивания — здесь доступен любому вызывающему коду).
    @discardableResult
    public func patch(taskId: String, fields: [String: JSONValue], apply: (inout ApiTask) -> Void) async -> Bool {
        guard let index = tasks.firstIndex(where: { $0.id == taskId }) else { return false }
        let snapshot = tasks[index]
        apply(&tasks[index])
        do {
            let updated = try await apiClient.patchTask(id: taskId, fields: fields)
            if let freshIndex = tasks.firstIndex(where: { $0.id == taskId }) {
                tasks[freshIndex] = updated
            }
            return true
        } catch {
            if let freshIndex = tasks.firstIndex(where: { $0.id == taskId }) {
                tasks[freshIndex] = snapshot
            }
            errorMessage = Self.message(for: error)
            return false
        }
    }

    @discardableResult
    public func create(_ payload: APIClient.NewTaskRequest) async -> ApiTask? {
        do {
            let created = try await apiClient.createTask(payload)
            tasks.append(created)
            return created
        } catch {
            errorMessage = Self.message(for: error)
            return nil
        }
    }

    public func delete(taskId: String) async {
        let snapshot = tasks
        tasks.removeAll { $0.id == taskId }
        do {
            try await apiClient.deleteTask(id: taskId)
        } catch {
            tasks = snapshot
            errorMessage = Self.message(for: error)
        }
    }

    /// Приём событий `RealtimeClient.onEvent` — вызывающая сторона (обычно
    /// `TaskFlowApp`) подписывает этот метод один раз при старте.
    public func apply(_ event: RealtimeEvent) {
        switch event {
        case .taskCreated(let task), .taskUpdated(let task), .taskCompleted(let task), .taskState(let task):
            upsert(task)
        case .taskDeleted(let id):
            tasks.removeAll { $0.id == id }
        default:
            break
        }
    }

    /// После восстановления связи (`RealtimeClient.onReconnected`) — сервер
    /// не хранит очередь пропущенного за время разрыва (spec §4.2), поэтому
    /// полный рефетч, а не точечная синхронизация.
    public func refreshAfterReconnect() async {
        await load(silent: true)
    }

    private func upsert(_ task: ApiTask) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.append(task)
        }
    }

    private static func message(for error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}
