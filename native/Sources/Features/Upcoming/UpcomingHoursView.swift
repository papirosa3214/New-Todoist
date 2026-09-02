import SwiftUI

// Вид «Три дня» — spec/SCREENS-1.md §3.5 `DayHours` (та же сетка, что у
// «Сегодня», просто три колонки вместо одной). Числа — замер владельца,
// дробные значения ЗАКОННЫ, не округляются (спека): `HOUR_H=124/3`,
// `GUTTER_W=161/3`, `SNAP_MIN=15`, `MIN_H=24`.
//
// ⚠️ Хороший кандидат в общий кирпич (нужен и «Сегодня», один день — просьба
// оркестратора учла это заранее) — здесь сделан ЛОКАЛЬНО по правилу
// контракта («не хватает чужого — сделай локально»), в отчёте предлагаю
// оркестратору поднять в `DesignSystem`.
//
// ⚠️ Упрощение: перетаскивается только ПУЛ («без времени» → на сетку) —
// перетаскивание уже поставленной плашки на новое время/колонку (веб это
// тоже умеет) здесь не сделано ради объёма задачи; см. отчёт.
private let hourH: CGFloat = 124.0 / 3.0
private let gutterW: CGFloat = 161.0 / 3.0
private let snapMin = 15
private let minBlockH: CGFloat = 24
private let rightInset: CGFloat = 6
private let colGap: CGFloat = 3

struct UpcomingHourColumn: Identifiable {
    let date: String
    let tasks: [ApiTask]
    let isToday: Bool
    var id: String { date }
}

struct UpcomingHoursView: View {
    let days: [UpcomingHourColumn]
    let projectColor: (ApiTask) -> Color
    let onTaskTap: (String) -> Void
    /// Перенесли задачу из пула на сетку — назначить дату (колонки) и время.
    let onSchedule: (String, String, String) -> Void

    private var untimed: [ApiTask] {
        days.flatMap(\.tasks).filter { $0.startTime == nil }
    }

    var body: some View {
        VStack(spacing: 0) {
            if !untimed.isEmpty {
                untimedPool
            }
            ScrollViewReader { proxy in
                ScrollView {
                    ZStack(alignment: .topLeading) {
                        gridRows
                        HStack(spacing: 0) {
                            Color.clear.frame(width: gutterW)
                            ForEach(days) { day in
                                dayColumn(day)
                            }
                        }
                        nowLine
                    }
                    .frame(height: hourH * 24)
                }
                .onAppear {
                    // Автопрокрутка к текущему часу с запасом 120px сверху (спека §3.5).
                    let hour = Calendar.current.component(.hour, from: Date())
                    DispatchQueue.main.async {
                        withAnimation { proxy.scrollTo("hour-\(max(0, hour - 1))", anchor: .top) }
                    }
                }
            }
        }
    }

    // MARK: - Пул задач без времени

    private var untimedPool: some View {
        VStack(spacing: 0) {
            ForEach(Array(untimed.enumerated()), id: \.element.id) { index, task in
                if index > 0 { TFDivider() }
                UpcomingUntimedRow(task: task) { onTaskTap(task.id) }
                    .draggable(task.id)
            }
        }
        .background(Color.tfCard)
    }

    // MARK: - Сетка часов

    private var gridRows: some View {
        VStack(spacing: 0) {
            ForEach(0..<25, id: \.self) { h in
                HStack(alignment: .top, spacing: 0) {
                    Text(String(format: "%02d:00", h))
                        .font(.system(size: 10, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(Color.tfDim)
                        .frame(width: gutterW, alignment: .trailing)
                        .padding(.trailing, 6)
                        .offset(y: -6)
                    Rectangle().fill(Color.tfStroke).frame(height: TFBorder.width)
                }
                .frame(height: h < 24 ? hourH : 0, alignment: .top)
                .id("hour-\(h)")
            }
        }
    }

    private func dayColumn(_ day: UpcomingHourColumn) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Color.clear
                    .dropDestination(for: String.self) { items, location in
                        guard let id = items.first else { return false }
                        let time = Self.timeFromOffset(location.y)
                        onSchedule(id, day.date, time)
                        return true
                    }
                ForEach(Self.layoutDay(day.tasks)) { block in
                    UpcomingTimedBlock(
                        task: block.task,
                        color: projectColor(block.task),
                        durKnown: block.durKnown
                    ) { onTaskTap(block.task.id) }
                        .frame(width: Self.blockWidth(colWidth: geo.size.width, totalCols: block.totalCols))
                        .frame(height: block.height)
                        .position(
                            x: Self.blockLeft(colWidth: geo.size.width, col: block.col, totalCols: block.totalCols)
                                + Self.blockWidth(colWidth: geo.size.width, totalCols: block.totalCols) / 2,
                            y: block.top + block.height / 2
                        )
                }
            }
        }
        .overlay(alignment: .trailing) { Rectangle().fill(Color.tfStroke).frame(width: TFBorder.width) }
    }

    private var nowLine: some View {
        let now = Date()
        let comps = Calendar.current.dateComponents([.hour, .minute], from: now)
        let pos = CGFloat(comps.hour ?? 0) * hourH + CGFloat(comps.minute ?? 0) / 60 * hourH
        return HStack(spacing: 4) {
            Text(String(format: "%02d:%02d", comps.hour ?? 0, comps.minute ?? 0))
                .font(.system(size: 10, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(Color.tfRed)
                .frame(width: gutterW, alignment: .trailing)
                .background(Color.tfBackground)
            Circle().fill(Color.tfRed).frame(width: 7, height: 7)
            Rectangle().fill(Color.tfRed).frame(height: 1.5)
        }
        .offset(y: pos - 4)
        .allowsHitTesting(false)
    }

    // MARK: - Раскладка перекрывающихся задач (`layoutDay`, DayHours.tsx)

    private struct PlacedBlock: Identifiable {
        let task: ApiTask
        let top: CGFloat
        let height: CGFloat
        let col: Int
        let totalCols: Int
        let durKnown: Bool
        var id: String { task.id }
    }

    private static func hoursFromTime(_ t: String?) -> Double? {
        guard let (h, m) = DateFormats.localTimeComponents(t) else { return nil }
        return Double(h) + Double(m) / 60
    }

    private static func timeFromOffset(_ px: CGFloat) -> String {
        let raw = (px / hourH) * 60
        let snapped = (raw / CGFloat(snapMin)).rounded() * CGFloat(snapMin)
        let clamped = min(max(snapped, 0), CGFloat(24 * 60 - snapMin))
        let h = Int(clamped) / 60
        let m = Int(clamped) % 60
        return String(format: "%02d:%02d", h, m)
    }

    private static func blockWidth(colWidth: CGFloat, totalCols: Int) -> CGFloat {
        let totalGap = CGFloat(totalCols - 1) * colGap
        return max(4, (colWidth - rightInset - totalGap) / CGFloat(totalCols))
    }

    private static func blockLeft(colWidth: CGFloat, col: Int, totalCols: Int) -> CGFloat {
        col == 0 ? 0 : blockWidth(colWidth: colWidth, totalCols: totalCols) * CGFloat(col) + CGFloat(col) * colGap
    }

    private static func layoutDay(_ tasks: [ApiTask]) -> [PlacedBlock] {
        struct Item { let task: ApiTask; let start: Double; let end: Double; let durKnown: Bool }
        let items = tasks.compactMap { t -> Item? in
            guard let start = hoursFromTime(t.startTime) else { return nil }
            let durKnown = t.durationMin != nil
            let dur = Double(t.durationMin ?? 30)
            return Item(task: t, start: start, end: start + dur / 60, durKnown: durKnown)
        }.sorted { $0.start != $1.start ? $0.start < $1.start : $0.end < $1.end }

        var placed: [PlacedBlock] = []
        var cluster: [Item] = []
        var clusterEnd = -Double.infinity

        func flush() {
            guard !cluster.isEmpty else { return }
            var colEnds: [Double] = []
            var colOf: [Int] = []
            for item in cluster {
                if let idx = colEnds.firstIndex(where: { $0 <= item.start }) {
                    colEnds[idx] = item.end
                    colOf.append(idx)
                } else {
                    colOf.append(colEnds.count)
                    colEnds.append(item.end)
                }
            }
            let cols = colEnds.count
            for (i, item) in cluster.enumerated() {
                placed.append(PlacedBlock(
                    task: item.task,
                    top: CGFloat(max(0, item.start * Double(hourH) + 1)),
                    height: max(minBlockH, CGFloat((item.end - item.start) * Double(hourH)) - 3),
                    col: colOf[i],
                    totalCols: cols,
                    durKnown: item.durKnown
                ))
            }
            cluster = []
        }

        for item in items {
            if !cluster.isEmpty, item.start >= clusterEnd {
                flush()
                clusterEnd = -Double.infinity
            }
            cluster.append(item)
            clusterEnd = max(clusterEnd, item.end)
        }
        flush()
        return placed
    }
}

/// Заголовок колонок дня — уходит в `ScreenHeader.below` (спека §3.5, `DayColumnsHeader`).
struct UpcomingDayColumnsHeader: View {
    let days: [UpcomingHourColumn]
    var body: some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: gutterW)
            ForEach(days) { day in
                Text(UpcomingDate.formatDayColumnLabel(day.date))
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(day.isToday ? Color.tfRed : Color.tfSub)
                    .frame(maxWidth: .infinity)
            }
        }
        .padding(.top, TFSpacing.xs)
        .padding(.bottom, TFSpacing.sm)
        .background(Color.tfBackground)
    }
}

/// Плашка задачи без времени в пуле — spec §3.5, `UntimedRow`.
private struct UpcomingUntimedRow: View {
    let task: ApiTask
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                if task.priority <= 3, let p = TaskPriority(rawValue: task.priority) {
                    TFPriorityFlag(p)
                }
                if !task.subtasks.isEmpty {
                    Text("\(task.subtasks.count { $0.done })/\(task.subtasks.count)")
                        .font(.system(size: 11)).monospacedDigit().foregroundStyle(Color.tfDim)
                }
                Text(task.title)
                    .font(.system(size: 13))
                    .foregroundStyle(task.status == .completed ? Color.tfSub : Color.tfText)
                    .strikethrough(task.status == .completed)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, 12)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }
}

/// Плашка задачи на сетке — сплошная заливка цветом проекта, тёмный текст
/// (WCAG-аудит §3.5: белый текст не проходит норму ни на одном цвете палитры).
private struct UpcomingTimedBlock: View {
    let task: ApiTask
    let color: Color
    let durKnown: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(task.title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color(hex: "#141414"))
                .strikethrough(task.status == .completed)
                .lineLimit(nil)
                .multilineTextAlignment(.leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .buttonStyle(.plain)
        .background(color)
        .opacity(task.status == .completed ? 0.5 : 1)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.sm))
        .mask(alignment: .top) {
            if durKnown {
                Rectangle()
            } else {
                LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom)
            }
        }
    }
}
