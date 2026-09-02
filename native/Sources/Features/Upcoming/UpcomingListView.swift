import SwiftUI

// Вид «Список» — spec/SCREENS-1.md §5.2 + живой `UpcomingScreen.tsx`.
// Лента-выборщик даты (месяц/полоса недели) сверху + список задач по дням
// со sticky-заголовками.
//
// ⚠️ Упрощение против веба (см. отчёт): переключение месяц↔неделя там —
// вертикальный свайп «за краюшек» с измеренной CSS-анимацией высоты
// (`calDragStart`/`changeMode`, `CAL_DRAG_THRESHOLD=48`) — DOM-специфичный
// приём, у которого нет прямого SwiftUI-аналога тем же путём. Здесь —
// тап по названию месяца/полосе (шеврон разворота) со `withAnimation`,
// поведение то же (месяц ⇄ неделя), жест другой.
private let swipeStripPx: CGFloat = 45 // порог свайпа полосы недели (спека §5.2)

struct UpcomingListView: View {
    let tasks: [ApiTask]
    @Binding var selectedDate: String?
    let onTaskTap: (String) -> Void
    let onEditTask: (String) -> Void
    let onDeleteTask: (String) -> Void
    let onRescheduleTask: (ApiTask) -> Void

    @State private var calMode: CalMode = .month
    @State private var pickerYear: Int
    @State private var pickerMonth: Int
    @State private var activeWeekMonday: String

    private enum CalMode { case month, week }

    init(
        tasks: [ApiTask], selectedDate: Binding<String?>,
        onTaskTap: @escaping (String) -> Void, onEditTask: @escaping (String) -> Void, onDeleteTask: @escaping (String) -> Void, onRescheduleTask: @escaping (ApiTask) -> Void
    ) {
        self.tasks = tasks
        self._selectedDate = selectedDate
        self.onTaskTap = onTaskTap
        self.onEditTask = onEditTask
        self.onDeleteTask = onDeleteTask
        self.onRescheduleTask = onRescheduleTask
        let today = UpcomingDate.todayString()
        let (y, m) = UpcomingDate.yearMonth(today)
        _pickerYear = State(initialValue: y)
        _pickerMonth = State(initialValue: m)
        _activeWeekMonday = State(initialValue: UpcomingDate.mondayOf(today))
    }

    private var groupedTasks: [String: [ApiTask]] {
        UpcomingDate.groupByDate(tasks)
    }

    /// `visibleDates` (spec): выбранная дата — только она; иначе непрерывная
    /// лента 365 дней вперёд от сегодня + любые задачи дальше этого окна.
    private var visibleDates: [String] {
        if let selectedDate { return [selectedDate] }
        var set = Set<String>()
        let today = UpcomingDate.todayString()
        for i in 0..<365 { set.insert(UpcomingDate.addDays(today, i)) }
        set.formUnion(groupedTasks.keys)
        return set.sorted()
    }

    var body: some View {
        VStack(spacing: 0) {
            calendarStrip
            if let selectedDate {
                selectedPill(selectedDate)
            }
            list
        }
    }

    // MARK: - Лента-выборщик

    private var calendarStrip: some View {
        VStack(spacing: 0) {
            HStack {
                Button {
                    withAnimation(.easeInOut(duration: TFDuration.slow)) {
                        calMode = calMode == .month ? .week : .month
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("\(UpcomingDate.monthsAbbrDot[pickerMonth]) \(pickerYear) г.")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Color.tfRed)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Color.tfRed)
                            .rotationEffect(.degrees(calMode == .week ? 180 : 0))
                    }
                }
                .buttonStyle(.plain)
                Spacer()
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.top, TFSpacing.xs)

            if calMode == .month {
                monthGrid
            } else {
                weekStrip
            }
        }
        .animation(.easeInOut(duration: TFDuration.slow), value: calMode)
    }

    private var monthGrid: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(UpcomingDate.weekdaysUpper, id: \.self) { w in
                    Text(w).font(.system(size: 11)).foregroundStyle(Color.tfSub).frame(maxWidth: .infinity)
                }
            }
            let days = UpcomingDate.monthGridDates(year: pickerYear, month: pickerMonth)
            let rows = stride(from: 0, to: days.count, by: 7).map { Array(days[$0..<min($0 + 7, days.count)]) }
            ForEach(Array(rows.enumerated()), id: \.offset) { _, week in
                HStack(spacing: 0) {
                    ForEach(week, id: \.self) { ds in
                        bigDayCell(ds)
                    }
                }
            }
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
    }

    private func bigDayCell(_ ds: String) -> some View {
        let today = UpcomingDate.todayString()
        let isToday = ds == today
        let isSelected = ds == selectedDate
        let filled = isSelected || isToday
        let (_, month) = UpcomingDate.yearMonth(ds)
        let dim = month != pickerMonth
        let hasTasks = !(groupedTasks[ds] ?? []).isEmpty
        let firstOfMonth = UpcomingDate.day(ds) == 1

        return Button {
            selectedDate = isSelected ? nil : ds
        } label: {
            VStack(spacing: 2) {
                if firstOfMonth {
                    Text(UpcomingDate.monthsAbbrDot[month])
                        .font(.system(size: 10))
                        .foregroundStyle(filled ? Color.tfRed : Color.tfSub)
                }
                Text("\(UpcomingDate.day(ds))")
                    .tfText(.input)
                    .monospacedDigit()
                    .fontWeight(filled ? .semibold : .regular)
                    .foregroundStyle(filled ? .white : (dim ? Color.tfDim.opacity(0.5) : Color.tfText))
                    .frame(width: 30, height: 30)
                    .background(filled ? Circle().fill(Color.tfRed) : nil)
                if hasTasks && !filled {
                    Circle().fill(Color.tfRed).frame(width: 4, height: 4)
                } else {
                    Color.clear.frame(width: 4, height: 4)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 44)
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private var weekStrip: some View {
        let days = (0..<7).map { UpcomingDate.addDays(activeWeekMonday, $0) }
        let today = UpcomingDate.todayString()
        return VStack(spacing: 2) {
            Text(monthOfWeekLabel(activeWeekMonday))
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.tfRed)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, TFSpacing.screenHorizontal)

            HStack(spacing: TFSpacing.xs) {
                ForEach(Array(days.enumerated()), id: \.offset) { i, ds in
                    let isToday = ds == today
                    let isSelected = ds == selectedDate
                    let hasTasks = !(groupedTasks[ds] ?? []).isEmpty
                    Button {
                        selectedDate = isSelected ? nil : ds
                    } label: {
                        VStack(spacing: 2) {
                            Text(["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][UpcomingDate.jsWeekday(ds)])
                                .tfText(.micro)
                                .textCase(.uppercase)
                                .foregroundStyle(isToday || isSelected ? Color.tfRed : Color.tfSub)
                            Text("\(UpcomingDate.day(ds))")
                                .font(.system(size: 15, weight: .medium))
                                .monospacedDigit()
                                .foregroundStyle(isToday ? .white : (isSelected ? Color.tfRed : Color.tfText))
                                .frame(width: 28, height: 28)
                                .background(isToday ? Circle().fill(Color.tfRed) : nil)
                            if hasTasks && !isToday {
                                Circle().fill(Color.tfRed).frame(width: 4, height: 4)
                            } else {
                                Color.clear.frame(width: 4, height: 4)
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.bottom, TFSpacing.sm)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 8)
                    .onEnded { value in
                        let dx = value.translation.width
                        let dy = value.translation.height
                        guard abs(dx) >= swipeStripPx, abs(dx) > abs(dy) * 1.3 else { return }
                        withAnimation { activeWeekMonday = UpcomingDate.addDays(activeWeekMonday, dx < 0 ? 7 : -7) }
                    }
            )
        }
        .padding(.top, TFSpacing.xs)
    }

    private func monthOfWeekLabel(_ monday: String) -> String {
        let (year, month) = UpcomingDate.weekMonth(monday: monday)
        return "\(UpcomingDate.monthsAbbrDot[month]) \(year)"
    }

    private func selectedPill(_ date: String) -> some View {
        Button { selectedDate = nil } label: {
            HStack(spacing: 8) {
                Image(systemName: "calendar").font(.system(size: TFIconSize.xs))
                Text(UpcomingDate.formatFullDate(date))
                Spacer()
                Image(systemName: "xmark").font(.system(size: TFIconSize.xs))
            }
            .tfText(.action)
            .foregroundStyle(Color.tfRed)
            .padding(.horizontal, TFSpacing.md).padding(.vertical, 8)
            .background(Color.tfRed.opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .padding(.top, TFSpacing.md)
    }

    // MARK: - Список

    private var list: some View {
        Group {
            if let selectedDate, (groupedTasks[selectedDate] ?? []).isEmpty {
                Text("Нет задач на эту дату")
                    .tfText(.body)
                    .foregroundStyle(Color.tfDim)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0, pinnedViews: selectedDate == nil ? [.sectionHeaders] : []) {
                        ForEach(visibleDates, id: \.self) { date in
                            let dayTasks = groupedTasks[date] ?? []
                            if selectedDate != nil || !dayTasks.isEmpty {
                                Section {
                                    ForEach(dayTasks, id: \.id) { task in
                                        UpcomingTaskRow(
                                            task: task,
                                            onOpen: { onTaskTap(task.id) },
                                            onComplete: { /* TODO: завершить задачу через taskStore */ },
                                            onReschedule: { onRescheduleTask(task) },
                                            onDelete: { onDeleteTask(task.id) }
                                        )
                                    }
                                } header: {
                                    if selectedDate == nil {
                                        dateHeader(date)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.top, TFSpacing.md)
                }
            }
        }
    }

    private func dateHeader(_ date: String) -> some View {
        let isToday = date == UpcomingDate.todayString()
        return Text(UpcomingDate.formatFullDate(date))
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(isToday ? Color.tfRed : Color.tfSub)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.vertical, 6)
            .background(Color.tfBackground)
    }
}
