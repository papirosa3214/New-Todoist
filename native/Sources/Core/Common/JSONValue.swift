import Foundation

/// Универсальный контейнер для произвольного JSON.
///
/// Нужен в двух местах:
/// 1. Содержимое заметок (`user_notes.content` хранится как TipTap JSON —
///    формат rich-text редактора веба, spec/API.md §3.10). Нативный клиент не
///    парсит его по узлам, только хранит/пересылает как есть — редактор
///    заметок пишет другой исполнитель (Волна 2), ему решать, рендерить ли
///    узлы или просить сервер `?format=markdown`.
/// 2. Тело PATCH-запросов (`APIClient.patch`) — сервер принимает ЧАСТИЧНОЕ
///    тело, где отсутствующее поле ≠ поле со значением `null` (первое —
///    "не трогать", второе — "очистить"). Обычный `Encodable`-struct с
///    Optional-полями через синтезированный `Codable` эту разницу теряет
///    (nil у него — всегда "не отправлять ключ"), а `[String: JSONValue]`
///    строится вызывающим кодом явно и может нести `.null` осознанно.
public enum JSONValue: Codable, Sendable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Неподдерживаемый JSON-узел")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }

    /// Разворачивает `.string` в markdown/текст заметки, если содержимое —
    /// именно строка (ответ `GET /notes/:id?format=markdown`), иначе nil.
    public var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }
}

// MARK: - Ergonomic literals — чтобы PATCH-словари строились как обычные литералы,
// а не через `.string("x")` на каждом поле: `["title": "Новое", "priority": 2]`.

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
}

extension JSONValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .number(value) }
}

extension JSONValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension JSONValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) { self = .null }
}

extension JSONValue: ExpressibleByArrayLiteral {
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
}

public extension JSONValue {
    /// Для полей вида `label_ids: string[]` в теле запроса.
    static func strings(_ values: [String]) -> JSONValue {
        .array(values.map { .string($0) })
    }
}
