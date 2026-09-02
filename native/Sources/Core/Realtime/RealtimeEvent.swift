import Foundation

/// Событие реалтайм-канала — spec/API.md §4/§4.1. Хендшейк `{"type":"connected"}`
/// подтверждён живым подключением к `ws://192.168.1.110:3001/ws` 31.08.2026
/// (Node-скрипт поверх `ws`, свой агентский токен) — сервер шлёт его сразу
/// после апгрейда, без обёртки, ровно как в документе.
///
/// Часть форм (`task:activity`, `chat:typing`, `error`) спека прямо помечает
/// как «не проверено исчерпывающе» (§10) — разбор здесь нарочно ЗАЩИТНЫЙ:
/// одно неожиданное поле не должно ронять весь WS-пайплайн, непонятное
/// событие уходит в `.unknown`, а не кидает ошибку декодера наружу.
public enum RealtimeEvent: Sendable {
    case connected
    case ping
    case pong
    case taskCreated(ApiTask)
    case taskUpdated(ApiTask)
    case taskCompleted(ApiTask)
    /// Спека не расписывает `task:deleted` отдельно от общего «сама сущность
    /// целиком» — разбираем оба варианта: полный `ApiTask` ИЛИ голый `{ id }`.
    case taskDeleted(id: String)
    case taskState(ApiTask)
    case taskActivity(taskId: String?, raw: JSONValue)
    case notificationNew(ApiNotification)
    case chatNew(ApiChatMessage)
    case chatTyping(raw: JSONValue)
    case serverError(message: String?)
    case unknown(type: String, raw: JSONValue)

    private struct Envelope: Decodable { let type: String }
    private struct BareID: Decodable { let id: String }
    private struct TaskIdField: Decodable { let task_id: String? }
    private struct ErrorPayload: Decodable { let message: String?; let error: String? }

    public static func parse(_ data: Data) -> RealtimeEvent? {
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
        let raw = (try? decoder.decode(JSONValue.self, from: data)) ?? .null

        func decodeTask() -> ApiTask? { try? decoder.decode(ApiTask.self, from: data) }

        switch envelope.type {
        case "connected": return .connected
        case "ping": return .ping
        case "pong": return .pong
        case "task:created":
            return decodeTask().map(RealtimeEvent.taskCreated) ?? .unknown(type: envelope.type, raw: raw)
        case "task:updated":
            return decodeTask().map(RealtimeEvent.taskUpdated) ?? .unknown(type: envelope.type, raw: raw)
        case "task:completed":
            return decodeTask().map(RealtimeEvent.taskCompleted) ?? .unknown(type: envelope.type, raw: raw)
        case "task:deleted":
            if let task = decodeTask() { return .taskDeleted(id: task.id) }
            if let bare = try? decoder.decode(BareID.self, from: data) { return .taskDeleted(id: bare.id) }
            return .unknown(type: envelope.type, raw: raw)
        case "task:state":
            return decodeTask().map(RealtimeEvent.taskState) ?? .unknown(type: envelope.type, raw: raw)
        case "task:activity":
            let taskId = (try? decoder.decode(TaskIdField.self, from: data))?.task_id
            return .taskActivity(taskId: taskId, raw: raw)
        case "notification:new":
            guard let n = try? decoder.decode(ApiNotification.self, from: data) else {
                return .unknown(type: envelope.type, raw: raw)
            }
            return .notificationNew(n)
        case "chat:new":
            guard let m = try? decoder.decode(ApiChatMessage.self, from: data) else {
                return .unknown(type: envelope.type, raw: raw)
            }
            return .chatNew(m)
        case "chat:typing":
            return .chatTyping(raw: raw)
        case "error":
            let payload = try? decoder.decode(ErrorPayload.self, from: data)
            return .serverError(message: payload?.message ?? payload?.error)
        default:
            return .unknown(type: envelope.type, raw: raw)
        }
    }
}
