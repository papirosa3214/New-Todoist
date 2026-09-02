import SwiftUI

// «Лента дня» (`/timeline`) — НЕ описана ни в SCREENS-1.md, ни в SCREENS-2.md
// буквально (SCREENS-1 §1.1 прямо помечает `/timeline → TodayScreenTimeline`
// как «не входит в эту часть спеки»). Источник истины здесь —
// `src/screens/TodayScreenTimeline.tsx` (живой веб-код, экспериментальный
// «Time-Thread UI», этап2/POC) + эталонный кадр `spec/screenshots/timeline.png`,
// с которым код сверен построчно. Портирован буквально, включая
// экспериментальные пометки исходника («Назад (демо)», POC-упрощения слоя
// «Месяц») — это не моя отсебятина, а то, что реально показывает веб сегодня.
//
// Имя структуры и отсутствие параметров — контракт `spec/INTEGRATION.md`.
struct TimelineScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(TaskStore.self) private var taskStore

    @State private var agents: [ApiUser] = []
    @State private var zoom = 0
    @State private var route: AppRoute?
    private let apiClient = APIClient()

    private static let zoomLabels = ["ФОКУС ДНЯ", "ОБЗОР НЕДЕЛИ", "СЕТКА МЕСЯЦА"]
    private var today: String { TodayDate.todayString() }

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.tfBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                ZStack(alignment: .topLeading) {
                    layer(index: 0) { TimelineDayLayer(tasks: todayTasks, isLoading: taskStore.isLoading, onOpen: openTask) }
                    layer(index: 1) { TimelineWeekLayer(days: weekDays, today: today) }
                    layer(index: 2) { TimelineMonthLayer(tasksByDay: monthTasksByDay, today: today, onOpen: openTask) }
                }
                .padding(.top, TFSpacing.xl)
                .padding(.horizontal, TFSpacing.xl)
            }

            VStack(spacing: TFSpacing.md) {
                Text("СВАЙП ВЛЕВО/ВПРАВО")
                    .tfText(.micro)
                    .tracking(1.5)
                    .foregroundStyle(Color(hex: "#525252"))
                HStack(spacing: TFSpacing.sm) {
                    ForEach(0..<3, id: \.self) { i in
                        Circle()
                            .fill(i == zoom ? Color.tfText : Color(hex: "#404040"))
                            .frame(width: 6, height: 6)
                    }
                }
            }
            .padding(.bottom, TFSpacing.xl + TFSpacing.md)
        }
        .toolbar(.hidden, for: .navigationBar)
        .gesture(swipeGesture)
        .navigationDestination(item: $route) { routeDestination($0) }
        .task {
            agents = (try? await apiClient.agents()) ?? []
            await taskStore.load()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(Self.zoomLabels[zoom])
                .tfText(.action)
                .tracking(2)
                .foregroundStyle(Color.tfDim)
                .id(zoom) // фейд при смене подписи, как key={zoom} в вебе
                .transition(.opacity)
                .animation(.easeInOut(duration: 0.2), value: zoom)
            Text(TodayDate.formatDueLabel(today))
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(Color.tfText)
            Button(action: { dismiss() }) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.down").font(.system(size: 12)).rotationEffect(.degrees(90))
                    Text("Назад (демо)")
                }
                .font(.system(size: 12))
                .foregroundStyle(Color.tfSub)
            }
            .padding(.top, TFSpacing.sm)
        }
        .padding(.horizontal, TFSpacing.xl)
        .padding(.top, TFSpacing.xl)
        .padding(.bottom, TFSpacing.md)
    }

    @ViewBuilder
    private func layer(index: Int, @ViewBuilder content: () -> some View) -> some View {
        let active = zoom == index
        content()
            .scaleEffect(active ? 1 : 0.95)
            .opacity(active ? 1 : 0)
            .blur(radius: active ? 0 : 4)
            .allowsHitTesting(active)
            .animation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.6), value: zoom)
    }

    /// Тап по задаче — тот же переход, что `useOpenTask()` в вебе: карточка задачи.
    private func openTask(_ id: String) {
        route = .taskDetail(taskID: id)
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onEnded { value in
                let dx = value.translation.width
                guard abs(dx) >= 50 else { return }
                if dx > 0, zoom < 2 { zoom += 1 }
                else if dx < 0, zoom > 0 { zoom -= 1 }
            }
    }

    // MARK: - Данные слоёв (порт useMemo из TodayScreenTimeline.tsx)

    private var todayTasks: [ApiTask] {
        taskStore.tasks
            .filter { $0.dueDate != nil && $0.status != .completed && $0.dueDate!.hasPrefix(today) }
            .filter { !TodayTaskOwner.isAgentAssigned($0, agents) }
            .sorted(by: timelineSort)
    }

    private var weekDays: [TimelineDay] {
        (-3...3).map { offset in
            let date = TodayDate.addDays(today, offset)
            let label = offset == 0 ? "Сегодня" : TodayDate.formatDuePlain(date)
            let tasks = taskStore.tasks
                .filter { $0.dueDate != nil && $0.status != .completed && $0.dueDate!.hasPrefix(date) }
                .filter { !TodayTaskOwner.isAgentAssigned($0, agents) }
                .sorted(by: timelineSort)
            return TimelineDay(date: date, label: label, tasks: tasks)
        }
    }

    private var monthTasksByDay: [Int: [ApiTask]] {
        guard let todayDate = TodayDate.calendarDate(today) else { return [:] }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let year = cal.component(.year, from: todayDate)
        let month = cal.component(.month, from: todayDate)
        var map: [Int: [ApiTask]] = [:]
        for t in taskStore.tasks {
            guard let due = t.dueDate, t.status != .completed, !TodayTaskOwner.isAgentAssigned(t, agents) else { continue }
            let parts = due.prefix(10).split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3, parts[0] == year, parts[1] == month else { continue }
            map[parts[2], default: []].append(t)
        }
        return map
    }

    private func timelineSort(_ a: ApiTask, _ b: ApiTask) -> Bool {
        let ta = a.startTime ?? ""
        let tb = b.startTime ?? ""
        if ta.isEmpty && tb.isEmpty { return (a.position ?? 0) < (b.position ?? 0) }
        if ta.isEmpty { return false }
        if tb.isEmpty { return true }
        return ta < tb
    }
}

struct TimelineDay {
    let date: String
    let label: String
    let tasks: [ApiTask]
}

func timelinePriorityColor(_ priority: Int) -> Color {
    switch priority {
    case 1: return .tfRed
    case 2: return .tfOrange
    case 3: return .tfBlue
    default: return .white
    }
}
