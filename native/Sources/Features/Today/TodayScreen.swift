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
                header(c: c)

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
                                onReschedule: { _ in /* TODO: открыть RescheduleSheet для одной задачи */ },
                                onDelete: { task in Task { await taskStore.delete(taskId: task.id) } }
                            )
                            .padding(.horizontal, TFSpacing.lg)
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
            .padding(.bottom, TFSpacing.xl)
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
            RescheduleSheetContent(taskIds: c.overdueTasks.map(\.id), taskStore: taskStore, onClose: { rescheduleOpen = false })
        }
        .onChange(of: filterSheetOpen) { _, open in
            if !open { openPlannerSectionOnOpen = false }
        }
    }

    // MARK: - Шапка

    @ViewBuilder
    private func header(c: TodayComputation) -> some View {
        let title = vm.layout == .hours ? TodayDate.formatWeekdayDateLabel(activeHourDate) : TodayDate.formatWeekdayDateLabel(today)
        TFScreenHeader(title, variant: .large)
            .overlay(alignment: .trailing) {
                HStack(spacing: TFSpacing.headerActionsGap) {
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
                .padding(.horizontal, TFSpacing.screenHorizontal)
            }
    }
}
