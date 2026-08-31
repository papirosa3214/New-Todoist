import Foundation
import Observation

// Вью-модель формы задачи — spec/SCREENS-1.md §5.5. Своя `APIClient()`, а не
// из окружения: `TaskFlowApp` кладёт в `.environment` только сторы, сам
// клиент нигде не раздаётся (см. отчёт — предложение добавить его в
// environment для будущих экранов).
@MainActor
@Observable
final class TaskFormViewModel {
    let taskID: String?
    private let apiClient = APIClient()

    var title = ""
    var taskDescription = ""
    var subtaskDrafts: [SubtaskDraft] = [] // режим create
    var subtasks: [ApiSubtask] = []        // режим edit — с сервера
    var dueDate: Date?
    var startMinutes: Int?
    var durationMin: Int?
    var projectId: String?
    var priority: TaskPriority = .low
    var selectedLabelIds: Set<String> = []
    var assigneeId: String?
    var attachments: TaskAttachmentsController

    var isLoadingTask = false
    var isSaving = false
    var notFound = false
    var loadErrorMessage: String?
    var saveErrorMessage: String?
    var directoriesErrorMessage: String?
    var agents: [ApiUser] = []

    private var originalTask: ApiTask?

    var isEditing: Bool { taskID != nil }
    var isSaveEnabled: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving }
    /// «Структурировать с AI» — пункт 2 §5.5: показывается, если в названии/описании уже есть текст.
    var showAiButton: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty || !taskDescription.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// `startDictation` — сам диктовку не подключает (в проекте нигде нет
    /// живого ASR-провода на native, см. `NATIVE-PARTS.md`), только держит
    /// флаг для экрана: сфокусировать поле названия и показать кнопку
    /// микрофона (по просьбе оркестратора — открыть форму «в нужном
    /// состоянии», без самого распознавания).
    let startDictation: Bool

    /// `presetDueToday`/`startDictation` — контракт `INTEGRATION.md`
    /// (обновлён оркестратором по ходу этой задачи): `/task/new?due=today`
    /// и `/task/new?dictate=1` из CreateMenu веба.
    init(taskID: String?, presetDueToday: Bool = false, startDictation: Bool = false) {
        self.taskID = taskID
        self.startDictation = startDictation
        self.attachments = TaskAttachmentsController(apiClient: APIClient(), taskId: taskID)
        if presetDueToday, taskID == nil {
            var cal = Calendar(identifier: .gregorian)
            cal.timeZone = TaskDateText.moscow
            dueDate = cal.startOfDay(for: Date())
        }
    }

    func loadIfNeeded() async {
        guard let taskID else { return }
        isLoadingTask = true
        defer { isLoadingTask = false }
        do {
            let task = try await apiClient.task(id: taskID)
            originalTask = task
            title = task.title
            taskDescription = task.description ?? ""
            subtasks = task.subtasks.sorted { ($0.position ?? 0) < ($1.position ?? 0) }
            dueDate = task.dueDateAsDate
            startMinutes = task.startTime.flatMap(DateFormats.localTimeComponents).map { $0.hour * 60 + $0.minute }
            durationMin = task.durationMin
            projectId = task.projectId
            priority = TaskPriority(rawValue: task.priority) ?? .low
            selectedLabelIds = Set(task.labels.map(\.id))
            assigneeId = task.assigneeId
            attachments = TaskAttachmentsController(apiClient: apiClient, taskId: taskID, existing: task.attachments ?? [])
        } catch let error as APIError {
            if case .notFound = error { notFound = true } else { loadErrorMessage = Self.message(error) }
        } catch {
            loadErrorMessage = error.localizedDescription
        }
    }

    func loadAgents() async {
        do {
            agents = try await apiClient.agents()
        } catch {
            // Формулировка дословно из спеки — общая ошибка справочников
            // (проекты/метки грузит `ProjectStore`/`LabelStore` из окружения,
            // сюда добавляются только агенты, которых стор не хранит).
            directoriesErrorMessage = "Не удалось загрузить проекты, метки или агентов. Проверьте соединение."
        }
    }

    // MARK: - Подзадачи (edit) — точечные вызовы, отдельные от общего PATCH задачи.

    func addSubtask(_ title: String) async {
        guard let taskID else { return }
        if let created = try? await apiClient.createSubtask(taskId: taskID, title: title) {
            subtasks.append(created)
        }
    }

    func renameSubtask(_ subtask: ApiSubtask, to newTitle: String) async {
        guard let index = subtasks.firstIndex(where: { $0.id == subtask.id }) else { return }
        let snapshot = subtasks[index]
        subtasks[index] = ApiSubtask(
            id: subtask.id, taskId: subtask.taskId, title: newTitle, done: subtask.done, position: subtask.position,
            agentState: subtask.agentState, agentId: subtask.agentId, agentHeartbeatAt: subtask.agentHeartbeatAt,
            result: subtask.result, agentSessionId: subtask.agentSessionId, state: subtask.state
        )
        do {
            _ = try await apiClient.patchSubtask(id: subtask.id, fields: ["title": .string(newTitle)])
        } catch {
            subtasks[index] = snapshot
        }
    }

    func deleteSubtask(_ subtask: ApiSubtask) async {
        let snapshot = subtasks
        subtasks.removeAll { $0.id == subtask.id }
        do {
            try await apiClient.deleteSubtask(id: subtask.id)
        } catch {
            subtasks = snapshot
        }
    }

    func reorderSubtasks(_ newOrder: [ApiSubtask]) async {
        subtasks = newOrder
        for (index, subtask) in newOrder.enumerated() where subtask.position != index {
            _ = try? await apiClient.patchSubtask(id: subtask.id, fields: ["position": .number(Double(index))])
        }
    }

    // MARK: - Сохранение

    /// `true` — сохранено успешно, экран может закрыться.
    func save(taskStore: TaskStore) async -> Bool {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else { return false }
        isSaving = true
        saveErrorMessage = nil
        defer { isSaving = false }

        do {
            if let taskID {
                try await saveEdit(taskID: taskID, trimmedTitle: trimmedTitle, taskStore: taskStore)
            } else {
                try await saveCreate(trimmedTitle: trimmedTitle, taskStore: taskStore)
            }
            return true
        } catch {
            saveErrorMessage = Self.message(error)
            return false
        }
    }

    private func saveEdit(taskID: String, trimmedTitle: String, taskStore: TaskStore) async throws {
        guard let originalTask else { return }
        var fields: [String: JSONValue] = [:]
        if trimmedTitle != originalTask.title { fields["title"] = .string(trimmedTitle) }
        let desc = taskDescription.isEmpty ? nil : taskDescription
        if desc != originalTask.description { fields["description"] = desc.map { JSONValue.string($0) } ?? .null }
        let dueStr = dueDate.map(DateFormats.calendarDateString)
        if dueStr != originalTask.dueDate { fields["due_date"] = dueStr.map { JSONValue.string($0) } ?? .null }
        let startStr = startMinutes.map { String(format: "%02d:%02d", $0 / 60, $0 % 60) }
        if startStr != originalTask.startTime { fields["start_time"] = startStr.map { JSONValue.string($0) } ?? .null }
        if durationMin != originalTask.durationMin { fields["duration_min"] = durationMin.map { JSONValue.number(Double($0)) } ?? .null }
        if projectId != originalTask.projectId { fields["project_id"] = projectId.map { JSONValue.string($0) } ?? .null }
        if priority.rawValue != originalTask.priority { fields["priority"] = .number(Double(priority.rawValue)) }
        if assigneeId != originalTask.assigneeId { fields["assignee_id"] = assigneeId.map { JSONValue.string($0) } ?? .null }
        let originalLabelIds = Set(originalTask.labels.map(\.id))
        if selectedLabelIds != originalLabelIds { fields["label_ids"] = .strings(Array(selectedLabelIds)) }

        guard !fields.isEmpty else { return }
        _ = await taskStore.patch(taskId: taskID, fields: fields) { _ in }
    }

    private func saveCreate(trimmedTitle: String, taskStore: TaskStore) async throws {
        let payload = APIClient.NewTaskRequest(
            title: trimmedTitle,
            description: taskDescription.isEmpty ? nil : taskDescription,
            dueDate: dueDate.map(DateFormats.calendarDateString),
            startTime: startMinutes.map { String(format: "%02d:%02d", $0 / 60, $0 % 60) },
            durationMin: durationMin,
            projectId: projectId,
            assigneeId: assigneeId,
            priority: priority.rawValue,
            labelIds: selectedLabelIds.isEmpty ? nil : Array(selectedLabelIds),
            subtasks: subtaskDrafts.isEmpty ? nil : subtaskDrafts.map(\.title)
        )
        guard let created = await taskStore.create(payload) else {
            throw APIError.server(status: 0, message: "Не удалось сохранить задачу")
        }
        // Файлы, накопленные локально до создания задачи — заливаем теперь,
        // когда id наконец известен (см. `AttachmentsFieldView.swift`).
        await attachments.flushPending(taskId: created.id)
    }

    private static func message(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}
