import SwiftUI

enum TodayHeaderMetrics {
    /// Высота линии шапки — ровно зона нажатия кнопки, без запаса воздуха.
    static let barHeight: CGFloat = 44
}

private struct TodayHeaderScrollState: Equatable {
    let collapse: CGFloat
    let pullDown: CGFloat
}

// «Сегодня» (`/today`) — spec/SCREENS-1.md §5.1. Имя структуры и параметры
// (никаких) — контракт `spec/INTEGRATION.md`.
struct TodayScreen: View {
    @Environment(TaskStore.self) private var taskStore
    @Environment(ProjectStore.self) private var projectStore
    @Environment(SessionStore.self) private var session

    @State private var vm = TodayViewModel()
    @State private var route: AppRoute?
    @State private var rescheduleOpen = false
    /// Конкретная задача, перенесённая через свайп — открывает RescheduleSheet
    /// именно для неё. Приоритет над `rescheduleOpen` (тот для группы
    /// просроченных с доски).
    @State private var rescheduleTask: ApiTask?
    /// 0…1 — насколько крупная дата уехала под шапку. Меняет ТОЛЬКО
    /// прозрачность двух дат (крупной в ленте и мелкой в шапке): высоты
    /// фиксированы, иначе шапка дрожит на каждом кадре прокрутки.
    @State private var collapse: CGFloat = 0
    /// Положительное смещение при pull-down: вся шапка едет вниз вместе с
    /// лентой. При прокрутке вверх всегда 0 — тогда шапка липнет к верху.
    @State private var headerPullDown: CGFloat = 0
    /// Последняя секция, дошедшая до верхней строки общей шапки.
    @State private var activeSection: TodaySectionMark?

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
        ZStack(alignment: .top) {
            ScrollView {
                VStack(spacing: 0) {
                    // Место под две строки переднего слоя. Сам текст находится
                    // над glow, а этот прозрачный резерв уезжает вместе с
                    // лентой, позволяя задачам заходить под общую шапку.
                    Color.clear.frame(height: expandedHeaderHeight(c: c))
                if c.trueEmpty && vm.layout == .list {
                    TodayEmptyIllustration()
                } else {
                    // Полоска проектов с «плюсом» убрана по просьбе владельца
                    // (01.09.2026): тот же выбор проектов ежедневника уже есть
                    // в шторке фильтров, а сверху списка он только занимал
                    // место — «это всё есть в фильтре, зачем это наверху».
                    // Сам компонент `PlannerProjectChips` оставлен: выбор
                    // никуда не делся, просто попадают в него теперь фильтром.
                    // Спиннер только на первой загрузке: при обновлении уже
                    // показанного списка он вставлялся сверху и сдвигал ленту.
                    if taskStore.isLoading && taskStore.tasks.isEmpty {
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
                .padding(.bottom, TFTabBarMetrics.heightCompact + TFSpacing.lg)
            }
            .coordinateSpace(name: todayScrollSpace)
            .onScrollGeometryChange(for: TodayHeaderScrollState.self) { geo in
                let scrolled = geo.contentOffset.y + geo.contentInsets.top
                return TodayHeaderScrollState(
                    collapse: max(0, min(1, scrolled / collapseDistance)),
                    pullDown: max(0, -scrolled)
                )
            } action: { _, new in
                if abs(new.collapse - collapse) > 0.01 || new.collapse == 0 || new.collapse == 1 {
                    collapse = new.collapse
                }
                if abs(new.pullDown - headerPullDown) > 0.5 || new.pullDown == 0 {
                    headerPullDown = new.pullDown
                }
            }
            .onPreferenceChange(TodaySectionKey.self) { marks in
                let threshold = TodayHeaderMetrics.barHeight
                let passed = marks.filter { $0.minY <= threshold }.max { $0.minY < $1.minY }
                let next = passed.map {
                    TodaySectionMark(title: $0.title, icon: $0.icon, color: $0.color, minY: 0)
                }
                if next?.title != activeSection?.title {
                    withAnimation(.easeOut(duration: 0.16)) { activeSection = next }
                }
            }

            // Порядок принципиален: лента → одна полупрозрачная подложка →
            // чёткие заголовки и кнопки.
            headerFrost
                .frame(height: 148)
                .ignoresSafeArea(edges: .top)
                .offset(y: headerPullDown)

            headerChrome(c: c)
                .offset(y: headerPullDown)
        }
        .background(Color.tfBackground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(item: $route) { routeDestination($0) }
        .task { await vm.loadAgentsIfNeeded() }
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
    }

    // MARK: - Шапка

    // Две строки образуют ОДНУ липкую шапку. При pull-down она получает
    // положительный offset и едет вместе со списком; при прокрутке вверх offset
    // становится нулевым, шапка остаётся наверху и меняет компоновку.
    private var collapseDistance: CGFloat { TodayHeaderMetrics.barHeight }
    private var sectionLineHeight: CGFloat { 34 }

    private var headerDate: String { vm.layout == .hours ? activeHourDate : today }

    private func sectionInfos(c: TodayComputation) -> [TodaySectionInfo] {
        guard vm.layout == .list else { return [] }
        return TodaySectionInfo.list(
            waiting: c.waitingTasks,
            overdue: c.overdueTasks,
            today: c.todayTasks,
            todayDate: today
        )
    }

    private func expandedHeaderHeight(c: TodayComputation) -> CGFloat {
        TodayHeaderMetrics.barHeight + (sectionInfos(c: c).isEmpty ? 0 : sectionLineHeight)
    }

    private func shownSection(c: TodayComputation) -> TodaySectionMark? {
        if let activeSection { return activeSection }
        guard let first = sectionInfos(c: c).first else { return nil }
        return TodaySectionMark(title: first.title, icon: first.icon, color: first.color, minY: 0)
    }

    /// В покое — только день недели. На пути схлопывания он гаснет, а в центре
    /// независимо проявляется полная компактная дата.
    private var leadingTitle: some View {
        Text(TodayDate.formatWeekdayLabel(headerDate))
            .tfText(.titleLarge)
            .foregroundStyle(Color.tfText)
            .lineLimit(1)
            .opacity(1 - collapse)
            .accessibilityIdentifier("today.title-large")
    }

    private func headerChrome(c: TodayComputation) -> some View {
        ZStack(alignment: .topLeading) {
            ZStack {
                Text(TodayDate.formatDayMonthFull(headerDate))
                    .tfText(.title)
                    .foregroundStyle(Color.tfText)
                    .lineLimit(1)
                    .opacity(collapse)
                    .allowsHitTesting(false)
                    .accessibilityIdentifier("today.title-compact")
                    .padding(.horizontal, 3 * TFHitTarget.min)

                HStack(spacing: TFSpacing.headerActionsGap) {
                    leadingTitle
                    Spacer(minLength: TFSpacing.sm)
                    headerActions(c: c)
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .frame(height: TodayHeaderMetrics.barHeight)

            if let section = shownSection(c: c) {
                sectionLabel(section)
                    // 44pt в покое: подпись стоит второй строкой. При
                    // схлопывании она поднимается ровно на место «Вторника».
                    .offset(y: TodayHeaderMetrics.barHeight * (1 - collapse))
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("today.section-current")
            }
        }
        .frame(height: expandedHeaderHeight(c: c), alignment: .top)
        .accessibilityIdentifier("today.header")
    }

    private func sectionLabel(_ section: TodaySectionMark) -> some View {
        HStack(spacing: 6) {
            if let icon = section.icon {
                Image(systemName: icon)
                    .font(.system(size: 16))
                    .foregroundStyle(Color.tfText)
            }
            Text(section.title)
                .tfText(.title)
                .foregroundStyle(section.color)
                .lineLimit(1)
        }
        .padding(.horizontal, TFSpacing.lg)
        .frame(height: sectionLineHeight, alignment: .leading)
    }

    /// Один чёрный полупрозрачный слой между лентой и передним текстом шапки.
    /// Поэтому задачи под ним затухают, а названия и кнопки остаются чёткими.
    private var headerFrost: some View {
        LinearGradient(
            stops: [
                .init(color: Color.tfBackground.opacity(0.96), location: 0.00),
                .init(color: Color.tfBackground.opacity(0.90), location: 0.42),
                .init(color: Color.tfBackground.opacity(0.58), location: 0.68),
                .init(color: Color.tfBackground.opacity(0.18), location: 0.86),
                .init(color: Color.tfBackground.opacity(0.00), location: 1.00),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .allowsHitTesting(false)
    }

    private func headerActions(c: TodayComputation) -> some View {
        HStack(spacing: TFSpacing.headerActionsGap) {
            filterMenu(c: c)
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
                    .font(.system(size: TFIconSize.sm))
                    .foregroundStyle(Color.tfText)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
            }
            .accessibilityLabel("Вид")
            .accessibilityIdentifier("today.view-switcher")
        }
    }

    /// Нативное системное меню — тот же presentation и стеклянный материал,
    /// что у соседнего меню «…». Никаких `.sheet` и кастомной карточки.
    private func filterMenu(c: TodayComputation) -> some View {
        Menu {
            Menu {
                filterOption("Все проекты", selected: vm.filters.projectId == nil) {
                    vm.filters.projectId = nil
                }
                if c.projectOptions.isEmpty {
                    Text("Нет задач с проектом")
                } else {
                    ForEach(c.projectOptions) { option in
                        filterOption(option.label, selected: vm.filters.projectId == option.id) {
                            vm.filters.projectId = option.id
                        }
                    }
                }
            } label: {
                Label("Проект", systemImage: "folder")
            }

            Menu {
                filterOption("Все метки", selected: vm.filters.labelId == nil) {
                    vm.filters.labelId = nil
                }
                if c.labelOptions.isEmpty {
                    Text("Нет задач с метками")
                } else {
                    ForEach(c.labelOptions) { option in
                        filterOption(option.label, selected: vm.filters.labelId == option.id) {
                            vm.filters.labelId = option.id
                        }
                    }
                }
            } label: {
                Label("Метка", systemImage: "tag")
            }

            Menu {
                filterOption("Все исполнители", selected: vm.filters.assigneeKey == nil) {
                    vm.filters.assigneeKey = nil
                }
                if c.assigneeOptions.hasUnassigned {
                    filterOption("Без исполнителя", selected: vm.filters.assigneeKey == "__none") {
                        vm.filters.assigneeKey = "__none"
                    }
                }
                if c.assigneeOptions.list.isEmpty && !c.assigneeOptions.hasUnassigned {
                    Text("Нет данных об исполнителях")
                } else {
                    ForEach(c.assigneeOptions.list) { option in
                        filterOption(option.name, selected: vm.filters.assigneeKey == option.id) {
                            vm.filters.assigneeKey = option.id
                        }
                    }
                }
            } label: {
                Label("Исполнитель", systemImage: "person")
            }

            Divider()

            Toggle(isOn: Binding(
                get: { vm.filters.showCompleted },
                set: { vm.filters.showCompleted = $0 }
            )) {
                Label("Показывать выполненные", systemImage: "checkmark.circle")
            }

            Menu {
                if projectStore.projects.isEmpty {
                    Text("Нет проектов")
                } else {
                    ForEach(projectStore.projects) { project in
                        filterOption(
                            project.name,
                            selected: vm.visibleProjectIds[project.id] == true
                        ) {
                            vm.toggleVisibleProject(project.id)
                        }
                    }
                }
            } label: {
                Label("Показывать в разделе", systemImage: "eye")
            }

            if vm.filters.isActive {
                Divider()
                Button(role: .destructive) { vm.filters = .empty } label: {
                    Label("Сбросить фильтры", systemImage: "arrow.counterclockwise")
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .font(.system(size: TFIconSize.sm))
                .foregroundStyle(vm.filters.isActive ? Color.tfRed : Color.tfText)
                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
        }
        .accessibilityLabel("Фильтры")
        .accessibilityIdentifier("today.filters")
    }

    private func filterOption(
        _ title: String,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            if selected {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }
}
