import Foundation
import Observation

/// Вид экрана «Сегодня» — persist в `taskLayout.today` (spec §4.4).
enum TodayLayout: String, CaseIterable {
    case list, board, hours
}

/// Вью-модель «Сегодня» — собирает данные из общих сторов (`TaskStore`/
/// `ProjectStore`/`SessionStore`, инъекция через `@Environment` в App/)
/// и локальное состояние экрана (фильтры, вид, офсет дня в «часах»).
///
/// Список агентов НЕ приходит ни из одного общего стора (в Core нет
/// `AgentStore` — только сырой метод `APIClient.agents()`), а нужен для
/// `isAgentAssignedTask` (задачи агентов исключаются из «часов», spec §5.1)
/// и для `isWaitingForUser`. Здесь заведён свой `APIClient()` — он
/// `Sendable` и без состояния (токен читает из Keychain на каждый запрос,
/// см. комментарий в `Core/Networking/APIClient.swift`), поэтому второй
/// экземпляр безопасен и не конфликтует с тем, что держит `TaskFlowApp`.
@MainActor
@Observable
final class TodayViewModel {
    private let apiClient = APIClient()

    var agents: [ApiUser] = []
    var filters = TodayTaskFilters.empty
    var layout: TodayLayout {
        didSet { UserDefaults.standard.set(layout.rawValue, forKey: Self.layoutKey) }
    }
    var hourDateOffset = 0

    /// Opt-in список проектов, видимых в ежедневнике (spec §3.10/§4.4).
    /// Ключ и формат СОГЛАСОВАНЫ с `UpcomingScreen` (тот же раздел «Планирование»
    /// делит эту настройку) — оркестратору свести оба экрана на одном сторе,
    /// если `UpcomingScreen` заведёт своё собственное имя ключа.
    var visibleProjectIds: [String: Bool] {
        didSet {
            hasConfiguredVisibleProjects = true
            Self.saveVisibleProjects(visibleProjectIds)
        }
    }

    /// Пользователь хоть раз сам выбирал проекты ежедневника?
    ///
    /// В вебе этот выбор у владельца сделан давно и лежит в браузере, а
    /// свежепоставленное приложение начинало с пустым списком — и «Сегодня»
    /// открывался пустым, хотя задачи есть (01.09.2026, поймано UI-тестом и
    /// подтверждено кадром). Поэтому «ни разу не настраивал» = показывать
    /// все проекты; как только выбор сделан руками, он уважается как есть.
    private(set) var hasConfiguredVisibleProjects: Bool

    private static let layoutKey = "taskflow_today_layout"
    private static let visibleProjectsKey = "taskflow_planner_visible_projects"

    init() {
        layout = TodayLayout(rawValue: UserDefaults.standard.string(forKey: Self.layoutKey) ?? "") ?? .list
        hasConfiguredVisibleProjects = UserDefaults.standard.data(forKey: Self.visibleProjectsKey) != nil
        visibleProjectIds = Self.loadVisibleProjects()
    }

    func toggleVisibleProject(_ id: String) {
        if visibleProjectIds[id] == true {
            visibleProjectIds.removeValue(forKey: id)
        } else {
            visibleProjectIds[id] = true
        }
    }

    func loadAgentsIfNeeded() async {
        guard agents.isEmpty else { return }
        agents = (try? await apiClient.agents()) ?? []
    }

    private static func loadVisibleProjects() -> [String: Bool] {
        guard let data = UserDefaults.standard.data(forKey: visibleProjectsKey),
              let dict = try? JSONDecoder().decode([String: Bool].self, from: data) else { return [:] }
        return dict
    }

    private static func saveVisibleProjects(_ dict: [String: Bool]) {
        guard let data = try? JSONEncoder().encode(dict) else { return }
        UserDefaults.standard.set(data, forKey: visibleProjectsKey)
    }
}
