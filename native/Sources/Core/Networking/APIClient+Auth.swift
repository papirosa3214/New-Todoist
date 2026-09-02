import Foundation

/// Авторизация и сессия — spec/API.md §2.1.
public extension APIClient {

    struct AuthResponse: Decodable, Sendable {
        public let token: String
        public let user: ApiUser
    }

    /// ⚠️ Расхождение со спекой, найдено живым запросом к :3001 (31.08.2026):
    /// `GET /api/auth/me` в документе значится как отдающий `ApiUser`
    /// НАПРЯМУЮ, но реальный сервер оборачивает ответ в `{ "user": {...} }`.
    /// Код сервера — источник истины (правило `ARCHITECTURE.md` п.3), здесь
    /// это учтено отдельной обёрткой, а не `ApiUser` в лоб.
    private struct MeResponse: Decodable { let user: ApiUser }

    /// Поле называется `email`, но сервер с 01.09.2026 принимает и логин —
    /// имя учётки или короткое имя из почты (`server/src/routes/auth.ts`).
    func login(email: String, password: String) async throws -> AuthResponse {
        try await request(.post, "/auth/login", body: ["email": email, "password": password] as [String: String])
    }

    /// Вход без пароля из домашней сети — тот же маршрут, которым уже
    /// пользуется веб (`src/api/client.ts`): сервер при `TASKFLOW_LAN_NO_AUTH=1`
    /// и запросе с приватного адреса молча отдаёт сессию владельца, а снаружи
    /// отвечает 404. Требование Максима 19.08.2026: «в своей домашней сети не
    /// хочу постоянно вбивать пароли».
    func lanLogin() async throws -> AuthResponse {
        try await request(.post, "/auth/lan", body: [String: String]())
    }

    /// **Закрыта по умолчанию** — 403, если в базе уже есть хоть один
    /// пользователь и не выставлен `TASKFLOW_ALLOW_REGISTRATION=1` (spec §2.1).
    func register(name: String, email: String, password: String) async throws -> AuthResponse {
        try await request(.post, "/auth/register", body: [
            "name": name, "email": email, "password": password,
        ] as [String: String])
    }

    func me() async throws -> ApiUser {
        let response: MeResponse = try await request(.get, "/auth/me")
        return response.user
    }

    /// **Только JWT**, не api_token — «курицей-яйцом» новый токен из имеющегося
    /// api-токена не выпустить (spec §2.1).
    func issueApiToken() async throws -> String {
        struct Response: Decodable { let api_token: String }
        let response: Response = try await request(.post, "/auth/api-token")
        return response.api_token
    }

    func updateProfile(name: String? = nil, avatarColor: String? = nil) async throws -> ApiUser {
        var body: [String: JSONValue] = [:]
        if let name { body["name"] = .string(name) }
        if let avatarColor { body["avatar_color"] = .string(avatarColor) }
        return try await request(.put, "/auth/profile", body: body)
    }
}
