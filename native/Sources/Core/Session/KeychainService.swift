import Foundation
import Security

/// Хранилище токена сессии в Keychain — spec/API.md §2.2: «токен живёт 30 дней,
/// это секрет уровня пароля, UserDefaults не подходит». Один и тот же
/// заголовок `Authorization: Bearer <значение>` годится и для JWT, и для
/// api_token (сервер сам разбирает, что прислано) — поэтому хранится просто
/// как «текущий токен», без разделения на два вида.
///
/// `@unchecked Sendable`: сама Keychain API синхронна и потокобезопасна на
/// уровне ОС, здесь нет внутреннего изменяемого состояния экземпляра.
public final class KeychainService: @unchecked Sendable {
    public static let shared = KeychainService()

    private let service = "com.maksim.taskflow.native"
    private let account = "session-token"

    private init() {}

    /// Текущий токен, если пользователь входил и не выходил. `nil` — нет
    /// сессии, показывать экран входа.
    public var token: String? {
        get {
            var query = baseQuery()
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne

            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            guard status == errSecSuccess, let data = result as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            if let newValue {
                save(newValue)
            } else {
                delete()
            }
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func save(_ value: String) {
        let data = Data(value.utf8)
        var query = baseQuery()
        // Сначала пробуем обновить существующую запись — SecItemAdd на уже
        // занятый account/service вернёт errSecDuplicateItem.
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(query as CFDictionary, nil)
        }
    }

    private func delete() {
        SecItemDelete(baseQuery() as CFDictionary)
    }
}
