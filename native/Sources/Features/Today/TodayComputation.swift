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

    /// Задачи без project_id (Входящие) — всегда; проектные — только opt-in
    /// (spec §3.10). Исключение: пока пользователь ни разу не открывал этот
    /// выбор, показываем ВСЁ — иначе свежепоставленное приложение встречает
    /// пустым экраном при полном списке задач на сервере.
    var plannerTasks: [ApiTask] {
        guard hasConfiguredVisibleProjects else { return allTasks }
        return allTasks.filter { $0.projectId == nil || visibleProjectIds[$0.projectId!] == true }
    }

    private func partitionOverdueToday(_ tasks: [ApiTask]) -> (overdue: [ApiTask], todayTasks: [ApiTask]) {
        let overdue = tasks
            .filter { ($0.dueDate ?? "") != "" && $0.dueDate! < today }
            .sorted { ($0.dueDate ?? "") < ($1.dueDate ?? "") }
        let todayTasks = tasks.filter { $0.dueDate == today }
        return (overdue, todayTasks)
    }

    private func waitingTasks(from tasks: [ApiTask]) -> [ApiTask] {
        guard currentUser != nil else { return [] }
        return tasks
            .filter { TodayTaskOwner.isWaitingForUser($0, currentUser) }
            .sorted { TodayTaskOwner.waitingSort($0, $1) }
    }

    // MARK: «…All» — до фильтра проект/метка/исполнитель, но уже в рамках plannerTasks.

    var waitingTasksAll: [ApiTask] { waitingTasks(from: plannerTasks) }
    var rawOverdueAll: [ApiTask] { partitionOverdueToday(plannerTasks).overdue }
    var rawTodayAll: [ApiTask] { partitionOverdueToday(plannerTasks).todayTasks }

    // MARK: Отфильтрованные + дедуплицированные — источник правды для рендера и счётчиков.

    var waitingTasks: [ApiTask] { TodayFilterEngine.filter(waitingTasksAll, filters) }
    private var rawOverdueTasks: [ApiTask] { TodayFilterEngine.filter(rawOverdueAll, filters) }
    private var rawTodayTasks: [ApiTask] { TodayFilterEngine.filter(rawTodayAll, filters) }

    private var waitingIds: Set<String> { Set(waitingTasks.map(\.id)) }
    var overdueTasks: [ApiTask] { rawOverdueTasks.filter { !waitingIds.contains($0.id) } }
    var todayTasks: [ApiTask] { rawTodayTasks.filter { !waitingIds.contains($0.id) } }

    // MARK: Опции фильтров — из ПОЛНОГО allTasks, не из plannerTasks (spec §4.3).

    var projectOptions: [TodayFilterOption] { TodayFilterEngine.projectOptions(allTasks) }
    var labelOptions: [TodayFilterOption] { TodayFilterEngine.labelOptions(allTasks) }
    var assigneeOptions: (list: [TodayAssigneeOption], hasUnassigned: Bool) { TodayFilterEngine.assigneeOptions(allTasks) }

    // MARK: trueEmpty/filteredEmpty — от allTasks целиком, независимо от фильтров/видимых проектов.

    private var trueWaitingAll: [ApiTask] { waitingTasks(from: allTasks) }
    private var trueOverdueTodayAll: (overdue: [ApiTask], todayTasks: [ApiTask]) { partitionOverdueToday(allTasks) }

    var trueEmpty: Bool {
        !isLoading && !isError
            && trueWaitingAll.isEmpty
            && trueOverdueTodayAll.overdue.isEmpty
            && trueOverdueTodayAll.todayTasks.isEmpty
    }

    var filteredEmpty: Bool {
        !trueEmpty && !isLoading && !isError
            && overdueTasks.isEmpty && todayTasks.isEmpty && waitingTasks.isEmpty
    }

    // MARK: «Часы» — ровно один день (spec §5.1 «hours»), агентские задачи исключены.

    var hourDays: [TodayHourDay] {
        let withoutAgent: (ApiTask) -> Bool = { !TodayTaskOwner.isAgentAssigned($0, agents) }
        let combined: [ApiTask]
        if activeHourDate == today {
            var seen = Set<String>()
            var merged: [ApiTask] = []
            for t in waitingTasks + todayTasks + overdueTasks where !seen.contains(t.id) {
                seen.insert(t.id)
                merged.append(t)
            }
            combined = merged
        } else {
            combined = plannerTasks.filter { $0.dueDate == activeHourDate }
        }
        return [TodayHourDay(date: activeHourDate, tasks: combined.filter(withoutAgent), isToday: activeHourDate == today)]
    }

    // MARK: Доска — «Ждут вас» / «Просрочено» / «Сегодня», без группировки по проектам (spec §5.1).

    var boardColumns: [TodayBoardColumn] {
        var cols: [TodayBoardColumn] = []
        if !waitingTasks.isEmpty {
            cols.append(TodayBoardColumn(id: .waiting, title: "Ждут вас \(waitingTasks.count)", tasks: waitingTasks, titleIsRed: false))
        }
        if !overdueTasks.isEmpty {
            cols.append(TodayBoardColumn(id: .overdue, title: "Просрочено \(overdueTasks.count)", tasks: overdueTasks, titleIsRed: true))
        }
        cols.append(TodayBoardColumn(id: .today, title: TodayDate.formatColumnDateLabel(today), tasks: todayTasks, titleIsRed: false))
        return cols
    }
}
