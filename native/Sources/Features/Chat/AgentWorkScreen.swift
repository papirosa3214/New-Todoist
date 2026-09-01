import SwiftUI

/// Какой из четырёх разделов поднять первым — веб-параметр URL `?focus=`
/// (`AgentWorkScreen.tsx`), значения дословно совпадают с ключами секций
/// там же. У `AppRoute.agentWork` (контракт, `spec/INTEGRATION.md`) СЕЙЧАС
/// нет параметров вообще — см. развёрнутый комментарий у `init` ниже и
/// отчёт по задаче: это не самодеятельность, а подготовленное место под
/// правку контракта каркасным исполнителем.
enum AgentWorkFocus: String {
    case inProgress = "in_progress"
    case review
    case blocked
    case stale
}

/// «Работа агента» — `/agent-work` (SCREENS-2 §5), сводка активности
/// агентов по четырём состояниям. 1:1 `src/screens/AgentWorkScreen.tsx` —
/// спека в SCREENS-2 §5 самих текстов подсказок не даёт, они сняты с
/// живого экрана (заголовок, hint под каждым разделом, тексты пустого/
/// ошибки состояний — дословно оттуда).
///
/// Источник данных — общий `TaskStore` (тот же кэш, что у «Обзора» и
/// «Сегодня»): свой запрос/поллинг экрану не нужен, `TaskFlowApp` грузит
/// список один раз при входе и держит живым реалтаймом (spec §4.2).
struct AgentWorkScreen: View {
    @Environment(TaskStore.self) private var taskStore

    /// `nil` — обычный порядок разделов. Задан контрактом строго без
    /// параметров (`AgentWorkScreen` в таблице INTEGRATION.md — «—»), но
    /// сам параметр инициализатора СВЕРХ контракта не ломает его: вызов
    /// `AgentWorkScreen()` без аргументов (как сейчас в фабрике маршрутов,
    /// `RouteDestinationView.swift`, чужой файл) остаётся валиден дословно.
    /// Это подготовленное место под будущую правку: у `AppRoute.agentWork`
    /// пока нет ассоциированного значения, чтобы донести фокус сюда с
    /// плиток «Обзора» — чего именно не хватает, см. отчёт по задаче.
    let focus: AgentWorkFocus?

    init(focus: AgentWorkFocus? = nil) {
        self.focus = focus
    }

    /// Тот же приём, что `TodayScreen`/`TimelineScreen` — не `ApiTask?`,
    /// а сразу маршрут: `.navigationDestination(item:)` по `AppRoute` не
    /// плодит второй канал навигации рядом с общей фабрикой.
    @State private var route: AppRoute?

    private struct Section: Identifiable {
        let key: AgentWorkFocus
        let title: String
        let hint: String
        let tasks: [ApiTask]
        var id: AgentWorkFocus { key }
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
                    Text("Агенты сейчас ничем не заняты — назначьте задачу, и она появится здесь.")
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                        .padding(.top, TFSpacing.md)
                }

                ForEach(orderedSections) { section in
                    if !section.tasks.isEmpty {
                        sectionView(section)
                    }
                }
            }
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Своя шапка уже несёт заголовок и кнопку «назад» — системный навбар
        // поверх неё давал ВТОРУЮ стрелку и лишнюю полосу.
        .toolbar(.hidden, for: .navigationBar)
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
                Text("\(section.title) \(section.tasks.count)")
                    .tfText(.action).fontWeight(.semibold)
                    .foregroundStyle(Color.tfText)
                Text(section.hint)
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

    // MARK: - Группировка (буквально `AgentWorkScreen.tsx`, useMemo groups)

    private var active: [ApiTask] {
        taskStore.tasks.filter { $0.status == .active }
    }

    private var groupInProgress: [ApiTask] {
        active.filter { $0.agentState == .inProgress && $0.agentStale != true }
    }

    private var groupStale: [ApiTask] {
        active.filter { $0.agentState == .inProgress && $0.agentStale == true }
    }

    private var groupReview: [ApiTask] {
        active.filter { $0.agentState == .review }
    }

    private var groupBlocked: [ApiTask] {
        active.filter { $0.agentState == .blocked }
    }

    private var sections: [Section] {
        [
            Section(key: .inProgress, title: "В работе", hint: "Агент занят этими задачами прямо сейчас", tasks: groupInProgress),
            Section(key: .review, title: "На проверке", hint: "Агент закончил и сдал работу", tasks: groupReview),
            Section(key: .blocked, title: "Заблокированы", hint: "Агент не может продолжить без вас", tasks: groupBlocked),
            Section(key: .stale, title: "Пропали", hint: "Агент взялся и замолчал — задача висит без работы", tasks: groupStale),
        ]
    }

    /// `?focus=` в вебе двигает совпавший раздел на первое место, остальные
    /// остаются в исходном порядке (стабильная сортировка JS) — Swift
    /// `sorted` стабильность не гарантирует, поэтому явный remove+insert,
    /// а не компаратор.
    private var orderedSections: [Section] {
        guard let focus, let index = sections.firstIndex(where: { $0.key == focus }) else { return sections }
        var result = sections
        let matched = result.remove(at: index)
        result.insert(matched, at: 0)
        return result
    }

    private var isNothing: Bool {
        !taskStore.isLoading && taskStore.errorMessage == nil && sections.allSatisfy { $0.tasks.isEmpty }
    }
}
