import SwiftUI

// Мини-календарь месяца внутри `DueDateField` — spec/SCREENS-1.md §3.7:
// стрелки навигации + горизонтальный свайп, неделя с понедельника (единое
// правило проекта, §3.6), выбранный день — красный кружок.
struct MiniCalendarView: View {
    @Binding var selectedDate: Date?
    @State private var visibleMonth: Date

    init(selectedDate: Binding<Date?>) {
        self._selectedDate = selectedDate
        self._visibleMonth = State(initialValue: selectedDate.wrappedValue ?? Date())
    }

    private var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TaskDateText.moscow
        cal.firstWeekday = 2 // понедельник
        return cal
    }

    var body: some View {
        VStack(spacing: TFSpacing.md) {
            HStack {
                Button { shiftMonth(-1) } label: {
                    Image(systemName: "chevron.left").foregroundStyle(Color.tfText)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
                Spacer()
                Text(monthTitle).tfText(.body).fontWeight(.semibold).foregroundStyle(Color.tfText)
                Spacer()
                Button { shiftMonth(1) } label: {
                    Image(systemName: "chevron.right").foregroundStyle(Color.tfText)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
            }
            .buttonStyle(TFTapScaleStyle())

            HStack(spacing: 0) {
                ForEach(TaskDateText.weekdayLetters, id: \.self) { letter in
                    Text(letter).tfText(.micro).foregroundStyle(Color.tfDim)
                        .frame(maxWidth: .infinity)
                }
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 7), spacing: 6) {
                ForEach(daysGrid, id: \.self) { day in
                    if let day {
                        dayCell(day)
                    } else {
                        Color.clear.frame(height: 32)
                    }
                }
            }
        }
        .highPriorityGesture(
            DragGesture(minimumDistance: 24)
                .onEnded { value in
                    if value.translation.width < -40 { shiftMonth(1) }
                    else if value.translation.width > 40 { shiftMonth(-1) }
                }
        )
    }

    private func dayCell(_ day: Date) -> some View {
        let isSelected = selectedDate.map { calendar.isDate($0, inSameDayAs: day) } ?? false
        let isToday = calendar.isDateInToday(day)
        let inMonth = calendar.isDate(day, equalTo: visibleMonth, toGranularity: .month)
        return Button {
            selectedDate = day
        } label: {
            Text("\(calendar.component(.day, from: day))")
                .tfText(.body)
                .foregroundStyle(isSelected ? .white : (inMonth ? Color.tfText : Color.tfDim))
                .frame(width: 32, height: 32)
                .background {
                    if isSelected {
                        Circle().fill(Color.tfRed)
                    } else if isToday {
                        Circle().strokeBorder(Color.tfRed, lineWidth: 1)
                    }
                }
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private var monthTitle: String {
        let comps = calendar.dateComponents([.month, .year], from: visibleMonth)
        let month = TaskDateText.monthsShort[max(0, min(11, (comps.month ?? 1) - 1))]
        return "\(month.prefix(1).uppercased() + month.dropFirst()) \(comps.year ?? 0)"
    }

    /// 42 ячейки (6 недель), `nil` — заполнитель до/после месяца.
    private var daysGrid: [Date?] {
        guard let monthInterval = calendar.dateInterval(of: .month, for: visibleMonth) else { return [] }
        let firstWeekday = calendar.component(.weekday, from: monthInterval.start)
        // component(.weekday) — 1=вс..7=сб; переводим в отступ от понедельника.
        let leadingBlanks = (firstWeekday - calendar.firstWeekday + 7) % 7
        let daysInMonth = calendar.range(of: .day, in: .month, for: visibleMonth)?.count ?? 30
        var cells: [Date?] = Array(repeating: nil, count: leadingBlanks)
        for dayOffset in 0..<daysInMonth {
            if let date = calendar.date(byAdding: .day, value: dayOffset, to: monthInterval.start) {
                cells.append(date)
            }
        }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    private func shiftMonth(_ delta: Int) {
        if let newMonth = calendar.date(byAdding: .month, value: delta, to: visibleMonth) {
            withAnimation(.easeInOut(duration: TFDuration.fast)) { visibleMonth = newMonth }
        }
    }
}
