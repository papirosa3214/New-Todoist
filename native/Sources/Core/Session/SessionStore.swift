import Foundation
import Observation

/// Сессия пользователя — вход/выход, автоподхват при запуске.
///
/// spec/API.md §2.2: JWT живёт 30 дней и дальше не обновляется автоматически;
/// LAN-релогин веба «не применим» к нативному клиенту — на 401 нативный
/// клиент должен сразу разлогинить и показать экран входа. Это подписка на
/// `.taskFlowUnauthorized` ниже, которую рассылает `APIClient` при любом 401.
@MainActor
@Observable
public final class SessionStore {
    public private(set) var currentUser: ApiUser?
    public private(set) var isBootstrapping = true
    public var errorMessage: String?

    public var isAuthenticated: Bool { currentUser != nil }

    private let apiClient: APIClient
    /// `nonisolated(unsafe)`: `deinit` у `@MainActor`-класса сам нонизолирован
    /// (объект может освобождаться с любого потока), поэтому обычное
    /// MainActor-изолированное свойство в нём недоступно без `await`, а
    /// `deinit` его дать не может. Безопасно здесь: пишется один раз в
    /// `init`, читается только в `deinit`, гонки нет.
    private nonisolated(unsafe) var unauthorizedObserver: NSObjectProtocol?

    public init(apiClient: APIClient) {
        self.apiClient = apiClient
        unauthorizedObserver = NotificationCenter.default.addObserver(
            forName: .taskFlowUnauthorized, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.currentUser = nil }
        }
    }

    deinit {
        if let unauthorizedObserver {
            NotificationCenter.default.removeObserver(unauthorizedObserver)
        }
    }

    /// Один раз при старте приложения. Токен в Keychain не значит «сессия
    /// жива» — 30-дневный JWT мог истечь, пока приложение не запускали,
    /// поэтому проверяем его `GET /auth/me`, а не доверяем на слово.
    public func bootstrap() async {
        defer { isBootstrapping = false }
        guard KeychainService.shared.token != nil else { return }
        do {
            currentUser = try await apiClient.me()
        } catch {
            // 401 уже почистил Keychain внутри APIClient. На прочие ошибки
            // (например, сервер недоступен при старте) токен НЕ трогаем —
            // не разлогинивать только из-за того, что сеть/сервер сейчас
            // недоступны; следующий запуск/ручной повтор попробует снова.
            currentUser = nil
        }
    }

    public func login(email: String, password: String) async {
        errorMessage = nil
        do {
            let response = try await apiClient.login(email: email, password: password)
            KeychainService.shared.token = response.token
            currentUser = response.user
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    public func logout() {
        KeychainService.shared.token = nil
        currentUser = nil
    }
}
