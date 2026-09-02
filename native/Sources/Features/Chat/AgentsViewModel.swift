import Foundation
import Observation

/// Состояние экрана «Команда» — 1:1 поведение `useAgents`/`useCreateAgent`/
/// `useRenameAgent`/`useDeleteAgent` (`src/api/agents.ts`, `AgentsScreen.tsx`).
/// Свой `APIClient` — по тем же причинам, что у `ChatViewModel` (см. её
/// комментарий): в environment `Sources/App/` живут только `TaskStore`/
/// `ProjectStore`/`LabelStore`/`NotificationStore`/`SessionStore`, стора
/// агентов там нет.
@MainActor
@Observable
final class AgentsViewModel {
    private(set) var agents: [ApiUser] = []
    private(set) var isLoading = false
    var listErrorMessage: String?
    var deleteErrorMessage: String?

    /// Ключ только что заведённого агента — сервер отдаёт его РОВНО ОДИН
    /// раз в ответе создания, больше ни одним маршрутом. Живёт только в
    /// памяти экрана (SCREENS-2 §4).
    private(set) var issuedToken: (name: String, token: String)?
    var createErrorMessage: String?
    var renameErrorMessage: String?
    var avatarErrorMessage: String?

    private(set) var isOwner = false

    private let api = APIClient()
    private var pollTask: Task<Void, Never>?

    /// `SessionStore.currentUser` приходит из `@Environment`, недоступного
    /// внутри `init()` вью — экран зовёт это явно в `.task` до `start()`.
    func configure(currentUser: ApiUser?) {
        isOwner = currentUser?.role == .owner
    }

    /// Раз в 15с (веб: `refetchInterval: 15000`) — присутствие/лимиты живые.
    func start() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                await self.load()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func load() async {
        if agents.isEmpty { isLoading = true }
        defer { isLoading = false }
        do {
            agents = try await api.agents()
            listErrorMessage = nil
        } catch {
            listErrorMessage = Self.message(for: error)
        }
    }

    func createAgent(name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        createErrorMessage = nil
        do {
            let response = try await api.inviteAgentFixed(name: trimmed)
            issuedToken = (response.agent.name, response.apiToken)
            await load()
        } catch {
            createErrorMessage = Self.message(for: error)
        }
    }

    func dismissIssuedToken() {
        issuedToken = nil
    }

    func renameAgent(id: String, name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true } // как в вебе — пустое/неизменное просто закрывает форму
        renameErrorMessage = nil
        do {
            _ = try await api.renameAgentFixed(id: id, name: trimmed)
            await load()
            return true
        } catch {
            renameErrorMessage = Self.message(for: error)
            return false
        }
    }

    func deleteAgent(_ agent: ApiUser) async {
        deleteErrorMessage = nil
        do {
            try await api.deleteAgent(id: agent.id)
            await load()
        } catch {
            deleteErrorMessage = Self.message(for: error)
        }
    }

    func uploadAvatar(agentId: String, data: Data, mime: String) async {
        avatarErrorMessage = nil
        do {
            _ = try await api.uploadAgentAvatar(id: agentId, data: data, mime: mime)
            await load()
        } catch {
            avatarErrorMessage = Self.message(for: error)
        }
    }

    func removeAvatar(agentId: String) async {
        avatarErrorMessage = nil
        do {
            try await api.deleteAgentAvatar(id: agentId)
            await load()
        } catch {
            avatarErrorMessage = Self.message(for: error)
        }
    }

    private static func message(for error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}
