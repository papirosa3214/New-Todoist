import SwiftUI

// Обёртка для использования String в .sheet(item:) — стандартный String не Identifiable.
private struct IdentifiableDate: Identifiable, Equatable {
    let id: String
}

// Экран «Планирование» (`/upcoming`) — spec/SCREENS-1.md §5.2. Имя структуры
// и параметры инициализации фиксированы контрактом (spec/INTEGRATION.md):
// `UpcomingScreen`, без параметров.
public struct UpcomingScreen: View {
    @Environment(TaskStore.self) private var taskStore
    @Environment(ProjectStore.self) private var projectStore

    @State private var agentsProvider = UpcomingAgentsProvider()

    enum ViewMode: String { case list, week, month, hours }

    /// `upcomingLayout` (spec §4.4) — persist между запусками, дефолт «месяц»
    /// (тот же вид, что на эталонном скриншоте `spec/screenshots/upcoming.png`).
    @AppStorage("upcomingLayout") private var upcomingLayoutRaw = ViewMode.month.rawValue
    private var view: ViewMode {
        get { ViewMode(rawValue: upcomingLayoutRaw) ?? .month }
        nonmutating set { upcomingLayoutRaw = newValue.rawValue }
    }

    @State private var filters = UpcomingTaskFilters.empty
    @State private var filterSheetOpen = false
    @State private var filterSheetOpenPlanner = false
    @State private var actionsMenuOpen = false
    @State private var selectedDate: String?
    @State private var openDay: String?
    @State private var pushedTaskID: String?
    @State private var editingTaskID: String?
    @State private var rescheduleTask: ApiTask?
    @State private var rescheduleOpen = false

    @State private var gridMonday = UpcomingDate.mondayOf(UpcomingDate.todayString())
    /// Опциональный: до первого появления экрана и до прихода первого
    /// `onVisibleMonthChange` — пусто. Без этого View запоминал бы месяц
    /// на момент своей инициализации (запуск в августе → в сентябре всё
    /// ещё показывает август).
    @State private var gridMonth: (year: Int, month: Int)? = nil
    private let monthGridInitialMonday = UpcomingDate.mondayOf(UpcomingDate.todayString())

    /// Зеркало `store/index.ts` `plannerVisibleProjects` — общая точка со
    /// «Сегодня» (спека §4.4: тот же ключ, opt-in список видимых в
    /// ежедневнике проектов). Ключ ЛИТЕРАЛЬНЫЙ — как `taskflow_today_badge_seen_date`
    /// у `RootShellView` — так автор «Сегодня» может завести тот же ключ и
    /// оба экрана честно разделят состояние без общего Core-стора.
    @State private var plannerVisibleProjectIds: Set<String> = Set(
        UserDefaults.standard.stringArray(forKey: "plannerVisibleProjects") ?? []
    )

    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            TFScreenHeader("Планирование", variant: .large, actions: headerActions, below: belowContent)

            if let banner = emptyFilterBanner {
                banner
            }

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !plannerVisibleProjectIds.isEmpty {
                UpcomingPlannerProjectChips(
                    projects: projectStore.projects, visibleProjectIds: plannerVisibleProjectIds,
                    onAdd: { filterSheetOpenPlanner = true; filterSheetOpen = true }
                )
            }
        }
        // Своя шапка уже несёт заголовок и кнопку «назад» — системный навбар
        // поверх неё давал ВТОРУЮ стрелку и лишнюю полосу.
        // Нативная сворачивающаяся шапка по официальным гайдам SwiftUI.
        .navigationTitle("Планирование")
        .navigationBarTitleDisplayMode(.large)
        .background(Color.tfBackground)
        .confirmationDialog("Вид", isPresented: $actionsMenuOpen, titleVisibility: .visible) {
            // ⚠️ Замена `ActionsMenu` (плоский попап, спека §5.2) на системный
            // `confirmationDialog` — тот же приём, что `TaskFlowApp`/`RootShellView`
            // уже применили для `CreateMenu`; текущий вид отмечен галочкой
            // в тексте пункта вместо красного полужирного (spec-требование
            // «текущий вид — красным полужирным» тут не воспроизведено дословно).
            viewModeButton(.list, "Список")
            viewModeButton(.week, "Неделя")
            viewModeButton(.month, "Месяц")
            viewModeButton(.hours, "Три дня")
            Button("Отмена", role: .cancel) {}
        }
        .sheet(item: Binding(get: { openDay.map(IdentifiableDate.init) }, set: { _ in openDay = nil })) { day in
            daySheet(date: day.id)
        }
        .sheet(isPresented: $filterSheetOpen) { filterSheet }
        .sheet(item: $rescheduleTask) { task in rescheduleSheet(task: task) }
        .navigationDestination(isPresented: Binding(
            get: { pushedTaskID != nil }, set: { if !$0 { pushedTaskID = nil } }
        )) {
            if let id = pushedTaskID { routeDestination(.taskDetail(taskID: id)) }
        }
        .navigationDestination(isPresented: Binding(
            get: { editingTaskID != nil }, set: { if !$0 { editingTaskID = nil } }
        )) {
            if let id = editingTaskID { routeDestination(.taskForm(taskID: id)) }
        }
        .task { await agentsProvider.load() }
        .onAppear {
            // Сбрасываем заголовок на месяц «сегодня» каждый раз при появлении
            // экрана (а не только при первом создании View — иначе View,
            // созданный в августе, остаётся с августом и в сентябре).
            gridMonth = UpcomingDate.yearMonth(UpcomingDate.todayString())
        }
    }

    @ViewBuilder
    private var content: some View {
        if taskStore.isLoading {
            TFLoading(.block)
        } else if let error = taskStore.errorMessage {
            TFErrorBanner(error, variant: .block).padding(.horizontal, TFSpacing.screenHorizontal)
        } else {
            switch view {
            case .list:
                UpcomingListView(
                    tasks: tasks, selectedDate: $selectedDate,
                    onTaskTap: { pushedTaskID = $0 },
                    onEditTask: { editingTaskID = $0 },
                    onDeleteTask: { deleteTask($0) },
                    onRescheduleTask: { task in rescheduleTask = task; rescheduleOpen = true }
                )
            case .week:
                UpcomingWeekView(
                    monday: gridMonday, byDate: byDate,
                    onTaskTap: { pushedTaskID = $0 },
                    onDayTap: { openDay = $0 },
                    onPickDate: { gridMonday = UpcomingDate.mondayOf($0) },
                    onPrevWeek: { gridMonday = UpcomingDate.addDays(gridMonday, -7) },
                    onNextWeek: { gridMonday = UpcomingDate.addDays(gridMonday, 7) }
                )
            case .month:
                UpcomingMonthView(
                    initialMonday: monthGridInitialMonday,
                    initialMonth: UpcomingDate.yearMonth(UpcomingDate.todayString()),
                    byDate: byDate, openDay: openDay,
                    onDayTap: { d in openDay = openDay == d ? nil : d },
                    onTaskTap: { pushedTaskID = $0 },
                    onVisibleMonthChange: { y, m in gridMonth = (y, m) }
                )
            case .hours:
                UpcomingHoursView(
                    days: hourDays,
                    projectColor: { task in
                        Color(hex: projectStore.projects.first { $0.id == task.projectId }?.color ?? "#717171")
                    },
                    onTaskTap: { pushedTaskID = $0 },
                    onSchedule: { id, date, time in schedule(id: id, date: date, time: time) }
                )
            }
        }
    }

    @ViewBuilder
    private func daySheet(date openDay: String) -> some View {
        TFBottomSheetContent(
            title: UpcomingDaySheetTitle.text(openDay), actionTitle: "Готово",
            action: { self.openDay = nil }, onClose: { self.openDay = nil }
        ) {
            UpcomingDaySheetContent(
                date: openDay, tasks: byDate[openDay] ?? [],
                onTaskTap: { self.openDay = nil; pushedTaskID = $0 },
                onPrevDay: { self.openDay = UpcomingDate.addDays(openDay, -1) },
                onNextDay: { self.openDay = UpcomingDate.addDays(openDay, 1) }
            )
        }
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(TFRadius.sheet)
        .presentationBackground(Color.tfCard)
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func rescheduleSheet(task: ApiTask) -> some View {
        RescheduleSheetContent(
            taskIds: [task.id],
            taskStore: taskStore,
            onClose: {
                rescheduleTask = nil
                rescheduleOpen = false
            }
        )
    }

    private var filterSheet: some View {
        TFBottomSheetContent(onClose: { filterSheetOpen = false }) {
            UpcomingFilterSheetContent(
                filters: $filters,
                projectOptions: UpcomingFilterEngine.projectOptions(optionDatedTasks),
                labelOptions: UpcomingFilterEngine.labelOptions(optionDatedTasks),
                assigneeOptions: UpcomingFilterEngine.assigneeOptions(optionDatedTasks),
                planner: UpcomingPlannerProjectsConfig(
                    projects: projectStore.projects, visibleProjectIds: plannerVisibleProjectIds,
                    onToggle: togglePlannerVisibleProject
                ),
                openPlannerOnAppear: filterSheetOpenPlanner,
                onClose: { filterSheetOpen = false }
            )
        }
        .presentationDragIndicator(.hidden)
        .presentationCornerRadius(TFRadius.sheet)
        .presentationBackground(Color.tfCard)
        .onDisappear { filterSheetOpenPlanner = false }
    }

    private func viewModeButton(_ mode: ViewMode, _ title: String) -> some View {
        Button(view == mode ? "\(title) ✓" : title) { view = mode }
    }

    private var openDaySheetBinding: Binding<Bool> {
        Binding(get: { openDay != nil && view == .week }, set: { if !$0 { openDay = nil } })
    }

    // MARK: - Данные

    private var today: String { UpcomingDate.todayString() }

    /// Агентские задачи сюда не попадают вовсе, и только due_date ≥ сегодня —
    /// «Планирование» никогда не показывает просроченное (спека §5.2).
    private var datedTasks: [ApiTask] {
        taskStore.tasks.filter { t in
            !UpcomingFilterEngine.isAgentAssigned(t, agentsProvider.agents)
                && t.dueDate != nil && t.dueDate! >= today
                && (t.projectId == nil || plannerVisibleProjectIds.contains(t.projectId!))
        }
    }

    /// Тот же «раздел», но БЕЗ сужения по видимым проектам — источник опций
    /// фильтра «Проект» (спека §4.3: опции должны показывать что МОЖНО
    /// добавить, а не что уже добавлено).
    private var optionDatedTasks: [ApiTask] {
        taskStore.tasks.filter { t in
            !UpcomingFilterEngine.isAgentAssigned(t, agentsProvider.agents) && t.dueDate != nil && t.dueDate! >= today
        }
    }

    private var tasks: [ApiTask] { UpcomingFilterEngine.filter(datedTasks, filters) }
    private var byDate: [String: [ApiTask]] { UpcomingDate.groupByDate(tasks) }

    private var hourDays: [UpcomingHourColumn] {
        (0..<3).map { i in
            let date = UpcomingDate.addDays(today, i)
            return UpcomingHourColumn(date: date, tasks: byDate[date] ?? [], isToday: date == today)
        }
    }

    /// Состояния общие для всех 4 видов (спека §5.2: рендерятся один раз, до
    /// ветвления по `view`) — здесь только тот случай, что не покрыт
    /// загрузкой/ошибкой: фильтры вычистили список подчистую.
    private var emptyFilterBanner: AnyView? {
        guard selectedDate == nil, !taskStore.isLoading, taskStore.errorMessage == nil,
              !datedTasks.isEmpty, tasks.isEmpty else { return nil }
        return AnyView(
            HStack(spacing: 6) {
                Text("Под выбранные фильтры ничего не подошло").tfText(.action).foregroundStyle(Color.tfDim)
                Button("Сбросить фильтры") { filters = .empty }
                    .font(.system(size: 13, weight: .medium)).foregroundStyle(Color.tfRed)
            }
            .padding(.horizontal, TFSpacing.screenHorizontal).padding(.vertical, TFSpacing.sm)
        )
    }

    private var headerActions: [TFHeaderAction] {
        [
            TFHeaderAction(icon: "line.3.horizontal.decrease") { filterSheetOpen = true },
            TFHeaderAction(icon: "ellipsis") { actionsMenuOpen = true },
        ]
    }

    @ViewBuilder
    private var belowContentView: some View {
        switch view {
        case .week:
            let (year, month) = UpcomingDate.weekMonth(monday: gridMonday)
            Text("\(UpcomingDate.monthsNom[month]) \(year)")
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.tfText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, TFSpacing.screenHorizontal).padding(.bottom, 6)
        case .month:
            let m = gridMonth ?? UpcomingDate.yearMonth(UpcomingDate.todayString())
            Text(UpcomingDate.monthsNom[m.month])
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.tfText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, TFSpacing.screenHorizontal).padding(.bottom, 6)
        case .hours:
            UpcomingDayColumnsHeader(days: hourDays)
        case .list:
            EmptyView()
        }
    }

    private func belowContent() -> AnyView { AnyView(belowContentView) }

    // MARK: - Действия

    private func deleteTask(_ id: String) {
        Task { await taskStore.delete(taskId: id) }
    }

    private func schedule(id: String, date: String, time: String) {
        let hadDuration = taskStore.tasks.first { $0.id == id }?.durationMin != nil
        var fields: [String: JSONValue] = ["due_date": .string(date), "start_time": .string(time)]
        // duration_min шлётся ТОЛЬКО когда его раньше не было — иначе PATCH
        // затёр бы уже заданную длительность (спека §3.5: 15 минут только
        // «если раньше не было»; отсутствие ключа ≠ .null в JSONValue-контракте PATCH).
        if !hadDuration { fields["duration_min"] = 15 }
        Task {
            // apply-замыкание TaskStore.patch не может частично обновить
            // локальную копию: поля `ApiTask` — `let` (структура собирается
            // только через `Decodable.init`, без memberwise-инициализатора),
            // править их точечно нельзя без правки Core. Оставляю пустым —
            // UI обновится по факту ответа сервера (небольшая задержка вместо
            // истинно оптимистичного отклика), см. отчёт.
            await taskStore.patch(taskId: id, fields: fields) { _ in }
        }
    }

    private func togglePlannerVisibleProject(_ id: String) {
        if plannerVisibleProjectIds.contains(id) {
            plannerVisibleProjectIds.remove(id)
        } else {
            plannerVisibleProjectIds.insert(id)
        }
        UserDefaults.standard.set(Array(plannerVisibleProjectIds), forKey: "plannerVisibleProjects")
    }
}

/// Заголовок `DaySheet` — «20 августа», отдельно от общей `UpcomingDate`,
/// т.к. нужен только шапке шторки (сама шторка использует общий `TFBottomSheetContent`).
enum UpcomingDaySheetTitle {
    static func text(_ date: String) -> String {
        let (_, month) = UpcomingDate.yearMonth(date)
        return "\(UpcomingDate.day(date)) \(UpcomingDate.monthsGen[month])"
    }
}
