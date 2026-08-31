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
        #if DEBUG
        // Отладочный вход: сервер выдаёт постоянный api_token, который живёт
        // в том же заголовке `Authorization`, что и JWT. Токен передаётся
        // переменной окружения при запуске в симуляторе — так экраны можно
        // посмотреть, не вводя руками пароль и ничего не зашивая в код.
        // Только для отладочной сборки: в релиз этот путь не попадает.
        if let debugToken = ProcessInfo.processInfo.environment["TASKFLOW_DEBUG_TOKEN"],
           debugToken.isEmpty == false {
            KeychainService.shared.token = debugToken
        }
        #endif
        guard KeychainService.shared.token != nil else {
            // Токена нет — пробуем войти без пароля, как это делает веб в
            // домашней сети. Снаружи сервер отвечает 404, тогда просто
            // покажем форму входа.
            await tryLanLogin()
            return
        }
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

    /// Вход без пароля из домашней сети. Молчаливый: не удалось — просто
    /// остаёмся без сессии, ошибку владельцу не показываем (снаружи дома
    /// это НЕ сбой, а ожидаемый 404).
    private func tryLanLogin() async {
        do {
            let response = try await apiClient.lanLogin()
            KeychainService.shared.token = response.token
            currentUser = response.user
        } catch {
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
