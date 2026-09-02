import SwiftUI

// Три слоя «Ленты дня» — порт `DayLayer`/`WeekLayer`/`MonthGrid` из
// `TodayScreenTimeline.tsx` (см. комментарий-источник в TimelineScreen.swift).

/// Слой «День» (zoom=0) — вертикальная нить точек-задач, порт `DayLayer`+`TimelineTask`.
struct TimelineDayLayer: View {
    let tasks: [ApiTask]
    let isLoading: Bool
    let onOpen: (String) -> Void

    var body: some View {
        ScrollView {
            ZStack(alignment: .topLeading) {
                LinearGradient(colors: [.clear, .white.opacity(0.2), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(width: 1)
                    .padding(.leading, 24)

                VStack(alignment: .leading, spacing: TFSpacing.xl * 2) {
                    if isLoading {
                        Text("Загрузка…").tfText(.action).foregroundStyle(Color.tfSub)
                    } else if tasks.isEmpty {
                        Text("На сегодня задач нет.").tfText(.action).foregroundStyle(Color.tfSub)
                    } else {
                        ForEach(tasks) { task in
                            timelineTaskRow(task)
                        }
                    }
                }
                .padding(.leading, TFSpacing.xl)
            }
        }
    }

    private func timelineTaskRow(_ task: ApiTask) -> some View {
        let color = timelinePriorityColor(task.priority)
        let time: String = {
            if let start = task.startTime, let dur = task.durationMin {
                return "\(start)—\(timelineFormatEnd(start, dur))"
            } else if let start = task.startTime {
                return start
            }
            return "Без времени"
        }()
        return Button(action: { onOpen(task.id) }) {
            VStack(alignment: .leading, spacing: 4) {
                Text(time)
                    .font(.system(size: 12, design: .monospaced))
                    .tracking(1.5)
                    .foregroundStyle(Color.tfDim)
                Text(task.title)
                    .font(.system(size: 18, weight: .light))
                    .foregroundStyle(Color.tfText)
            }
            .overlay(alignment: .topLeading) {
                Circle().fill(color).frame(width: 8, height: 8)
                    .shadow(color: color.opacity(0.6), radius: 4)
                    .offset(x: -20, y: 6)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}

/// Слой «Неделя» (zoom=1) — 7 дней вокруг today, порт `WeekLayer`.
struct TimelineWeekLayer: View {
    let days: [TimelineDay]
    let today: String

    var body: some View {
        ScrollView {
            ZStack(alignment: .topLeading) {
                LinearGradient(colors: [.clear, .white.opacity(0.2), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(width: 1)
                    .padding(.leading, 24)

                VStack(alignment: .leading, spacing: TFSpacing.xl) {
                    ForEach(days, id: \.date) { day in
                        dayRow(day)
                    }
                }
                .padding(.leading, TFSpacing.xl)
            }
        }
    }

    private func dayRow(_ day: TimelineDay) -> some View {
        let isCurrent = day.date == today
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(day.label.uppercased())
                    .font(.system(size: 12, weight: isCurrent ? .medium : .regular))
                    .tracking(1.5)
                    .foregroundStyle(isCurrent ? Color.tfText : Color.tfDim)
                if isCurrent {
                    Text("· \(TodayDate.weekdaysFull[weekdayIndex(day.date)])")
                        .font(.system(size: 12))
                        .tracking(1.5)
                        .foregroundStyle(Color.tfText)
                }
            }
            if day.tasks.isEmpty {
                Text("Отдых").font(.system(size: 18)).foregroundStyle(Color.tfSub)
            } else {
                HStack(spacing: TFSpacing.sm) {
                    Text(taskCountLabel(day.tasks.count)).font(.system(size: 18)).foregroundStyle(Color.tfText)
                    HStack(spacing: 5) {
                        ForEach(Array(day.tasks.prefix(6)), id: \.id) { task in
                            Circle().fill(timelinePriorityColor(task.priority)).frame(width: 6, height: 6)
                        }
                    }
                }
            }
        }
        .overlay(alignment: .topLeading) {
            Circle().fill(.white).frame(width: isCurrent ? 8 : 4, height: isCurrent ? 8 : 4)
                .offset(x: isCurrent ? -20 : -18, y: 6)
        }
        .opacity(isCurrent ? 1 : 0.4)
    }

    private func weekdayIndex(_ dateStr: String) -> Int {
        guard let d = TodayDate.calendarDate(dateStr) else { return 0 }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal.component(.weekday, from: d) - 1
    }

    private func taskCountLabel(_ n: Int) -> String {
        if n == 1 { return "1 задача" }
        if n < 5 { return "\(n) задачи" }
        return "\(n) задач"
    }
}

/// Слой «Месяц» (zoom=2) — сетка 7×N текущего месяца, порт `MonthGrid`.
struct TimelineMonthLayer: View {
    let tasksByDay: [Int: [ApiTask]]
    let today: String
    let onOpen: (String) -> Void

    var body: some View {
        let cal: Calendar = {
            var c = Calendar(identifier: .gregorian)
            c.timeZone = TimeZone(identifier: "UTC")!
            return c
        }()
        let todayDate = TodayDate.calendarDate(today) ?? Date()
        let todayDay = cal.component(.day, from: todayDate)
        let year = cal.component(.year, from: todayDate)
        let month = cal.component(.month, from: todayDate)
        let daysInMonth = cal.range(of: .day, in: .month, for: todayDate)?.count ?? 30
        var firstComps = DateComponents(); firstComps.year = year; firstComps.month = month; firstComps.day = 1
        let firstOfMonth = cal.date(from: firstComps) ?? todayDate
        let firstWeekday = (cal.component(.weekday, from: firstOfMonth) + 5) % 7 // Пн=0

        let columns = Array(repeating: GridItem(.flexible()), count: 7)

        return ScrollView {
            VStack(spacing: TFSpacing.lg) {
                Text("ПН · ВТ · СР · ЧТ · ПТ · СБ · ВС")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.tfDim)

                LazyVGrid(columns: columns, spacing: TFSpacing.xl) {
                    ForEach(0..<firstWeekday, id: \.self) { _ in Color.clear.frame(height: 32) }
                    ForEach(1...daysInMonth, id: \.self) { day in
                        dayCell(day: day, isToday: day == todayDay, tasks: tasksByDay[day] ?? [])
                    }
                }
            }
            .padding(.horizontal, TFSpacing.sm)
        }
    }

    private func dayCell(day: Int, isToday: Bool, tasks: [ApiTask]) -> some View {
        Button(action: { if tasks.count == 1 { onOpen(tasks[0].id) } }) {
            VStack(spacing: 4) {
                Text("\(day)")
                    .font(.system(size: 20, weight: isToday ? .medium : .light))
                    .foregroundStyle(isToday ? Color.tfText : Color.tfSub)
                if isToday && !tasks.isEmpty {
                    Circle().fill(Color.tfOrange).frame(width: 4, height: 4)
                        .shadow(color: Color.tfOrange.opacity(0.8), radius: 4)
                } else if !tasks.isEmpty {
                    HStack(spacing: 2) {
                        ForEach(Array(tasks.prefix(4)), id: \.id) { task in
                            Circle().fill(timelinePriorityColor(task.priority)).frame(width: 4, height: 4)
                        }
                    }
                } else {
                    Color.clear.frame(height: 4)
                }
            }
            .opacity(isToday ? 1 : 0.6)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }
}

func timelineFormatEnd(_ start: String, _ durationMin: Int) -> String {
    let parts = start.split(separator: ":").compactMap { Int($0) }
    guard parts.count == 2 else { return start }
    let total = parts[0] * 60 + parts[1] + durationMin
    let eh = (total / 60) % 24
    let em = total % 60
    return String(format: "%02d:%02d", eh, em)
}
