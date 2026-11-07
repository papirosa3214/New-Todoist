// Path on MacBook (выделенная копия Разработчика):
//   /Users/max/Проекты/TaskFlowDeveloper/Sources/Core/Networking/APIClient+ServerSettings.swift
// Ветка: codex/developer-mac  ·  HEAD: 7792e9aa
//
// Этот файл положен в worktree (роль builder) рядом с этой задачей,
// чтобы критик мог независимо прочитать код без доступа к MacBook.
// ВАЖНО: исходник живёт ТОЛЬКО на MacBook; здесь копия для ревью.

import Foundation

/// Контракт MAK-95 — пульт управления сервером. Серверный реестр параметров
/// (`server/src/lib/serverSettingsRegistry.ts`) уже принят критиком и
/// используется в вебе (`src/screens/SettingsScreen.tsx`,
/// `ServerSettingsSection`). Здесь — нативный аналог.
///
/// Все эндпоинты — только владелец (`isOwner`). Не-владелец получает 403
/// на уровне роута, в iOS это превращается в `APIError.forbidden` — баннер
/// «доступно только владельцу» поднимется сам.
///
/// Имена полей и типы — один в один с `ServerSetting` на сервере. Любое
/// расхождение (тип kind, отсутствие min/max/options) видно при первом
/// декодировании ответа и решается в одном месте — здесь.

public struct ServerSettingMetadata: Decodable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let group: String
    /// `duration_min` / `duration_ms` / `interval_ms` / `int` / `bool` / `enum`.
    public let kind: String
    public let defaultValue: ServerSettingValue
    public let min: Double?
    public let max: Double?
    public let options: [String]?
    public let appliesTo: [String]

    public var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, label, group, kind
        case defaultValue = "default"
        case min, max, options
        case appliesTo = "applies_to"
    }
}

/// Значение параметра — `JSON` может вернуть число, `true`/`false` или
/// строку; enum-варианты (`task_intake_mode` ∈ {"manual","automatic"})
/// приходят строкой. Это и есть «JSONValue» для нашего реестра.
public enum ServerSettingValue: Decodable, Sendable, Equatable {
    case int(Int)
    case bool(Bool)
    case string(String)

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Порядок важен: `Bool` декодируется ИЗ ЦЕЛОГО как `false` на
        // некоторых версиях Foundation (например, `0 as Bool`), поэтому
        // сначала пробуем Bool, потом число, потом строку.
        if let b = try? container.decode(Bool.self) { self = .bool(b); return }
        if let i = try? container.decode(Int.self) { self = .int(i); return }
        if let d = try? container.decode(Double.self) {
            // Числа без дробной части интерпретируем как Int (сервер шлёт их
            // именно так: duration_min=10, без точки). Если придёт дробь —
            // округлим, экран всё равно показывает целые миллисекунды/минуты.
            self = .int(Int(d.rounded()))
            return
        }
        if let s = try? container.decode(String.self) { self = .string(s); return }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "ServerSettingValue: не удалось декодировать ни Bool, ни Int, ни Double, ни String"
        )
    }

    /// Строковое представление для текстового поля.
    public var displayString: String {
        switch self {
        case .int(let i): return String(i)
        case .bool: return ""
        case .string(let s): return s
        }
    }
}

public extension ServerSettingMetadata {
    /// Текущее значение (из ответа `values[key]`) совпадает с дефолтом.
    /// Используется, чтобы показать/спрятать кнопку «Сбросить».
    func isDefault(_ current: ServerSettingValue) -> Bool {
        return current == defaultValue
    }
}

public struct ServerSettingsResponse: Decodable, Sendable {
    public let settings: [ServerSettingMetadata]
    /// `values[key]` — текущее применённое значение (из БД, если владелец
    /// менял, иначе из DEFAULTS). Всегда есть ключ для каждого `settings`.
    public let values: [String: ServerSettingValue]
    /// `updated_at[key]` — ISO-строка последнего изменения в БД. Для
    /// дефолтных ключей в ответе может не быть записи.
    public let updatedAt: [String: String]

    enum CodingKeys: String, CodingKey {
        case settings, values
        case updatedAt = "updated_at"
    }
}

/// Запись журнала изменений. Сервер отдаёт «сырые» snake_case-имена
/// столбцов (`old_value` / `new_value` / `actor_id` / `created_at`) —
/// см. `getServerSettingsLog` в `server/src/lib/serverSettings.ts`
/// и `GET /api/admin/server-settings/log` в
/// `server/src/routes/admin-server-settings.ts`. Декодер маппит их
/// на camelCase-swift-имена через `CodingKeys` с алиасами; обратные
/// camelCase-ключи (`before` / `after` / `actor` / `createdAt`)
/// оставлены на случай, если веб-экран передаёт через общий прокси
/// уже переименованный JSON — тогда `Decodable` найдёт ключ в любом
/// из вариантов (Swift `KeyedDecodingContainer.decode(_:forKey:)`
/// бросит `keyNotFound` только если нет ни одного из имён в `keys`).
public struct ServerSettingsLogEntry: Decodable, Sendable, Identifiable {
    public let id: Int
    public let key: String
    public let oldValue: ServerSettingValue?
    public let newValue: ServerSettingValue?
    public let actorId: String?
    public let reason: String?
    public let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, key, reason
        // Сервер (`server/src/routes/admin-server-settings.ts`, GET /log)
        // отдаёт эти имена в snake_case.
        case oldValue = "old_value"
        case newValue = "new_value"
        case actorId = "actor_id"
        case createdAt = "created_at"
        // Совместимость: если в будущем эндпоинт начнёт отдавать camelCase
        // (например, общий прокси web → iOS), эти ключи тоже подойдут.
        case oldValueCamel = "oldValue"
        case newValueCamel = "newValue"
        case actorIdCamel = "actorId"
        case createdAtCamel = "createdAt"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        key = try container.decode(String.self, forKey: .key)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        // Поля, которые сервер отдаёт по-разному (snake/camel), пробуем
        // в обоих вариантах: сначала то, что фактически шлёт сервер,
        // потом — обратная совместимость.
        oldValue = try container.decodeIfPresent(ServerSettingValue.self, forKey: .oldValue)
            ?? container.decodeIfPresent(ServerSettingValue.self, forKey: .oldValueCamel)
        newValue = try container.decodeIfPresent(ServerSettingValue.self, forKey: .newValue)
            ?? container.decodeIfPresent(ServerSettingValue.self, forKey: .newValueCamel)
        actorId = try container.decodeIfPresent(String.self, forKey: .actorId)
            ?? container.decodeIfPresent(String.self, forKey: .actorIdCamel)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
            ?? container.decodeIfPresent(String.self, forKey: .createdAtCamel)
            ?? ""
    }
}

public struct ServerSettingsLogResponse: Decodable, Sendable {
    public let log: [ServerSettingsLogEntry]
}

public struct ServerSettingMutationResponse: Decodable, Sendable {
    public let ok: Bool
    public let value: ServerSettingValue?
}

public extension APIClient {
    /// Полный снимок реестра: метаданные, текущие значения, `updated_at`.
    /// Только владелец (403 на сервере для остальных).
    func serverSettings() async throws -> ServerSettingsResponse {
        try await request(.get, "/admin/server-settings")
    }

    /// Журнал последних 50 изменений (кто менял, когда, до/после).
    func serverSettingsLog() async throws -> ServerSettingsLogResponse {
        try await request(.get, "/admin/server-settings/log")
    }

    /// Изменить один параметр. `value` сериализуется автоматически по типу
    /// (Int → число, Bool → `true`/`false`, String → строка). `reason` —
    /// необязательный комментарий владельца для журнала.
    func putServerSetting(key: String, value: ServerSettingValue, reason: String?) async throws -> ServerSettingMutationResponse {
        struct Body: Encodable { let value: ServerSettingJSONValue; let reason: String? }
        let body = Body(
            value: ServerSettingJSONValue(value),
            reason: reason?.isEmpty == true ? nil : reason
        )
        return try await request(.put, "/admin/server-settings/\(key)", body: body)
    }

    /// Сбросить параметр к дефолту.
    func resetServerSetting(key: String, reason: String?) async throws -> APIOkResponse {
        struct Body: Encodable { let reason: String? }
        let body = Body(reason: reason?.isEmpty == true ? nil : reason)
        return try await request(.post, "/admin/server-settings/\(key)/reset", body: body)
    }
}

/// Обёртка для сериализации `ServerSettingValue` обратно в JSON — эндпоинт
/// PUT принимает `{ "value": <число|true|строка> }`. Swift `JSONEncoder`
/// по умолчанию кодирует enum с одним ассоциированным значением как
/// `{ "int": 10 }`, что серверу не подходит — поэтому отдельная обёртка.
private struct ServerSettingJSONValue: Encodable {
    let value: ServerSettingValue
    init(_ value: ServerSettingValue) { self.value = value }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case .int(let i): try container.encode(i)
        case .bool(let b): try container.encode(b)
        case .string(let s): try container.encode(s)
        }
    }
}
