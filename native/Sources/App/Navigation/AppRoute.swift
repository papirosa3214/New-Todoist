import Foundation

/// Маршруты приложения — 1:1 таблице «Имена корневых вью» из
/// `spec/INTEGRATION.md`. Каждый case и его параметры совпадают буквально с
/// тем, что описано в контракте (`taskID`, `noteID`, `projectID`, `labelID`) —
/// это то, что писатели экранов ждут от навигации по правилу контракта
/// «переход на другой экран — через маршрут из таблицы».
///
/// `/inbox` сознательно отсутствует — маршрут убран из веба 26.08.2026,
/// нативного аналога нет (см. INTEGRATION.md).
public enum AppRoute: Hashable {
    case today
    case overview
    case upcoming
    case timeline
    case chat
    case taskDetail(taskID: String)
    /// `nil` — создание новой задачи, иначе правка существующей.
    case taskForm(taskID: String?)
    case notes
    case noteEditor(noteID: String)
    case projects
    case projectTasks(projectID: String)
    case labels
    case labelTasks(labelID: String)
    case search
    case activity
    case notifications
    case agents
    case agentWork
    case settings
    case integrations
    case templates
    case voiceModels
}
