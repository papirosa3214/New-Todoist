import SwiftUI

// «Сегодня» (`/today`) — spec/SCREENS-1.md §5.1. Имя структуры и параметры
// (никаких) — контракт `spec/INTEGRATION.md`.
struct TodayScreen: View {
    @Environment(TaskStore.self) private var taskStore
    @Environment(ProjectStore.self) private var projectStore
    @Environment(SessionStore.self) private var session

    @State private var vm = TodayViewModel()
    @State private var route: AppRoute?
    @State private var filterSheetOpen = false
    @State private var openPlannerSectionOnOpen = false
    @State private var rescheduleOpen = false
    /// Конкретная задача, перенесённая через свайп — открывает RescheduleSheet
    /// именно для неё. Приоритет над `rescheduleOpen` (тот для группы
    /// просроченных с доски).
    @State private var rescheduleTask: ApiTask?
    /// 0…1 — насколько крупная дата уехала под шапку. Меняет ТОЛЬКО
    /// прозрачность двух дат (крупной в ленте и мелкой в шапке): высоты
    /// фиксированы, иначе шапка дрожит на каждом кадре прокрутки.
    @State private var collapse: CGFloat = 0

    private var today: String { TodayDate.todayString() }
    private var activeHourDate: String {
        vm.hourDateOffset == 0 ? today : TodayDate.addDays(today, vm.hourDateOffset)
    }

    private var computation: TodayComputation {
        TodayComputation(
            allTasks: taskStore.tasks,
            currentUser: session.currentUser,
            agents: vm.agents,
            filters: vm.filters,
            visibleProjectIds: vm.visibleProjectIds,
            hasConfiguredVisibleProjects: vm.hasConfiguredVisibleProjects,
            today: today,
            activeHourDate: activeHourDate,
            isLoading: taskStore.isLoading,
            isError: taskStore.errorMessage != nil
        )
    }

    var body: some View {
        let c = computation
        ScrollView {
            VStack(spacing: 0) {
                largeTitle
                if c.trueEmpty && vm.layout == .list {
                    TodayEmptyIllustration()
                } else {
                    // Полоска проектов с «плюсом» убрана по просьбе владельца
                    // (01.09.2026): тот же выбор проектов ежедневника уже есть
                    // в шторке фильтров, а сверху списка он только занимал
                    // место — «это всё есть в фильтре, зачем это наверху».
                    // Сам компонент `PlannerProjectChips` оставлен: выбор
                    // никуда не делся, просто попадают в него теперь фильтром.
                    if taskStore.isLoading {
                        TFLoading(.block)
                    }
                    TFErrorBanner(taskStore.errorMessage, variant: .inline)
                        .padding(.horizontal, TFSpacing.lg)

                    if c.filteredEmpty {
                        HStack(spacing: 6) {
                            Text("Под выбранные фильтры ничего не подошло")
                            Button("Сбросить фильтры") { vm.filters = .empty }
                                .foregroundStyle(Color.tfRed)
                                .fontWeight(.medium)
                        }
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                        .padding(.horizontal, TFSpacing.lg)
                        .padding(.top, TFSpacing.sm)
                    }

                    Group {
                        switch vm.layout {
                        case .list:
                            TodayListView(
                                waitingTasks: c.waitingTasks, overdueTasks: c.overdueTasks, todayTasks: c.todayTasks,
                                today: today,
                                onOpen: { route = .taskDetail(taskID: $0.id) },
                                onComplete: { task in Task { await taskStore.patch(taskId: task.id, fields: ["status": .string("completed")]) { _ in } } },
                                onReschedule: { task in rescheduleTask = task; rescheduleOpen = true },
                                onDelete: { task in Task { await taskStore.delete(taskId: task.id) } }
                            )
                            // Без горизонтальных полей: строка задачи идёт во
                            // ВСЮ ширину экрана, как в вебе (там у контейнера
                            // строки `-mx-4`, гасящий поля списка), а отступы
                            // живут внутри самой строки. Поля на списке
                            // превращали строку в узкую полоску.
                        case .board:
                            TodayBoardView(
                                columns: c.boardColumns,
                                onOpenTask: { route = .taskDetail(taskID: $0) },
                                onReschedule: { rescheduleOpen = true },
                                onAddTask: { route = .taskForm(taskID: nil) }
                            )
                            .padding(.top, TFSpacing.sm)
                        case .hours:
                            TodayHoursView(
                                day: c.hourDays[0],
                                projectColor: { task in
                                    guard let id = task.projectId, let project = projectStore.projects.first(where: { $0.id == id }) else {
                                        return Color(hex: "#717171")
                                    }
                                    return Color(hex: project.color ?? "#717171")
                                },
                                onOpenTask: { route = .taskDetail(taskID: $0) },
                                onSchedule: { id, date, time in
                                    Task {
                                        let existing = taskStore.tasks.first(where: { $0.id == id })
                                        var fields: [String: JSONValue] = ["start_time": .string(time), "due_date": .string(date)]
                                        if existing?.durationMin == nil { fields["duration_min"] = .number(15) }
                                        await taskStore.patch(taskId: id, fields: fields) { _ in }
                                    }
                                },
                                onPrevDay: { vm.hourDateOffset -= 1 },
                                onNextDay: { vm.hourDateOffset += 1 }
                            )
                            .padding(.horizontal, TFSpacing.lg)
                            .padding(.top, TFSpacing.sm)
                        }
                    }
                }
            }
            // Нижний край: контент проходит ПОД таб-баром (он лежит в ZStack
            // поверх), поэтому запас должен быть не меньше его высоты, иначе
            // последняя задача остаётся под панелью и её не доскроллить.
            .padding(.bottom, TFTabBarMetrics.heightCompact + TFSpacing.lg)
        }
        // Шапка вынесена ИЗ прокрутки (01.09.2026). Раньше она была первой
        // строкой VStack внутри ScrollView: уезжала вместе со списком, и
        // размывать ей было нечего — отсюда «сплошная плашка» вместо
        // затухания. `safeAreaInset` резервирует под неё место в покое, но
        // при прокрутке содержимое идёт ПОД ней — это и даёт эффект веба.
        // Прогресс схлопывания. В покое `contentOffset.y` РАВЕН минус верхнему
        // инсету, поэтому считаем от суммы — иначе шапка стартует наполовину
        // схлопнутой. Пишем в @State только при заметном изменении: каждый
        // такой кадр перерисовывает весь body вместе с фильтрацией задач.
        .onScrollGeometryChange(for: CGFloat.self) { geo in
            let scrolled = geo.contentOffset.y + geo.contentInsets.top
            return max(0, min(1, scrolled / collapseDistance))
        } action: { _, new in
            if abs(new - collapse) > 0.01 || new == 0 || new == 1 { collapse = new }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            compactBar
        }
        .background(Color.tfBackground)
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(item: $route) { routeDestination($0) }
        .task { await vm.loadAgentsIfNeeded() }
        .tfBottomSheet(isPresented: $filterSheetOpen) {
            TodayFilterSheetContent(
                filters: Binding(get: { vm.filters }, set: { vm.filters = $0 }),
                onClose: { filterSheetOpen = false },
                projectOptions: c.projectOptions,
                labelOptions: c.labelOptions,
                assigneeOptions: c.assigneeOptions,
                allProjects: projectStore.projects,
                visibleProjectIds: vm.visibleProjectIds,
                onTogglePlannerProject: { vm.toggleVisibleProject($0) },
                openPlannerSection: openPlannerSectionOnOpen
            )
        }
        .tfBottomSheet(isPresented: $rescheduleOpen) {
            RescheduleSheetContent(
                taskIds: rescheduleTask.map { [$0.id] } ?? c.overdueTasks.map(\.id),
                taskStore: taskStore,
                onClose: {
                    rescheduleTask = nil
                    rescheduleOpen = false
                }
            )
        }
        // Сбросить rescheduleTask при ЛЮБОМ закрытии шторки (включая свайп вниз,
        // когда onClose не вызывается). Иначе следующее групповое «Перенести
        // просроченные» применится к одной задаче вместо группы.
        .onChange(of: rescheduleOpen) { _, open in
            if !open { rescheduleTask = nil }
        }
        .onChange(of: filterSheetOpen) { _, open in
            if !open { openPlannerSectionOnOpen = false }
        }
    }

    // MARK: - Шапка

    // Родная механика large title: схлопывается не полоса, а САМ заголовок.
    // Полоса всегда 48pt (кнопки + мелкая дата), крупная дата лежит первой
    // строкой ленты и уезжает под полосу вместе со списком. За ней вплотную
    // встаёт прилипший заголовок секции — зазора, через который просвечивала
    // лента, больше нет. Просьба владельца 01.09.2026: «чтобы день недели и
    // число уменьшалось и под динамический островок маленьким вставало».
    private var collapseDistance: CGFloat { 34 }

    private var headerDate: String { vm.layout == .hours ? activeHourDate : today }

    private var largeTitle: some View {
        Text(TodayDate.formatWeekdayDateLabel(headerDate))
            .tfText(.titleLarge)
            .foregroundStyle(Color.tfText)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, TFSpacing.screenHorizontal)
            // 42, а не 56: полоса с кнопками теперь отдельная строка, и при
            // прежней высоте над датой копился воздух — владелец 01.09.2026:
            // «день недели сильно спустился вниз, много пустого места вверху».
            .frame(height: 42)
            .opacity(1 - collapse)
            .accessibilityIdentifier("today.title-large")
    }

    private var compactBar: some View {
        ZStack {
            // «Просто дата» под островком — проявляется ровно на том пути,
            // на котором гаснет крупная.
            Text(TodayDate.formatDuePlain(headerDate))
                .tfText(.title)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
                .opacity(collapse)
                .allowsHitTesting(false)
                .accessibilityIdentifier("today.title-compact")
                // Держим дату в свободной середине: три кнопки справа занимают
                // 3 зоны по 44pt, столько же резервируем слева ради симметрии.
                .padding(.horizontal, 3 * TFHitTarget.min)

            HStack(spacing: TFSpacing.headerActionsGap) {
                Spacer()
                // Отдельной лупы в ряду нет (владелец 01.09.2026: «в трёх
                // точках уже есть поиск, зачем он ещё иконкой в ряду»).
                // Поиск живёт пунктом меню — одно действие, одно место.
                TFIconButton("line.3.horizontal.decrease") { filterSheetOpen = true }
                    .accessibilityLabel("Фильтры")
                    .accessibilityIdentifier("today.filters")
                Menu {
                    Picker("Вид", selection: Binding(get: { vm.layout }, set: { vm.layout = $0 })) {
                        Label("Список", systemImage: "list.bullet").tag(TodayLayout.list)
                        Label("Доска", systemImage: "square.grid.2x2").tag(TodayLayout.board)
                        Label("Один день", systemImage: "calendar").tag(TodayLayout.hours)
                    }
                    .pickerStyle(.inline)
                    Button { route = .search } label: { Label("Поиск", systemImage: "magnifyingglass") }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 18))
                        .foregroundStyle(Color.tfText)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
                .accessibilityLabel("Вид")
                .accessibilityIdentifier("today.view-switcher")
            }
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        // 44 = зона нажатия кнопки, без запаса: полоса несёт только кнопки
        // и мелкую дату.
        .frame(height: 44)
        // Плотная часть подложки накрывает полосу целиком, затухание свисает
        // ниже неё — иначе под датой и кнопками читается лента.
        .background(alignment: .top) {
            TFHeaderBackdrop()
                .padding(.bottom, -26)
                .ignoresSafeArea(edges: .top)
        }
    }
}
