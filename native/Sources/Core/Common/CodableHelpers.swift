import Foundation

// Поля вида `pinned`/`done` хранятся в SQLite как 0/1 (Int), но TS-тип клиента
// иногда держит их как `boolean | number` (spec/API.md §3.2) — сервер реально
// шлёт SQLite-целое. Разбираем оба варианта в Bool, чтобы декодер не падал,
// если сервер когда-нибудь пришлёт настоящий JSON boolean.
extension KeyedDecodingContainer {
    func decodeIntBool(forKey key: Key) throws -> Bool {
        if let intValue = try? decode(Int.self, forKey: key) {
            return intValue != 0
        }
        if let boolValue = try? decode(Bool.self, forKey: key) {
            return boolValue
        }
        return false
    }

    func decodeIntBoolIfPresent(forKey key: Key) throws -> Bool? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        return try decodeIntBool(forKey: key)
    }
}
