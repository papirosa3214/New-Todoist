import Foundation
import AuthenticationServices
import UIKit

/// Google-часть `/settings/integrations` — контракты сервера сняты с
/// `server/src/routes/integrations.ts` и `src/api/integrations.ts` (спека
/// §14 описывает ТОЛЬКО состав экрана, не форму ответов — ARCHITECTURE.md
/// п.3 разрешает читать код там, где спека не даёт нужного уровня детали).

struct IntegrationStatusResponse: Decodable, Sendable {
    struct Google: Decodable, Sendable {
        let configured: Bool
        let connected: Bool
        let email: String?
        let lastSyncedAt: String?
        let settings: GoogleSettings

        enum CodingKeys: String, CodingKey {
            case configured, connected, email
            case lastSyncedAt = "lastSyncedAt"
            case settings
        }
    }
    let google: Google
}

/// `settings` сервер отдаёт как произвольный JSON-объект — здесь нужен
/// только `listId`, остальные поля (например `autoSync`) читаем не глядя.
struct GoogleSettings: Decodable, Sendable {
    let listId: String?
}

struct GoogleTaskListItem: Decodable, Identifiable, Sendable {
    let id: String
    let title: String
}

struct GoogleCalendarInfo: Decodable, Identifiable, Sendable {
    let id: String
    let summary: String
    let backgroundColor: String?
    let primary: Bool?
}

struct GoogleAuthURLResponse: Decodable, Sendable { let url: String }
struct GoogleCallbackResponse: Decodable, Sendable { let ok: Bool; let email: String? }
struct GoogleSyncResponse: Decodable, Sendable {
    let ok: Bool
    let imported: Int
    let updated: Int
    let totalGoogleTasks: Int
}
// Отключение и смена списка отвечают тем же `{ ok: true }`, что и остальное
// API — используем уже существующий общий `APIOkResponse` (`APIError.swift`),
// не заводим дубликат.

/// Тело `PATCH /integrations/settings` — веб мержит текущие `settings` с
/// новым `listId`; здесь упрощённо шлём только `listId` (единственное поле,
/// которым управляет этот экран) — если у пользователя когда-то появится
/// `autoSync` через веб, эта правка его затрёт. Гэп отмечен в отчёте,
/// сознательно не тяну сюда общий JSON-merge ради одного поля.
private struct UpdateGoogleSettingsBody: Encodable {
    let provider = "google"
    let settings: [String: String]
}

extension APIClient {
    func integrationsStatus() async throws -> IntegrationStatusResponse {
        try await request(.get, "/integrations/status")
    }

    func googleAuthURL(redirectURI: String) async throws -> GoogleAuthURLResponse {
        try await request(.get, "/integrations/google/auth-url", query: [URLQueryItem(name: "redirect_uri", value: redirectURI)])
    }

    func googleCallback(code: String, redirectURI: String) async throws -> GoogleCallbackResponse {
        struct Body: Encodable { let code: String; let redirectUri: String }
        return try await request(.post, "/integrations/google/callback", body: Body(code: code, redirectUri: redirectURI))
    }

    func googleTaskLists() async throws -> [GoogleTaskListItem] {
        struct Response: Decodable { let lists: [GoogleTaskListItem] }
        let response: Response = try await request(.get, "/integrations/google/lists")
        return response.lists
    }

    func googleCalendars() async throws -> [GoogleCalendarInfo] {
        struct Response: Decodable { let calendars: [GoogleCalendarInfo] }
        let response: Response = try await request(.get, "/integrations/google/calendars")
        return response.calendars
    }

    func googleSync(listId: String) async throws -> GoogleSyncResponse {
        struct Body: Encodable { let listId: String }
        return try await request(.post, "/integrations/google/sync", body: Body(listId: listId))
    }

    func googleDisconnect() async throws -> APIOkResponse {
        try await request(.post, "/integrations/google/disconnect")
    }

    func updateGoogleListId(_ listId: String) async throws -> APIOkResponse {
        try await request(.patch, "/integrations/settings", body: UpdateGoogleSettingsBody(settings: ["listId": listId]))
    }
}

/// OAuth-вход через `ASWebAuthenticationSession` — веб делает полный редирект
/// (`window.location.href = url`) и потом читает `?code=` из URL при
/// возврате; на native ближайший честный эквивалент — системная эфемерная
/// сессия браузера, которая САМА перехватывает финальный редирект по схеме
/// `callbackURLScheme`, без переоткрытия приложения через `onOpenURL` (то
/// есть без правок `App/`, которые мне не разрешены).
///
/// ⚠️ Гэп для владельца: `redirectURI` ниже — кастомная схема
/// `com.maksim.taskflow.native://oauth-callback`. Она разрешена ЛЮБОЙ строкой
/// на стороне `ASWebAuthenticationSession` (Info.plist трогать не нужно), но
/// Google приемлет только ЗАРАНЕЕ зарегистрированный redirect URI — эту же
/// строку нужно добавить в «Authorized redirect URIs» OAuth-клиента в Google
/// Cloud Console. Без этого шага Google на экране согласия покажет
/// `redirect_uri_mismatch` — это внешняя настройка владельца, я её изменить
/// не могу и не проверяю (граница задачи: «интеграции не подключать»).
enum GoogleOAuth {
    static let redirectURI = "com.maksim.taskflow.native://oauth-callback"

    static func authorize(url: URL) async throws -> String {
        let contextProvider = PresentationContextProvider()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "com.maksim.taskflow.native") { callbackURL, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard
                    let callbackURL,
                    let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                    let code = components.queryItems?.first(where: { $0.name == "code" })?.value
                else {
                    continuation.resume(throwing: APIError.decoding(NSError(domain: "GoogleOAuth", code: -1, userInfo: [NSLocalizedDescriptionKey: "Google не вернул код авторизации"])))
                    return
                }
                continuation.resume(returning: code)
            }
            session.presentationContextProvider = contextProvider
            session.prefersEphemeralWebBrowserSession = true
            // Провайдер должен пережить весь показ сессии — session сама
            // держит на него сильную ссылку, но локальная переменная тут
            // же вышла бы из области видимости без явного withExtendedLifetime.
            withExtendedLifetime(contextProvider) {
                if !session.start() {
                    continuation.resume(throwing: APIError.decoding(NSError(domain: "GoogleOAuth", code: -2, userInfo: [NSLocalizedDescriptionKey: "Не удалось открыть окно входа Google"])))
                }
            }
        }
    }

    private final class PresentationContextProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            // Единственный способ достать активное окно без своего инжекта в
            // `App/` — через `connectedScenes`, тот же приём, что ниже
            // используется у `AppleEventKitAccess` не нужен, здесь он нужен
            // именно потому, что `ASWebAuthenticationSession` требует anchor.
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}
