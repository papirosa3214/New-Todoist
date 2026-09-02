import Foundation
import Observation
import UniformTypeIdentifiers

// Вью-модель карточки задачи — spec/SCREENS-1.md §5.4. Один точечный GET
// (`useTask(id)` в спеке) отдаёт задачу СРАЗУ с `comments`/`events`/
// `attachments`/`children` (spec/API.md §5.1) — после любой мутации проще и
// надёжнее перезапросить его целиком, чем вести россыпь точечных патчей
// локального состояния (комментарии/события/подзадачи тесно связаны).
@MainActor
@Observable
final class TaskDetailViewModel {
    let taskID: String
    private let apiClient = APIClient()

    var task: ApiTask?
    var isLoading = false
    var notFound = false
    var loadErrorMessage: String?
    var actionErrorMessage: String?
    var commentText = ""
    var pendingCommentAttachments: [(id: String, name: String)] = []

    init(taskID: String) {
        self.taskID = taskID
    }

    var journalEntries: [TaskJournalEntry] {
        TaskJournalEntry.merged(comments: task?.comments ?? [], events: task?.events ?? [])
    }

    var openSubtasksCount: Int {
        (task?.subtasks ?? []).count { !$0.done }
    }

    func load() async {
        isLoading = true
        loadErrorMessage = nil
        defer { isLoading = false }
        do {
            task = try await apiClient.task(id: taskID)
        } catch let error as APIError {
            if case .notFound = error { notFound = true } else { loadErrorMessage = Self.message(error) }
        } catch {
            loadErrorMessage = error.localizedDescription
        }
    }

    // MARK: - Задача целиком

    func delete(taskStore: TaskStore) async {
        await taskStore.delete(taskId: taskID)
    }

    func complete() async {
        do {
            _ = try await apiClient.patchTask(id: taskID, fields: ["status": .string("completed")])
            await load()
        } catch {
            actionErrorMessage = Self.message(error)
        }
    }

    func reopen() async {
        do {
            _ = try await apiClient.patchTask(id: taskID, fields: ["status": .string("active")])
            await load()
        } catch {
            actionErrorMessage = Self.message(error)
        }
    }

    // MARK: - Подзадачи

    func toggleSubtaskDone(_ subtask: ApiSubtask) async {
        do {
            _ = try await apiClient.patchSubtask(id: subtask.id, fields: ["done": .bool(!subtask.done)])
            await load()
        } catch {
            actionErrorMessage = Self.message(error)
        }
    }

    /// «Принять» шаг на проверке — как и владельческое «Принять» задачи,
    /// закрывает шаг (сервер сам снимает `agent_state`, когда `done=true`,
    /// см. `withSubtaskState()`). Отдельного эндпоинта под конкретно
    /// «принять шаг на проверке» спека не называет.
    func acceptSubtask(_ subtask: ApiSubtask) async {
        do {
            _ = try await apiClient.patchSubtask(id: subtask.id, fields: ["done": .bool(true)])
            await load()
        } catch {
            actionErrorMessage = Self.message(error)
        }
    }

    /// Ответ владельца на заблокированный/сданный на проверку шаг —
    /// ⚠️ допущение: контракт `/subtasks/:id/work` спекой не раскрыт до
    /// точной формы тела, поэтому текст владельца пишется в `result` через
    /// обычный `PATCH /subtasks/:id` (поле для отчёта уже есть в модели) —
    /// сказано в отчёте как место, требующее сверки с живым сервером.
    func replyToSubtask(_ subtask: ApiSubtask, text: String) async {
        do {
            _ = try await apiClient.patchSubtask(id: subtask.id, fields: ["result": .string(text)])
            await load()
        } catch {
            actionErrorMessage = Self.message(error)
        }
    }

    // MARK: - Лента: комментарии

    func sendComment() async {
        let text = commentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !pendingCommentAttachments.isEmpty else { return }
        do {
            _ = try await apiClient.createComment(taskId: taskID, text: text, attachmentIds: pendingCommentAttachments.map(\.id))
            commentText = ""
            pendingCommentAttachments = []
            await load()
        } catch {
            // Формулировка дословно из спеки §19.2.
            actionErrorMessage = "Не удалось отправить — попробуйте ещё раз"
        }
    }

    func attachCommentFile(url: URL) async {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let fileName = url.lastPathComponent
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        if let reason = TaskAttachmentDisplay.rejectionReason(fileName: fileName, mime: mime, size: data.count) {
            actionErrorMessage = reason
            return
        }
        guard let attachment = try? await apiClient.uploadTaskAttachment(taskId: taskID, kind: "comment", fileName: fileName, data: data, mime: mime) else {
            actionErrorMessage = "Не удалось приложить файл"
            return
        }
        pendingCommentAttachments.append((id: attachment.id, name: fileName))
    }

    func removePendingCommentAttachment(at index: Int) {
        guard pendingCommentAttachments.indices.contains(index) else { return }
        pendingCommentAttachments.remove(at: index)
    }

    // MARK: - Действия владельца над агентской работой (§19.2 AgentOwnerActions)

    func performOwnerAction(_ kind: AgentOwnerActionKind, comment: String?) async {
        do {
            switch kind {
            case .acceptReview, .acceptAndClose:
                _ = try await apiClient.setTaskAgentState(id: taskID, state: nil, comment: comment)
                _ = try await apiClient.patchTask(id: taskID, fields: ["status": .string("completed")])
            case .returnToWorkFromReview, .replyAndReturnFromBlocked:
                _ = try await apiClient.setTaskAgentState(id: taskID, state: .inProgress, comment: comment)
            case .returnToWorkFromInProgress:
                _ = try await apiClient.setTaskAgentState(id: taskID, state: nil, comment: comment)
            }
            await load()
        } catch {
            // Формулировка дословно из спеки §19.2.
            actionErrorMessage = "Не удалось изменить состояние задачи"
        }
    }

    // MARK: - Вложения задачи (не в ленте — kind="task")

    func attachTaskFile(url: URL) async {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let fileName = url.lastPathComponent
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        if let reason = TaskAttachmentDisplay.rejectionReason(fileName: fileName, mime: mime, size: data.count) {
            actionErrorMessage = reason
            return
        }
        do {
            _ = try await apiClient.uploadTaskAttachment(taskId: taskID, kind: "task", fileName: fileName, data: data, mime: mime)
            await load()
        } catch {
            actionErrorMessage = "Не удалось приложить файл"
        }
    }

    private static func message(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}
