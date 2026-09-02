import SwiftUI

// Вид «Неделя» — spec/SCREENS-1.md §3.6 `WeekGrid`/`MiniMonth`. Сетка 2×4:
// первая ячейка — мини-календарь месяца, остальные семь — дни недели.
// Неделя начинается с ПОНЕДЕЛЬНИКА везде (спека, §3.6).
private let swipeMinPx: CGFloat = 70 // SWIPE_MIN_PX

struct UpcomingWeekView: View {
    let monday: String
    let byDate: [String: [ApiTask]]
    let onTaskTap: (String) -> Void
    let onDayTap: (String) -> Void
    let onPickDate: (String) -> Void
    let onPrevWeek: () -> Void
    let onNextWeek: () -> Void

    private let days: [String]
    init(
        monday: String, byDate: [String: [ApiTask]],
        onTaskTap: @escaping (String) -> Void, onDayTap: @escaping (String) -> Void,
        onPickDate: @escaping (String) -> Void, onPrevWeek: @escaping () -> Void, onNextWeek: @escaping () -> Void
    ) {
        self.monday = monday
        self.byDate = byDate
        self.onTaskTap = onTaskTap
        self.onDayTap = onDayTap
        self.onPickDate = onPickDate
        self.onPrevWeek = onPrevWeek
        self.onNextWeek = onNextWeek
        self.days = (0..<7).map { UpcomingDate.addDays(monday, $0) }
    }

    var body: some View {
        GeometryReader { geo in
            let rowH = geo.size.height / 4
            VStack(spacing: 0) {
                row(rowH: rowH, left: { miniMonthCell }, right: { dayCell(index: 0, rowH: rowH) })
                row(rowH: rowH, left: { dayCell(index: 1, rowH: rowH) }, right: { dayCell(index: 2, rowH: rowH) })
                row(rowH: rowH, left: { dayCell(index: 3, rowH: rowH) }, right: { dayCell(index: 4, rowH: rowH) })
                row(rowH: rowH, left: { dayCell(index: 5, rowH: rowH) }, right: { dayCell(index: 6, rowH: rowH) })
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .gesture(swipeGesture)
    }

    @ViewBuilder
    private func row(rowH: CGFloat, @ViewBuilder left: () -> some View, @ViewBuilder right: () -> some View) -> some View {
        HStack(spacing: 0) { left(); right() }.frame(height: rowH)
    }

    private var miniMonthCell: some View {
        UpcomingMiniMonth(monday: monday, onPickDate: onPickDate)
            .overlay(alignment: .trailing) { Rectangle().fill(Color.tfStroke).frame(width: TFBorder.width) }
            .overlay(alignment: .bottom) { Rectangle().fill(Color.tfStroke).frame(height: TFBorder.width) }
    }

    private func dayCell(index i: Int, rowH: CGFloat) -> some View {
        let ds = days[i]
        let today = UpcomingDate.todayString()
        let isToday = ds == today
        let tasks = byDate[ds] ?? []
        return VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(UpcomingDate.weekdaysShort[i])
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(isToday ? Color.tfRed : Color.tfSub)
                Text("\(UpcomingDate.day(ds))")
                    .font(.system(size: 12))
                    .monospacedDigit()
                    .foregroundStyle(isToday ? .white : Color.tfText)
                    .frame(minWidth: isToday ? 18 : nil, minHeight: isToday ? 18 : nil)
                    .background(isToday ? Circle().fill(Color.tfRed) : nil)
            }
            .padding(.horizontal, 2)
            .padding(.bottom, 2)

            ForEach(tasks, id: \.id) { task in
                UpcomingTaskChip(task: task, compact: false) { onTaskTap(task.id) }
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(height: rowH, alignment: .top)
        .clipped()
        .contentShape(Rectangle())
        .onTapGesture { onDayTap(ds) }
        .overlay(alignment: .trailing) {
            if i % 2 != 0 { Rectangle().fill(Color.tfStroke).frame(width: TFBorder.width) }
        }
        .overlay(alignment: .bottom) {
            if i < days.count - 2 { Rectangle().fill(Color.tfStroke).frame(height: TFBorder.width) }
        }
    }

    /// Свайп влево/вправо переключает неделю — порог `SWIPE_MIN_PX=70`, преобладание
    /// горизонтали над вертикалью (иначе жест не отличить от прокрутки соседних экранов).
    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 8)
            .onEnded { value in
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) >= swipeMinPx, abs(dx) > abs(dy) * 1.3 else { return }
                if dx < 0 { onNextWeek() } else { onPrevWeek() }
            }
    }
}

/// Мини-календарь месяца — первая ячейка `WeekGrid`, spec §3.6. Месяц берётся
/// по ЧЕТВЕРГУ показанной недели (см. `UpcomingDate.weekMonth`).
struct UpcomingMiniMonth: View {
    let monday: String
    let onPickDate: (String) -> Void

    var body: some View {
        let (year, month) = UpcomingDate.weekMonth(monday: monday)
        let cells = UpcomingDate.monthGridDates(year: year, month: month)
        let weekEnd = UpcomingDate.addDays(monday, 6)
        let today = UpcomingDate.todayString()

        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(0..<7, id: \.self) { i in
                    Text(UpcomingDate.weekdayLetters[i])
                        .font(.system(size: 9))
                        .foregroundStyle(Color.tfDim)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.bottom, 2)

            ForEach(0..<6, id: \.self) { row in
                let rowCells = Array(cells[(row * 7)..<(row * 7 + 7)])
                let inWeek = (rowCells.first ?? "") >= monday && (rowCells.first ?? "") <= weekEnd
                HStack(spacing: 0) {
                    ForEach(rowCells, id: \.self) { ds in
                        let (_, cellMonth) = UpcomingDate.yearMonth(ds)
                        let dim = cellMonth != month
                        Button { onPickDate(ds) } label: {
                            Text("\(UpcomingDate.day(ds))")
                                .font(.system(size: 10))
                                .monospacedDigit()
                                .foregroundStyle(
                                    ds == today ? Color.tfRed
                                        : dim ? Color.tfDim.opacity(0.6) : Color.tfSub
                                )
                                .fontWeight(ds == today ? .semibold : .regular)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxHeight: .infinity)
                .background(inWeek ? Color.white.opacity(0.07) : .clear)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
            }
        }
        .padding(6)
    }
}
