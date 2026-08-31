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
        NoteEditorScreen(noteID: noteID)
    case .projects:
        ProjectsScreen()
    case .projectTasks(let projectID):
        ProjectTasksScreen(projectID: projectID)
    case .labels:
        LabelsScreen()
    case .labelTasks(let labelID):
        LabelTasksScreen(labelID: labelID)
    case .search:
        SearchScreen()
    case .activity:
        ActivityScreen()
    case .notifications:
        NotificationsScreen()
    case .agents:
        AgentsScreen()
    case .agentWork:
        AgentWorkScreen()
    case .settings:
        SettingsScreen()
    case .integrations:
        IntegrationsScreen()
    case .templates:
        TemplatesScreen()
    case .voiceModels:
        VoiceModelsScreen()
    }
}
