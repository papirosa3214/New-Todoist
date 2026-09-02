import SwiftUI

// Массовый перенос просроченных — spec §3.8 `RescheduleSheet`. Открывается
// с колонки «Просрочено» на доске «Сегодня».
struct RescheduleSheetContent: View {
    let taskIds: [String]
    let taskStore: TaskStore
    let onClose: () -> Void

    @State private var pendingDate: String?
    @State private var displayedMonth = Date()
    @State private var isRescheduling = false
    @State private var done = 0
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: TFSpacing.lg) {
            HStack {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 18)).foregroundStyle(Color.tfText)
                }
                .frame(width: 44, height: 44)
                Spacer()
                Text("Срок").tfText(.title).foregroundStyle(Color.tfText)
                Spacer()
                Button(action: confirm) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: TFIconSize.md))
                        .foregroundStyle(pendingDate != nil && !isRescheduling ? Color.tfRed : Color.tfDim)
                }
                .disabled(pendingDate == nil || isRescheduling)
                .frame(width: 44, height: 44)
            }

            if isRescheduling {
                Text("Переносим \(done) из \(taskIds.count)…")
                    .tfText(.action)
                    .foregroundStyle(Color.tfSub)
            }
            TFErrorBanner(errorMessage, variant: .block)

            VStack(spacing: TFSpacing.xs) {
                quickButton("Сегодня", subtitle: TodayDate.weekdaysFull[weekday(TodayDate.todayString())]) {
                    apply(date: TodayDate.todayString())
                }
                quickButton("Завтра") { apply(date: TodayDate.addDays(TodayDate.todayString(), 1)) }
                quickButton("На выходных") { apply(date: nearestSaturday()) }
                quickButton("Следующая неделя") { apply(date: nearestMonday()) }
                quickButton("Без срока") { apply(date: nil) }
            }

            monthCalendar
        }
        .padding(.bottom, TFSpacing.xl)
        .disabled(isRescheduling)
    }

    private func quickButton(_ title: String, subtitle: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).tfText(.body).foregroundStyle(Color.tfText)
                Spacer()
                if let subtitle {
                    Text(subtitle).tfText(.action).foregroundStyle(Color.tfSub)
                }
            }
            .padding(TFSpacing.lg)
            .background(Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
        .buttonStyle(TFTapRowStyle())
    }

    // MARK: - Календарь месяца (упрощённый: сетка 6×7 без свайпа между месяцами жестом — только стрелки).

    private var monthCalendar: some View {
        let calendar = Calendar(identifier: .gregorian)
        let comps = calendar.dateComponents([.year, .month], from: displayedMonth)
        let firstOfMonth = calendar.date(from: comps) ?? displayedMonth
        let firstWeekday = (calendar.component(.weekday, from: firstOfMonth) + 5) % 7 // Пн=0
        let daysInMonth = calendar.range(of: .day, in: .month, for: firstOfMonth)?.count ?? 30
        let monthFormatter: DateFormatter = {
            let f = DateFormatter()
            f.locale = Locale(identifier: "ru_RU")
            f.dateFormat = "LLLL yyyy"
            return f
        }()

        return VStack(spacing: TFSpacing.sm) {
            HStack {
                Button { shiftMonth(-1) } label: { Image(systemName: "chevron.left") }
                Spacer()
                Text(monthFormatter.string(from: firstOfMonth).capitalized).tfText(.body).foregroundStyle(Color.tfText)
                Spacer()
                Button { shiftMonth(1) } label: { Image(systemName: "chevron.right") }
            }
            .foregroundStyle(Color.tfText)

            HStack {
                ForEach(TodayDate.weekdaysShort.indices.filter { $0 != 0 } + [0], id: \.self) { idx in
                    Text(TodayDate.weekdaysShort[idx]).tfText(.micro).foregroundStyle(Color.tfDim).frame(maxWidth: .infinity)
                }
            }

            let columns = Array(repeating: GridItem(.flexible()), count: 7)
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(0..<firstWeekday, id: \.self) { _ in Color.clear.frame(height: 32) }
                ForEach(1...daysInMonth, id: \.self) { day in
                    dayCell(day: day, comps: comps, calendar: calendar, fallback: firstOfMonth)
                }
            }
        }
        .padding(TFSpacing.lg)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    /// Ячейка дня вынесена из `ForEach` отдельной функцией: внутри блока,
    /// который строит вью, объявлять переменные нельзя — а дату дня иначе
    /// не собрать (нужно подменить день в компонентах месяца).
    @ViewBuilder
    private func dayCell(day: Int, comps: DateComponents, calendar: Calendar, fallback: Date) -> some View {
        let dateStr: String = {
            var dc = comps
            dc.day = day
            return TodayDate.calendarDateString(calendar.date(from: dc) ?? fallback)
        }()
        Button { pendingDate = dateStr } label: {
            Text("\(day)")
                .tfText(.row)
                .foregroundStyle(pendingDate == dateStr ? .white : Color.tfText)
                .frame(width: 32, height: 32)
                .background(pendingDate == dateStr ? Color.tfRed : .clear)
                .clipShape(Circle())
        }
    }

    private func shiftMonth(_ delta: Int) {
        displayedMonth = Calendar.current.date(byAdding: .month, value: delta, to: displayedMonth) ?? displayedMonth
    }

    private func weekday(_ dateStr: String) -> Int {
        guard let d = TodayDate.calendarDate(dateStr) else { return 0 }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal.component(.weekday, from: d) - 1
    }

    private func nearestSaturday() -> String {
        var date = TodayDate.todayString()
        for _ in 0..<7 {
            if weekday(date) == 6 { return date } // суббота
            date = TodayDate.addDays(date, 1)
        }
        return date
    }

    private func nearestMonday() -> String {
        var date = TodayDate.addDays(TodayDate.todayString(), 1)
        for _ in 0..<7 {
            if weekday(date) == 1 { return date } // понедельник
            date = TodayDate.addDays(date, 1)
        }
        return date
    }

    private func apply(date: String?) {
        pendingDate = date ?? ""
        Task { await runReschedule(date: date) }
    }

    private func confirm() {
        guard let pendingDate, !pendingDate.isEmpty else { return }
        Task { await runReschedule(date: pendingDate) }
    }

    private func runReschedule(date: String?) async {
        isRescheduling = true
        done = 0
        errorMessage = nil
        var failed = 0
        await withTaskGroup(of: Bool.self) { group in
            for id in taskIds {
                group.addTask {
                    // `ApiTask` — все поля `let` (см. Core/Models/Task.swift), точечно
                    // мутировать `inout` нечем; полагаемся на ответ сервера, который
                    // `patch()` сам подставит в стор после await — без мгновенного
                    // оптимистичного обновления строки, но корректно.
                    await taskStore.patch(taskId: id, fields: ["due_date": date.map { JSONValue.string($0) } ?? .null]) { _ in }
                }
            }
            for await ok in group {
                if ok { done += 1 } else { failed += 1 }
            }
        }
        isRescheduling = false
        if failed > 0 {
            errorMessage = "Не удалось перенести \(failed) из \(taskIds.count) задач. Остальные уже перенесены — попробуйте ещё раз."
        } else {
            onClose()
        }
    }
}
