import SwiftUI

// Вид «Месяц» — spec/SCREENS-1.md §3.6 `MonthGrid`: непрерывная лента недель
// (Google Calendar-style), НЕ страницы со свайпом. `MONTH_ROW_H=128`,
// `MONTH_CHIP_LIMIT=4`, подгрузка чанками `WEEKS_CHUNK=12`.
//
// ⚠️ Упрощение против веба (см. отчёт): веб догружает недели И вверх, и
// вниз через IntersectionObserver, сохраняя scrollOffset при prepend'е
// ручной коррекцией scrollTop. SwiftUI `ScrollView`/`LazyVStack` не даёт
// такого якоря без самодельной системы измерения (iOS 18 `scrollPosition`
// не покрывает «вставить контент выше текущей позиции без прыжка» для
// LazyVStack с переменной высотой строк-полос дня). Здесь — честный
// компромисс: стартовый диапазон `WEEKS_INITIAL_PAST`/`_FUTURE` пошире,
// подгрузка ТОЛЬКО вперёд (вниз) чанками при подходе к концу списка. Долистать
// в прошлое дальше стартовых 8 недель нельзя — ограничение, не молчаливое.
private let monthRowH: CGFloat = 128
private let monthChipLimit = 4
private let weeksInitialPast = 8
private let weeksInitialFuture = 16
private let weeksChunk = 12

struct UpcomingMonthView: View {
    let initialMonday: String
    /// Месяц, на котором должна открыться лента (обычно месяц «сегодня»).
    /// Передаётся явно из родителя: если взять месяц самой `initialMonday`,
    /// а она приходится на последние дни предыдущего месяца (как `mondayOf`
    /// от 1 числа), стартовая неделя уедет на месяц назад — открываемся
    /// на прошедшем месяце, а не на текущем.
    let initialMonth: (year: Int, month: Int)
    let byDate: [String: [ApiTask]]
    let openDay: String?
    let onDayTap: (String) -> Void
    let onTaskTap: (String) -> Void
    let onVisibleMonthChange: (Int, Int) -> Void

    @State private var weeks: [String] = []
    @State private var didInitialScroll = false

    init(
        initialMonday: String, initialMonth: (year: Int, month: Int),
        byDate: [String: [ApiTask]], openDay: String?,
        onDayTap: @escaping (String) -> Void, onTaskTap: @escaping (String) -> Void,
        onVisibleMonthChange: @escaping (Int, Int) -> Void
    ) {
        self.initialMonday = initialMonday
        self.initialMonth = initialMonth
        self.byDate = byDate
        self.openDay = openDay
        self.onDayTap = onDayTap
        self.onTaskTap = onTaskTap
        self.onVisibleMonthChange = onVisibleMonthChange
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                    Section {
                        ForEach(Array(weeks.enumerated()), id: \.element) { index, monday in
                            weekBlock(monday: monday, index: index)
                                .id(monday)
                        }
                    } header: {
                        weekdayHeader
                    }
                }
            }
            .onAppear {
                if weeks.isEmpty { weeks = Self.buildInitialWeeks(around: initialMonday, initialMonth: initialMonth) }
                guard !didInitialScroll else { return }
                didInitialScroll = true
                let target = Self.firstWeekMondayOfMonth(year: initialMonth.year, month: initialMonth.month)
                // Заголовок экрана сразу показывает месяц `initialMonth`, а не
                // месяц первой попавшей в кадр недели (она может быть в прошлом).
                onVisibleMonthChange(initialMonth.year, initialMonth.month)
                DispatchQueue.main.async {
                    proxy.scrollTo(target, anchor: .top)
                }
            }
        }
    }

    private var weekdayHeader: some View {
        HStack(spacing: 0) {
            ForEach(UpcomingDate.weekdaysShort, id: \.self) { w in
                Text(w).font(.system(size: 10)).foregroundStyle(Color.tfDim).frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, TFSpacing.xs)
        .background(Color.tfBackground)
    }

    private func weekBlock(monday: String, index: Int) -> some View {
        let days = (0..<7).map { UpcomingDate.addDays(monday, $0) }
        let months = Set(days.map { UpcomingDate.yearMonth($0).month })
        let isTransition = months.count > 1
        let openHere = openDay != nil && days.contains(openDay!)

        return VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(days, id: \.self) { ds in
                    monthDayCell(ds)
                }
            }
            .frame(height: monthRowH)
            .overlay(alignment: .top) {
                if isTransition && index > 0 { Rectangle().fill(Color.tfStroke).frame(height: TFBorder.width) }
            }
            .onAppear {
                let (y, m) = UpcomingDate.weekMonth(monday: monday)
                onVisibleMonthChange(y, m)
                // Подгрузка чанком вперёд, когда до конца списка осталось < 6 недель.
                if index >= weeks.count - 6 {
                    let extra = (1...weeksChunk).map { UpcomingDate.addDays(weeks[weeks.count - 1], $0 * 7) }
                    if !extra.isEmpty, weeks.last != extra.last {
                        weeks.append(contentsOf: extra)
                    }
                }
            }

            if openHere, let openDay {
                UpcomingDayStrip(date: openDay, tasks: byDate[openDay] ?? [], onTaskTap: onTaskTap)
            }
        }
    }

    private func monthDayCell(_ ds: String) -> some View {
        let today = UpcomingDate.todayString()
        let isToday = ds == today
        let isOpen = ds == openDay
        let tasks = byDate[ds] ?? []
        let shown = Array(tasks.prefix(monthChipLimit))
        let rest = tasks.count - shown.count

        return VStack(spacing: 2) {
            Text("\(UpcomingDate.day(ds))")
                .font(.system(size: 11))
                .monospacedDigit()
                .fontWeight(isToday ? .semibold : .regular)
                .foregroundStyle(isToday ? .white : Color.tfText)
                .frame(minWidth: isToday ? 18 : nil, minHeight: isToday ? 18 : nil)
                .background(isToday ? Circle().fill(Color.tfRed) : nil)

            ForEach(shown, id: \.id) { task in
                UpcomingTaskChip(task: task, compact: true) { onDayTap(ds) }
            }
            if rest > 0 {
                Text("+\(rest)").font(.system(size: 9)).foregroundStyle(Color.tfDim)
            }
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .top)
        .frame(height: monthRowH, alignment: .top)
        .background(isOpen ? Color.tfCard : .clear)
        .clipShape(isOpen ? RoundedRectangle(cornerRadius: TFRadius.lg) : RoundedRectangle(cornerRadius: 0))
        .clipped()
        .contentShape(Rectangle())
        .onTapGesture { onDayTap(ds) }
    }

    private static func buildInitialWeeks(around initialMonday: String, initialMonth: (year: Int, month: Int)) -> [String] {
        let firstWeekMonday = firstWeekMondayOfMonth(year: initialMonth.year, month: initialMonth.month)
        let start = UpcomingDate.addDays(firstWeekMonday, -weeksInitialPast * 7)
        return (0..<(weeksInitialPast + weeksInitialFuture + 1)).map { UpcomingDate.addDays(start, $0 * 7) }
    }

    /// Понедельник недели, содержащей 1-е число месяца `(year, month)`
    /// (0-based). Стартовая точка ленты — отдельно от `weekMonth`,
    /// которая считает «доминирующий» месяц по четвергу.
    private static func firstWeekMondayOfMonth(year: Int, month: Int) -> String {
        var comps = DateComponents()
        comps.year = year; comps.month = month + 1; comps.day = 1
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard let firstOf = cal.date(from: comps) else { return "" }
        let firstOfStr = UpcomingDate.calendarDateString(firstOf)
        return UpcomingDate.mondayOf(firstOfStr)
    }
}
