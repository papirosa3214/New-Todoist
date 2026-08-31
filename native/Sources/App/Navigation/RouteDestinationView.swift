import SwiftUI

/// Фабрика «маршрут → вью» — spec/INTEGRATION.md, правило 1 и 3: сейчас
/// ветки написанных экранов уже отдают настоящие вью, остальные — заглушку
/// `…ScreenStub`; по мере готовности экрана оркестратор меняет его ветку
/// одной строкой, структуру `switch` трогать не нужно.
/// Писатели экранов сюда не ходят (файл в `Sources/App/`, правило 2 контракта).
@ViewBuilder
func routeDestination(_ route: AppRoute) -> some View {
    switch route {
    case .today:
        TodayScreen()
    case .overview:
        OverviewScreen()
    case .upcoming:
        UpcomingScreen()
    case .timeline:
        TimelineScreen()
    case .chat:
        ChatScreen()
    case .taskDetail(let taskID):
        TaskDetailScreen(taskID: taskID)
    case .taskForm(let taskID):
        TaskFormScreen(taskID: taskID)
    case .notes:
        NotesScreen()
    case .noteEditor(let noteID):
        ScreenStub("NoteEditorScreenStub", detail: "noteID: \(noteID)")
    case .projects:
        ScreenStub("ProjectsScreenStub")
    case .projectTasks(let projectID):
        ScreenStub("ProjectTasksScreenStub", detail: "projectID: \(projectID)")
    case .labels:
        ScreenStub("LabelsScreenStub")
    case .labelTasks(let labelID):
        ScreenStub("LabelTasksScreenStub", detail: "labelID: \(labelID)")
    case .search:
        ScreenStub("SearchScreenStub")
    case .activity:
        ScreenStub("ActivityScreenStub")
    case .notifications:
        ScreenStub("NotificationsScreenStub")
    case .agents:
        AgentsScreen()
    case .agentWork:
        ScreenStub("AgentWorkScreenStub")
    case .settings:
        SettingsScreen()
    case .integrations:
        ScreenStub("IntegrationsScreenStub")
    case .templates:
        ScreenStub("TemplatesScreenStub")
    case .voiceModels:
        ScreenStub("VoiceModelsScreenStub")
    }
}
