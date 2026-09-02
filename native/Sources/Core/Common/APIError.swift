import Foundation

/// Единая ошибка сети/API. Сервер всегда отдаёт `{ "error": "человекочитаемое
/// сообщение" }` при не-2xx статусе (spec/API.md §1) — здесь это разобрано в
/// `.server(status:message:)` и именованных вариантах для частых кодов.
public enum APIError: Error, LocalizedError, Sendable {
    case transport(Error)
    case invalidResponse
    case decoding(Error)
    /// 401 — токен истёк/невалиден. Обработчик наверху (`SessionStore`) должен
    /// на этот случай сразу разлогинить и показать экран входа (spec §2.2:
    /// LAN-релогин веба нативному клиенту не подходит).
    case unauthorized(message: String)
    case forbidden(message: String)
    /// Чужой ресурс, недоступный по видимости, отдаёт 404 — сервер не
    /// подтверждает даже факт существования чужого объекта (spec §2.3).
    case notFound(message: String)
    case conflict(message: String)
    case server(status: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .transport(let error): "Сеть недоступна: \(error.localizedDescription)"
        case .invalidResponse: "Сервер вернул неожиданный ответ"
        case .decoding(let error): "Не удалось разобрать ответ сервера: \(error.localizedDescription)"
        case .unauthorized(let message): message
        case .forbidden(let message): message
        case .notFound(let message): message
        case .conflict(let message): message
        case .server(_, let message): message
        }
    }
}

/// Тело ошибки сервера — `{ "error": "..." }`, единственная форма во всём API.
struct APIErrorBody: Decodable {
    let error: String
}

/// Ответ вида `{ "ok": true }` — DELETE и некоторые служебные эндпоинты.
public struct APIOkResponse: Decodable, Sendable {
    public let ok: Bool
}
