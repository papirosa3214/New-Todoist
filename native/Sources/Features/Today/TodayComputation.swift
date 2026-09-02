import Foundation

/// Один день сетки «часы» — spec §3.5 `DayColumnData`. «Сегодня» всегда
/// одна колонка (3-дневный вид переехал в «Планирование» 20.08.2026, см.
/// комментарий в живом TodayScreen.tsx) — тип остался с массивом задач для
/// параллельности с сеткой, но `TodayComputation.hourDays` всегда отдаёт
/// ровно один элемент.
struct TodayHourDay {
    let date: String
    let tasks: [ApiTask]
    let isToday: Bool
}

struct TodayBoardColumn: Identifiable {
    enum Kind { case waiting, overdue, today }
    let id: Kind
    let title: String
    let tasks: [ApiTask]
    let titleIsRed: Bool
}

/// Портирует useMemo-цепочку `TodayScreen.tsx` 1:1 (дедуп «Ждут вас» →
/// «Просрочено» → «Сегодня», разделение «искренних»/«отфильтрованных»
/// пустых множеств) — см. комментарии там же для обоснования порядка.
struct TodayComputation {
    let allTasks: [ApiTask]
    let currentUser: ApiUser?
    let agents: [ApiUser]
    let filters: TodayTaskFilters
    let visibleProjectIds: [String: Bool]
    /// Выбор проектов ежедневника уже настраивали руками? См. `plannerTasks`.
    let hasConfiguredVisibleProjects: Bool
    let today: String
    let activeHourDate: String
    let isLoading: Bool
    let isError: Bool

    // Результаты цепочки вычисляются один раз при создании снимка экрана.
    // Раньше это были computed properties: один проход `TodayScreen.body`
    // обращался к одним и тем же filter/sort до десятка раз, а состояние
    // липкой шапки обновляет body во время прокрутки. На длинной ленте именно
    // эта повторная работа на main thread ощущалась как микрорывки.
    let plannerTasks: [ApiTask]
    let waitingTasksAll: [ApiTask]
    let rawOverdueAll: [ApiTask]
    let rawTodayAll: [ApiTask]
    let waitingTasks: [ApiTask]
    let overdueTasks: [ApiTask]
    let todayTasks: [ApiTask]
    let projectOptions: [TodayFilterOption]
    let labelOptions: [TodayFilterOption]
    let assigneeOptions: (list: [TodayAssigneeOption], hasUnassigned: Bool)
    let trueEmpty: Bool
    let filteredEmpty: Bool
    let hourDays: [TodayHourDay]
    let boardColumns: [TodayBoardColumn]

    init(
        allTasks: [ApiTask], currentUser: ApiUser?, agents: [ApiUser],
        filters: TodayTaskFilters, visibleProjectIds: [String: Bool],
        hasConfiguredVisibleProjects: Bool, today: String,
        activeHourDate: String, isLoading: Bool, isError: Bool
    ) {
        self.allTasks = allTasks
        self.currentUser = currentUser
        self.agents = agents
        self.filters = filters
        self.visibleProjectIds = visibleProjectIds
        self.hasConfiguredVisibleProjects = hasConfiguredVisibleProjects
        self.today = today
        self.activeHourDate = activeHourDate
        self.isLoading = isLoading
        self.isError = isError

        let planner = hasConfiguredVisibleProjects
            ? allTasks.filter { task in
                guard let projectID = task.projectId else { return true }
                return visibleProjectIds[projectID] == true
            }
            : allTasks
        plannerTasks = planner

        let plannerPartition = Self.partitionOverdueToday(planner, today: today)
        let waitingAll = Self.waitingTasks(from: planner, currentUser: currentUser)
        waitingTasksAll = waitingAll
        rawOverdueAll = plannerPartition.overdue
        rawTodayAll = plannerPartition.todayTasks

        let filteredWaiting = TodayFilterEngine.filter(waitingAll, filters)
        let filteredOverdue = TodayFilterEngine.filter(plannerPartition.overdue, filters)
        let filteredToday = TodayFilterEngine.filter(plannerPartition.todayTasks, filters)
        let waitingIDs = Set(filteredWaiting.map(\.id))
        waitingTasks = filteredWaiting
        overdueTasks = filteredOverdue.filter { !waitingIDs.contains($0.id) }
        todayTasks = filteredToday.filter { !waitingIDs.contains($0.id) }

        projectOptions = TodayFilterEngine.projectOptions(allTasks)
        labelOptions = TodayFilterEngine.labelOptions(allTasks)
        assigneeOptions = TodayFilterEngine.assigneeOptions(allTasks)

        let trueWaiting = hasConfiguredVisibleProjects
            ? Self.waitingTasks(from: allTasks, currentUser: currentUser)
            : waitingAll
        let truePartition = hasConfiguredVisibleProjects
            ? Self.partitionOverdueToday(allTasks, today: today)
            : plannerPartition
        let isTrulyEmpty = !isLoading && !isError
            && trueWaiting.isEmpty
            && truePartition.overdue.isEmpty
            && truePartition.todayTasks.isEmpty
        trueEmpty = isTrulyEmpty
        filteredEmpty = !isTrulyEmpty && !isLoading && !isError
            && overdueTasks.isEmpty && todayTasks.isEmpty && waitingTasks.isEmpty

        let combined: [ApiTask]
        if activeHourDate == today {
            var seen = Set<String>()
            combined = (filteredWaiting + todayTasks + overdueTasks).filter { seen.insert($0.id).inserted }
        } else {
            combined = planner.filter { $0.dueDate == activeHourDate }
        }
        hourDays = [TodayHourDay(
            date: activeHourDate,
            tasks: combined.filter { !TodayTaskOwner.isAgentAssigned($0, agents) },
            isToday: activeHourDate == today
        )]

        var columns: [TodayBoardColumn] = []
        if !filteredWaiting.isEmpty {
            columns.append(.init(id: .waiting, title: "Ждут вас \(filteredWaiting.count)", tasks: filteredWaiting, titleIsRed: false))
        }
        if !overdueTasks.isEmpty {
            columns.append(.init(id: .overdue, title: "Просрочено \(overdueTasks.count)", tasks: overdueTasks, titleIsRed: true))
        }
        columns.append(.init(id: .today, title: TodayDate.formatColumnDateLabel(today), tasks: todayTasks, titleIsRed: false))
        boardColumns = columns
    }

    /// Задачи без project_id (Входящие) — всегда; проектные — только opt-in
    /// (spec §3.10). Исключение: пока пользователь ни разу не открывал этот
    /// выбор, показываем ВСЁ — иначе свежепоставленное приложение встречает
    /// пустым экраном при полном списке задач на сервере.
    private static func partitionOverdueToday(_ tasks: [ApiTask], today: String) -> (overdue: [ApiTask], todayTasks: [ApiTask]) {
        let overdue = tasks
            .filter { ($0.dueDate ?? "") != "" && $0.dueDate! < today }
            .sorted { ($0.dueDate ?? "") < ($1.dueDate ?? "") }
        let todayTasks = tasks.filter { $0.dueDate == today }
        return (overdue, todayTasks)
    }

    private static func waitingTasks(from tasks: [ApiTask], currentUser: ApiUser?) -> [ApiTask] {
        guard currentUser != nil else { return [] }
        return tasks
            .filter { TodayTaskOwner.isWaitingForUser($0, currentUser) }
            .sorted { TodayTaskOwner.waitingSort($0, $1) }
    }

}
