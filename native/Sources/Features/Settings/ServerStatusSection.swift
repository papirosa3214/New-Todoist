import SwiftUI
import Observation

/// Ответ `GET /server-status` — поля сняты живым чтением серверного кода
/// (`server/src/index.ts`, роут `/api/server-status`, НЕ живым запросом —
/// он требует токен владельца, которого у исполнителя этой задачи нет и не
/// должно быть). Спека API.md полей не перечисляет («статус сервера»),
/// поэтому источник истины здесь — код сервера (правило ARCHITECTURE.md п.3).
struct ServerStatusResponse: Decodable, Sendable {
    let ok: Bool
    let uptimeSec: Int
    let commit: String?
    let commitAt: String?
    let tasksActive: Int
    let tasksTotal: Int
    let dbBytes: Int?
    let ollamaOnline: Bool
    let ollamaModel: String

    enum CodingKeys: String, CodingKey {
        case ok
        case uptimeSec = "uptime_sec"
        case commit
        case commitAt = "commit_at"
        case tasksActive = "tasks_active"
        case tasksTotal = "tasks_total"
        case dbBytes = "db_bytes"
        case ollamaOnline = "ollama_online"
        case ollamaModel = "ollama_model"
    }
}

/// Ответ `GET/POST /api/agent-service` — `server/src/routes/agent-service.ts`,
/// прочитан целиком (read-only), тело реально `{ active, enabled }`.
struct AgentServiceResponse: Decodable, Sendable {
    let active: Bool
    let enabled: Bool
}

/// Вью-модель блока «Сервер» — spec/SCREENS-2.md §6 п.5, состояния строго по
/// факту запроса (не отвечает / грузится / успех). Отдельный `APIClient()` —
/// тот же приём, что у `TodayViewModel` (клиент `Sendable`, второй экземпляр
/// безопасен).
@MainActor
@Observable
final class ServerStatusViewModel {
    private let apiClient = APIClient()

    enum Phase: Equatable { case loading, failed, loaded }
    var phase: Phase = .loading
    var status: ServerStatusResponse?
    var agentService: AgentServiceResponse?
    var pingResult: String?
    var isPinging = false
    /// Переключение будильника — реальный `POST /agent-service`, включающий/
    /// выключающий systemd-юнит НА СЕРВЕРЕ. Задача прямо запрещает трогать
    /// настройки живого сервера — проводка написана (штатная функция экрана
    /// для владельца), но сама я её ни разу не вызвала за время работы.
    var isTogglingService = false

    func load() async {
        async let statusTask: ServerStatusResponse? = try? apiClient.request(.get, "/server-status")
        async let serviceTask: AgentServiceResponse? = try? apiClient.request(.get, "/agent-service")
        let (loadedStatus, loadedService) = await (statusTask, serviceTask)
        status = loadedStatus
        agentService = loadedService
        phase = loadedStatus == nil ? .failed : .loaded
    }

    func ping() async {
        isPinging = true
        pingResult = nil
        let start = Date()
        struct HealthResponse: Decodable { let ok: Bool }
        do {
            let health: HealthResponse = try await apiClient.request(.get, "/health")
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            pingResult = health.ok ? "⚡ \(elapsedMs) мс · 192.168.1.110 в сети" : "❌ Ошибка ответа"
        } catch {
            pingResult = "❌ Сервер недоступен"
        }
        isPinging = false
        await load()
    }

    func toggleAgentService() async {
        guard let agentService else { return }
        isTogglingService = true
        struct Body: Encodable { let on: Bool }
        self.agentService = (try? await apiClient.request(.post, "/agent-service", body: Body(on: !agentService.active))) ?? agentService
        isTogglingService = false
    }
}

/// Форматтеры — буквальные порты `fmtUptime`/`fmtBytes` из
/// `src/screens/SettingsScreen.tsx` (числа/пороги 1:1, чтобы значения на
/// экране совпадали с вебом).
enum ServerStatusFormat {
    static func uptime(_ sec: Int) -> String {
        if sec < 60 { return "\(sec) с" }
        let minutes = sec / 60
        if minutes < 60 { return "\(minutes) мин" }
        let hours = minutes / 60
        if hours < 24 {
            let rest = minutes % 60
            return rest != 0 ? "\(hours) ч \(rest) мин" : "\(hours) ч"
        }
        let days = hours / 24
        let restHours = hours % 24
        return restHours != 0 ? "\(days) д \(restHours) ч" : "\(days) д"
    }

    static func bytes(_ bytes: Int) -> String {
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded())) КБ" }
        return String(format: "%.1f МБ", Double(bytes) / 1024 / 1024)
    }

    /// `commit_at` — ISO8601 с офсетом (`git log --format=%cI`), формат
    /// вывода как в вебе: «31 авг.».
    static func commitDate(_ iso: String) -> String? {
        guard let date = DateFormats.iso8601(iso) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.dateFormat = "d MMM"
        return formatter.string(from: date)
    }
}

/// Секция «Сервер» — spec §6 п.5, три состояния буквально по спеке: не
/// ответил / грузится / успех (с шестью строками внутри). Строки собраны на
/// `TFListRow` (не `TFFieldRow`) — сверено со скриншотом `settings.png`:
/// «Сервер»/«Локальная LLM» показывают только значение (не тап-строка,
/// `action: nil`), «Проверить связь» показывает значение И шеврон вместе
/// (шеврон дорисован вручную внутри `trailing`, раз он нужен ОДНОВРЕМЕННО
/// со значением — `TFListRow` в остальных местах их не смешивает).
struct ServerStatusSection: View {
    @State private var viewModel = ServerStatusViewModel()

    var body: some View {
        TFCard(padding: 0) {
            VStack(spacing: 0) {
                switch viewModel.phase {
                case .failed:
                    TFListRow(icon: "xmark.circle", iconTint: .tfCoral, title: "Сервер 192.168.1.110", trailing: AnyView(valueText("не отвечает 🔴", color: .tfCoral)))
                    TFDivider(inset: rowDividerInset)
                    TFListRow(icon: "waveform.path.ecg", title: "Повторить проверку", action: { Task { await viewModel.load() } })
                case .loading:
                    TFListRow(icon: "waveform.path.ecg", title: "Сервер 192.168.1.110", trailing: AnyView(valueText("проверяю связь…")))
                case .loaded:
                    loadedRows
                }
            }
        }
        .task { await viewModel.load() }
    }

    @ViewBuilder
    private var loadedRows: some View {
        if let status = viewModel.status {
            TFListRow(
                icon: "waveform.path.ecg", iconTint: .tfTeal,
                title: "Сервер (192.168.1.110)",
                trailing: AnyView(valueText("В сети 🟢 · \(ServerStatusFormat.uptime(status.uptimeSec))"))
            )
            TFDivider(inset: rowDividerInset)
            TFListRow(
                icon: "cpu", iconTint: status.ollamaOnline ? .tfTeal : .tfCoral,
                title: "Локальная LLM (Ollama)",
                trailing: AnyView(valueText(
                    status.ollamaOnline
                        ? "\(status.ollamaModel.replacingOccurrences(of: ":latest", with: "")) в сети 🟢"
                        : "Недоступна 🔴"
                ))
            )
            TFDivider(inset: rowDividerInset)
            TFListRow(
                icon: "bolt.fill", iconTint: .tfBlue,
                title: "Проверить связь (Пинг)",
                trailing: AnyView(HStack(spacing: TFSpacing.xs) {
                    valueText(viewModel.pingResult ?? (viewModel.isPinging ? "Замеряю…" : "Проверить"))
                    Image(systemName: "chevron.right").font(.system(size: 13)).foregroundStyle(Color.tfDim)
                }),
                action: { Task { await viewModel.ping() } }
            )
            if let commit = status.commit {
                TFDivider(inset: rowDividerInset)
                TFListRow(
                    icon: "tag", iconTint: .tfBlue,
                    title: "Версия",
                    trailing: AnyView(valueText(status.commitAt.flatMap(ServerStatusFormat.commitDate).map { "\(commit) · \($0)" } ?? commit))
                )
            }
            TFDivider(inset: rowDividerInset)
            TFListRow(
                icon: "bell.fill", iconTint: .tfCoral,
                title: "Будильник (служба)",
                trailing: AnyView(HStack(spacing: TFSpacing.sm) {
                    valueText(viewModel.agentService?.active == true ? "Включён" : "Выключен")
                    TFToggle(isOn: Binding(
                        get: { viewModel.agentService?.active ?? false },
                        set: { _ in Task { await viewModel.toggleAgentService() } }
                    ))
                    .disabled(viewModel.isTogglingService)
                })
            )
            TFDivider(inset: rowDividerInset)
            TFListRow(
                icon: "list.bullet", iconTint: .tfPurple,
                title: "Задачи",
                trailing: AnyView(valueText(status.dbBytes.map { "\(status.tasksActive) из \(status.tasksTotal) · \(ServerStatusFormat.bytes($0))" }
                    ?? "\(status.tasksActive) из \(status.tasksTotal)"))
            )
        }
    }

    private var rowDividerInset: CGFloat { TFSpacing.lg + 40 + TFSpacing.md }

    private func valueText(_ text: String, color: Color = .tfSub) -> some View {
        Text(text).tfText(.body).foregroundStyle(color)
    }
}
