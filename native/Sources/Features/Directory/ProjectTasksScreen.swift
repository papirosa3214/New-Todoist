import SwiftUI

// «Задачи проекта» — spec/SCREENS-2.md §8, `/projects/:id`. Сверено построчно
// с живым `src/screens/ProjectTasksScreen.tsx` 31.08.2026.
//
// ⚠️ КОНТРАКТНАЯ ДЫРА (не мой файл чинить, в отчёте оркестратору): «+» в
// шапке в вебе ведёт на `/task/new?project=id` — с предзаполненным проектом.
// `AppRoute.taskForm(taskID:)` по INTEGRATION.md несёт только `taskID`, поля
// «проект» там нет — веду на пустую форму без предзаполнения, пользователь
// выберет проект вручную. Роут `.notes` (кнопка «Документация» внутри
// `ProjectNotesSection`) аналогично не умеет открыть КОНКРЕТНУЮ папку —
// в вебе `navigate("/notes")` тоже без параметра папки, так что здесь
// расхождения с вебом нет, просто у экрана `/notes` в принципе нет входа
// «сразу в эту папку» ни там, ни здесь.
struct ProjectTasksScreen: View {
    let projectID: String

    @Environment(ProjectStore.self) private var projectStore
    @Environment(TaskStore.self) private var taskStore

    private enum PendingNav: Identifiable, Hashable {
        case detail(String)
        case edit(String)
        var id: String {
            switch self {
            case .detail(let id): "d-\(id)"
            case .edit(let id): "e-\(id)"
            }
        }
    }
    @State private var pending: PendingNav?
    @State private var showNewTask = false

    private var project: ApiProject? {
        projectStore.projects.first { $0.id == projectID }
    }

    /// Закреплённые — единым блоком сверху, порядок внутри каждой группы не
    /// трогаем (два `filter`, НЕ `sorted(by:)` — `Array.sort` в Swift не
    /// гарантированно стабилен, а спека и веб-код требуют стабильность).
    private var tasks: [ApiTask] {
        let scoped = taskStore.tasks.filter { $0.projectId == projectID && $0.status == .active }
        return scoped.filter { $0.pinned } + scoped.filter { !$0.pinned }
    }

    private var notFound: Bool {
        !projectStore.isLoading && projectStore.errorMessage == nil && project == nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TFSpacing.md) {
                TFErrorBanner(projectStore.errorMessage, variant: .inline)
                TFErrorBanner(taskStore.errorMessage, variant: .inline)

                if projectStore.isLoading || taskStore.isLoading { TFLoading(.block) }

                if notFound {
                    notFoundView
                } else if let project {
                    if tasks.isEmpty {
                        Text("В проекте пока нет задач")
                            .tfText(.action)
                            .foregroundStyle(Color.tfDim)
                            .padding(.horizontal, TFSpacing.xs)
                    } else {
                        VStack(spacing: 2) {
                            ForEach(tasks) { task in
                                DirectoryTaskRow(
                                    task: task,
                                    pinned: task.pinned,
                                    onOpen: { pending = .detail(task.id) },
                                    onTogglePin: {
                                        Task {
                                            // `apply` — пустышка, как у ВСЕХ остальных вызовов `taskStore.patch`
                                            // в проекте (проверено грепом): поля `ApiTask` — `let`, замыкание не
                                            // может их точечно мутировать, а обновление и так придёт из ответа
                                            // сервера (`patch()` сам подставляет `updated` при успехе).
                                            await taskStore.patch(taskId: task.id, fields: ["pinned": .bool(!task.pinned)]) { _ in }
                                        }
                                    },
                                    onEdit: { pending = .edit(task.id) },
                                    onDelete: { Task { await taskStore.delete(taskId: task.id) } }
                                )
                            }
                        }
                    }

                    ProjectNotesSection(project: project, onProjectPatched: { _ in
                        Task { await projectStore.load() }
                    })
                }
            }
            .padding(.top, TFSpacing.sm)
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Своя шапка уже несёт заголовок и кнопку «назад» — системный навбар
        // поверх неё давал ВТОРУЮ стрелку и лишнюю полосу.
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            DirectoryCompactHeader(
                title: project?.name ?? "Проект",
                actions: project != nil ? [TFHeaderAction(icon: "plus") { showNewTask = true }] : [],
                accessory: project.map { p in
                    { AnyView(Circle().fill(Color(hex: p.color ?? "#A6A6A6")).frame(width: 10, height: 10)) }
                }
            )
        }
        .task {
            if projectStore.projects.isEmpty { await projectStore.load() }
            if taskStore.tasks.isEmpty { await taskStore.load() }
        }
        .navigationDestination(item: $pending) { target in
            switch target {
            case .detail(let id): routeDestination(.taskDetail(taskID: id))
            case .edit(let id): routeDestination(.taskForm(taskID: id))
            }
        }
        .navigationDestination(isPresented: $showNewTask) { routeDestination(.taskForm(taskID: nil)) }
    }

    private var notFoundView: some View {
        VStack(spacing: TFSpacing.md) {
            Text("Проект не найден — возможно, он удалён.")
                .tfText(.action)
                .foregroundStyle(Color.tfSub)
            NavigationLink(value: AppRoute.projects) {
                Text("К списку проектов")
                    .tfText(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.tfText)
                    .padding(.horizontal, TFSpacing.lg)
                    .frame(height: 44)
                    .background(Color.tfCard)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }
            .buttonStyle(TFTapScaleStyle())
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, TFSpacing.xl)
    }
}
