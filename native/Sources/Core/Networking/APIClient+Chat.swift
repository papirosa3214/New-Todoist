import Foundation

/// Внутренний чат координации агентов — spec/API.md §5.8. Второстепенная
/// область для личного iOS-клиента владельца, но часть контракта — минимальный
/// набор методов для будущего экрана «Чат» (Волна 2).
public extension APIClient {

    /// Единственный пагинированный список в API — `before` (курсор по
    /// `created_at`), `limit` не больше 50.
    func chatMessages(channel: ChatChannel, before: String? = nil, limit: Int? = nil) async throws -> [ApiChatMessage] {
        var query = [URLQueryItem(name: "channel", value: channel.rawValue)]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await request(.get, "/chat/messages", query: query)
    }

    func sendChatMessage(
        channel: ChatChannel, toUserId: String? = nil, taskId: String? = nil,
        kind: ChatMessageKind? = nil, text: String, attachmentIds: [String] = []
    ) async throws -> ApiChatMessage {
        var body: [String: JSONValue] = ["channel": .string(channel.rawValue), "text": .string(text)]
        if let toUserId { body["to_user_id"] = .string(toUserId) }
        if let taskId { body["task_id"] = .string(taskId) }
        if let kind { body["kind"] = .string(kind.rawValue) }
        if !attachmentIds.isEmpty { body["attachment_ids"] = .strings(attachmentIds) }
        return try await request(.post, "/chat/messages", body: body)
    }

    func chatParticipants(channel: ChatChannel? = nil) async throws -> [ApiChatParticipant] {
        var query: [URLQueryItem] = []
        if let channel { query.append(URLQueryItem(name: "channel", value: channel.rawValue)) }
        return try await request(.get, "/chat/participants", query: query)
    }

    func chatStats() async throws -> ApiChatStats {
        try await request(.get, "/chat/stats")
    }

    /// Триггерит WS `chat:typing`, тело ответа не документировано — вызывается
    /// ради побочного эффекта.
    func sendChatTyping(channel: ChatChannel) async throws {
        try await requestVoid(.post, "/chat/typing", body: ["channel": .string(channel.rawValue)] as [String: JSONValue])
    }

    func markChatRead(channel: ChatChannel) async throws {
        try await requestVoid(.patch, "/chat/read", body: ["channel": .string(channel.rawValue)] as [String: JSONValue])
    }
}
