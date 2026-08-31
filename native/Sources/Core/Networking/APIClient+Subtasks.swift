import Foundation

/// Подзадачи и комментарии — spec/API.md §5.3.
public extension APIClient {

    func subtasks(taskId: String) async throws -> [ApiSubtask] {
        try await request(.get, "/tasks/\(taskId)/subtasks")
    }

    func createSubtask(taskId: String, title: String) async throws -> ApiSubtask {
        try await request(.post, "/tasks/\(taskId)/subtasks", body: ["title": title] as [String: String])
    }

    /// `result` — до 400 символов (`RESULT_MAX`, spec §7). Партиальное тело —
    /// `[String: JSONValue]`, как и у задачи (см. `patchTask`).
    func patchSubtask(id: String, fields: [String: JSONValue]) async throws -> ApiSubtask {
        try await request(.patch, "/subtasks/\(id)", body: fields)
    }

    /// Своя дорожка состояния, ОТДЕЛЬНАЯ от `PATCH /subtasks/:id` — трекинг
    /// агентской работы конкретно над подзадачей (spec §5.3).
    func setSubtaskWork(id: String, fields: [String: JSONValue]) async throws -> ApiSubtask {
        try await request(.post, "/subtasks/\(id)/work", body: fields)
    }

    func deleteSubtask(id: String) async throws {
        let _: APIOkResponse = try await request(.delete, "/subtasks/\(id)")
    }

    func comments(taskId: String) async throws -> [ApiComment] {
        try await request(.get, "/tasks/\(taskId)/comments")
    }

    /// Прикрепление ранее загруженных вложений — сначала `uploadRaw`
    /// (`APIClient+Attachments`), затем их id сюда.
    func createComment(taskId: String, text: String, attachmentIds: [String] = []) async throws -> ApiComment {
        var body: [String: JSONValue] = ["text": .string(text)]
        if !attachmentIds.isEmpty { body["attachment_ids"] = .strings(attachmentIds) }
        return try await request(.post, "/tasks/\(taskId)/comments", body: body)
    }
}
