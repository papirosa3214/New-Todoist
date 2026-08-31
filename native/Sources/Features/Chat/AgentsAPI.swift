import Foundation

// Правки к `Core/Networking/APIClient+Agents.swift` и
// `APIClient+Attachments.swift` — сверено ЖИВЬЁМ с сервером
// (`server/src/routes/projects.ts` — блок «Agents (users)» — и
// `server/src/routes/avatars.ts`, 31.08.2026):
//
// - `POST /agents` отвечает `{agent, api_token}` — Core декодирует поле
//   `user`, которого в ответе нет (декодер упадёт). Тело сервер принимает
//   ТОЛЬКО `{name}` — `type`/`role` игнорирует (роль/тип агента всегда
//   фиксированы 'agent'/'ai' в SQL).
// - `PATCH /agents/:id` отвечает `{agent}` — Core ждёт голый `ApiUser`.
// - Аватарка агента — `POST/DELETE /avatars/:id` (id — ЦЕЛЕВОЙ пользователь,
//   владелец меняет фото СВОЕГО агента). Core бьёт по `/avatars` без id —
//   такого маршрута на сервере нет вовсе (тот путь только для СВОЕЙ
//   аватарки через сессионный `req.userId`, но и это не то же самое место).
//
// Не правка общего файла — отдельное расширение. См. отчёт по итогам задачи.
public extension APIClient {

    struct InviteAgentResponseFixed: Decodable, Sendable {
        public let agent: ApiUser
        public let apiToken: String
        enum CodingKeys: String, CodingKey {
            case agent
            case apiToken = "api_token"
        }
    }

    /// Только человек может звать: сервер отвечает 403 агенту-вызывающему.
    func inviteAgentFixed(name: String) async throws -> InviteAgentResponseFixed {
        try await request(.post, "/agents", body: ["name": name] as [String: String])
    }

    struct RenameAgentResponseFixed: Decodable, Sendable {
        public let agent: ApiUser
    }

    /// Только владелец, и только над записью `type == "ai"` — иначе 403/404.
    func renameAgentFixed(id: String, name: String) async throws -> ApiUser {
        let response: RenameAgentResponseFixed = try await request(
            .patch, "/agents/\(id)", body: ["name": name] as [String: String]
        )
        return response.agent
    }

    /// `variant`: `"working"`/`"blocked"`, `nil` — основная (дефолтная) аватарка.
    /// Право менять — сам агент, его создатель (`created_by`) или системный бот.
    func uploadAgentAvatar(id: String, data: Data, mime: String, variant: String? = nil) async throws -> AvatarUploadResponse {
        var query: [URLQueryItem] = []
        if let variant { query.append(URLQueryItem(name: "variant", value: variant)) }
        return try await uploadRaw(path: "/avatars/\(id)", query: query, data: data, mime: mime)
    }

    func deleteAgentAvatar(id: String, variant: String? = nil) async throws {
        var query: [URLQueryItem] = []
        if let variant { query.append(URLQueryItem(name: "variant", value: variant)) }
        let _: APIOkResponse = try await request(.delete, "/avatars/\(id)", query: query)
    }
}
