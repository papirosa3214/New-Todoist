import SwiftUI

/// «Работа агентов» — отдельный контур поручений, назначенных ИИ.
/// Проект отвечает на вопрос «к чему относится задача», исполнитель —
/// «кто ею занимается», поэтому карточка видна здесь у исполнителя и
/// остаётся доступной в самом проекте.
struct AgentWorkScreen: View {
    @Environment(TaskStore.self) private var taskStore

    /// Тот же приём, что `TodayScreen`/`TimelineScreen` — не `ApiTask?`,
    /// а сразу маршрут: `.navigationDestination(item:)` по `AppRoute` не
    /// плодит второй канал навигации рядом с общей фабрикой.
    @State private var route: AppRoute?

    private struct Section: Identifiable {
        let assigneeID: String
        let name: String
        let tasks: [ApiTask]
        var id: String { assigneeID }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TFErrorBanner(taskStore.errorMessage.map { _ in "Не удалось загрузить задачи" })
                    .padding(.horizontal, TFSpacing.screenHorizontal)
                    .padding(.top, TFSpacing.sm)

                // Только первый заход — `TaskStore.isLoading` включается на
                // КАЖДЫЙ `load()`, включая переподключение реалтайма; без
                // проверки на пустой кэш «Загрузка…» мигала бы поверх уже
                // показанного списка (веб-`isLoading` — только первый запрос).
                if taskStore.isLoading && taskStore.tasks.isEmpty {
                    TFLoading(.block)
                        .frame(maxWidth: .infinity)
                        .padding(.top, TFSpacing.xl)
                }

                if isNothing {
                    Text("Агентам пока ничего не назначено.")
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                        .padding(.top, TFSpacing.md)
                }

                ForEach(sections) { section in
                    if !section.tasks.isEmpty {
                        sectionView(section)
                    }
                }
            }
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Нативная сворачивающаяся шапка по официальным гайдам SwiftUI.
        .navigationTitle("Работа агентов")
        .navigationBarTitleDisplayMode(.large)
        .safeAreaInset(edge: .top, spacing: 0) {
            TFScreenHeader("Работа агентов", variant: .compact,
                            leading: { AnyView(DirectoryBackButton()) })
                .background(Color.tfBackground)
        }
        .navigationDestination(item: $route) { routeDestination($0) }
    }

    private func sectionView(_ section: Section) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(section.name) · \(section.tasks.count)")
                    .tfText(.action).fontWeight(.semibold)
                    .foregroundStyle(Color.tfText)
                Text("Все назначенные задачи и их состояния")
                    .tfText(.meta)
                    .foregroundStyle(Color.tfSub)
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.top, TFSpacing.md)
            .padding(.bottom, TFSpacing.xs)

            ForEach(section.tasks) { task in
                AgentWorkTaskRow(task: task) { route = .taskDetail(taskID: task.id) }
            }
        }
        .padding(.bottom, TFSpacing.sm)
    }

    // MARK: - Группировка по исполнителям

    private var agentTasks: [ApiTask] {
        taskStore.tasks.filter { $0.status == .active && $0.assigneeType == .ai }
    }

    private var sections: [Section] {
        Dictionary(grouping: agentTasks, by: { $0.assigneeId ?? "unknown" })
            .map { id, tasks in
                Section(
                    assigneeID: id,
                    name: tasks.first?.assigneeName ?? "Агент",
                    tasks: tasks.sorted { stateRank($0) < stateRank($1) }
                )
            }
            .sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    private func stateRank(_ task: ApiTask) -> Int {
        switch task.agentState {
        case .inProgress: return task.agentStale == true ? 3 : 0
        case .review: return 1
        case .blocked: return 2
        case nil: return 4
        }
    }

    private var isNothing: Bool {
        !taskStore.isLoading && taskStore.errorMessage == nil && agentTasks.isEmpty
    }
}
