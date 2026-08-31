import Foundation

// Правки к `Core/Networking/APIClient+Chat.swift` — сверено ЖИВЬЁМ с
// сервером (`server/src/routes/chat.ts`, `server/src/chatTyping.ts`,
// 31.08.2026), а не с устаревшим черновиком spec/API.md, на который
// опирался Core-файл. Расхождения, из-за которых существующие методы Core
// 404-ят/400-ят/не декодируются:
//
// - История: путь `/chat`, БЕЗ `/messages`; ответ — конверт
//   `{messages, has_more}`, а не голый массив.
// - Отправка: `to_user_id` ОБЯЗАТЕЛЕН (сервер отвечает 400 без него) —
//   у Core он опционален.
// - `/chat/read` — POST без тела, а не PATCH.
// - `/chat/typing` — тело `{state?: "stop"}`, БЕЗ `channel` вовсе: отметка
//   «печатает» глобальная на весь чат, сервер её не делит по каналам
//   (`chatTyping.ts`, `typists: Map<userId,…>` без ключа канала) — клиент
//   сам решает, показывать ли её в открытом канале (см. `ChatViewModel`).
//
// Это НЕ правка общего файла (граница задачи: пишу только в своей папке) —
// отдельное расширение того же типа. Владельцу `Core` стоит решить, чинить
// ли/удалять старые методы в `APIClient+Chat.swift` — вынесено в отчёт.
public extension APIClient {

    struct ChatHistoryPage: Decodable, Sendable {
        public let messages: [ApiChatMessage]
        public let hasMore: Bool
        enum CodingKeys: String, CodingKey {
            case messages
            case hasMore = "has_more"
        }
    }

    func fetchChatHistory(
        channel: ChatChannel?, taskId: String? = nil, before: String? = nil, limit: Int? = nil
    ) async throws -> ChatHistoryPage {
        var query: [URLQueryItem] = []
        if let channel { query.append(URLQueryItem(name: "channel", value: channel.rawValue)) }
        if let taskId { query.append(URLQueryItem(name: "task_id", value: taskId)) }
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        if let limit { query.append(URLQueryItem(name: "limit", value: String(limit))) }
        return try await request(.get, "/chat", query: query)
    }

    /// `toUserId` — id участника ИЛИ спецзначение "all" (сервер принимает
    /// "all"/"всем"/"*" регистронезависимо) — обязателен, без него 400.
    func postChatMessage(
        text: String,
        toUserId: String,
        channel: ChatChannel? = nil,
        taskId: String? = nil,
        kind: ChatMessageKind? = nil,
        attachmentIds: [String] = []
    ) async throws -> ApiChatMessage {
        var body: [String: JSONValue] = ["text": .string(text), "to_user_id": .string(toUserId)]
        if let channel { body["channel"] = .string(channel.rawValue) }
        if let taskId { body["task_id"] = .string(taskId) }
        if let kind { body["kind"] = .string(kind.rawValue) }
        if !attachmentIds.isEmpty { body["attachment_ids"] = .strings(attachmentIds) }
        return try await request(.post, "/chat", body: body)
    }

    /// Ключи дословно русские — тот же приём, что у `ApiChatStats` в Core.
    struct ChatTypingSignalResponse: Decodable, Sendable {
        public let isTyping: Bool
        public let fadeInMs: Int?
        enum CodingKeys: String, CodingKey {
            case isTyping = "печатает"
            case fadeInMs = "гаснет_через_мс"
        }
    }

    @discardableResult
    func signalChatTyping(stop: Bool) async throws -> ChatTypingSignalResponse {
        var body: [String: JSONValue] = [:]
        if stop { body["state"] = .string("stop") }
        return try await request(.post, "/chat/typing", body: body)
    }

    struct ChatTypingSnapshot: Decodable, Sendable {
        public struct Entry: Decodable, Sendable {
            public let userId: String
            public let name: String
            public let ttlMs: Int
            enum CodingKeys: String, CodingKey {
                case userId = "user_id"
                case name
                case ttlMs = "ttl_ms"
            }
        }
        public let typing: [Entry]
    }

    /// Снимок для только что открытого экрана — событие о начале печати
    /// могло уйти по сокету раньше, чем экран подписался.
    func fetchChatTypingSnapshot() async throws -> ChatTypingSnapshot {
        try await request(.get, "/chat/typing")
    }

    func markChatReadNow() async throws {
        try await requestVoid(.post, "/chat/read")
    }

    struct ChatAttachmentUpload: Decodable, Sendable {
        public let attachment: ApiChatAttachment
    }

    /// Убрать уже загруженное вложение до отправки — тем же `DELETE
    /// /attachments/:id`, что и остальные вложения (`deleteAttachment` в
    /// Core уже бьёт по верному пути, здесь только загрузка).
    func uploadChatAttachment(fileName: String, data: Data, mime: String) async throws -> ChatAttachmentUpload {
        try await uploadRaw(
            path: "/chat/attachments",
            query: [URLQueryItem(name: "name", value: fileName)],
            data: data,
            mime: mime
        )
    }
}
