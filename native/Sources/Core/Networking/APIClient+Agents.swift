import Foundation

/// Агенты/пользователи-исполнители — spec/API.md §5.5. Веб-клиент опрашивает
/// `GET /agents` раз в 15 секунд для «онлайн/офлайн»/«что делает сейчас»
/// (spec §8) — тот же ритм стоит повторить в `RootShellView`/сторе агентов,
/// когда экран «Агенты» появится (Волна 2).
public extension APIClient {

    /// Полный derived-набор (`online`, `activity`, `last_action*`, `limits`) —
    /// подтверждено живым запросом к :3001 (31.08.2026).
    func agents() async throws -> [ApiUser] {
        try await request(.get, "/agents")
    }

    struct InviteAgentResponse: Decodable, Sendable {
        public let user: ApiUser
        /// Показывается ОДИН раз — сервер хранит только хэш.
        public let apiToken: String

        enum CodingKeys: String, CodingKey {
            case user
            case apiToken = "api_token"
        }
    }

    func inviteAgent(name: String, type: String? = nil, role: String? = nil) async throws -> InviteAgentResponse {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let type { body["type"] = .string(type) }
        if let role { body["role"] = .string(role) }
        return try await request(.post, "/agents", body: body)
    }

    func renameAgent(id: String, name: String) async throws -> ApiUser {
        try await request(.patch, "/agents/\(id)", body: ["name": name] as [String: String])
    }

    /// Только владелец. 409, если у агента есть незавершённая работа.
    func deleteAgent(id: String) async throws {
        let _: APIOkResponse = try await request(.delete, "/agents/\(id)")
    }
}
