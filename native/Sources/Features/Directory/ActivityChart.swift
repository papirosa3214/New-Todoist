import SwiftUI

// График продуктивности — spec/SCREENS-2.md §12.1. Логика подсчёта (что
// именно значит «В работе»/«Просрочено» за период, семантика drill-down)
// НЕ описана спекой в числах — снята чтением живого `src/components/
// ActivityChart.tsx` (только чтение, ARCHITECTURE.md разрешает читать веб
// за логикой, когда спека её не покрывает; цвета/раскладка — из спеки и
// кадра `activity.png`, не из CSS веба).
//
// Ключевая идея веба, повторённая здесь буквально: «В работе»/«Просрочено»
// считаются НЕ по времени выполнения, а по `due_date` задачи, попадающему в
// бакет графика — то есть кольцо дня показывает не «сколько выполнено
// сегодня из запланированного на сегодня», а срез по сроку. Line-график
// рисует именно `completed` (сколько выполнено в этом бакете).

enum ActivityPeriod: String, CaseIterable, Identifiable {
    case week, month, quarter, year
    var id: String { rawValue }

    var label: String {
        switch self {
        case .week: "Неделя"
        case .month: "Месяц"
        case .quarter: "3 месяца"
        case .year: "Год"
        }
    }
}

private let weekdaysRU = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"] // индекс = Calendar.weekday - 1, как JS getDay()
private let monthsNominativeRU = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
]
private let monthsShortCapRU = [
    "Янв", "Фев", "Мар", "Апр", "Май", "Июн",
    "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек",
]

private let chartGreen = Color(hex: "#15937e")
private let chartBlue = Color(hex: "#4a9fd8")
private let chartCoral = Color(hex: "#ff6b6b")

private struct ChartPoint: Identifiable {
    let key: String
    let label: String
    let shortLabel: String
    let assigned: Int
    let completed: Int
    let active: Int
    let overdue: Int
    let onTrack: Int
    let dates: [String]
    var id: String { key }
}

private struct DrillDownScope {
    let type: DrillType
    let title: String
    let parentPeriodLabel: String
    let dates: [String]
    enum DrillType { case week, month }
}

private struct DonutData {
    let isSingleDay: Bool
    let title: String
    let total: Int
    let completed: Int
    let onTrack: Int
    let overdue: Int
    let completedPct: Int
    let onTrackPct: Int
    let overduePct: Int
}

struct ActivityChart: View {
    /// Уже отфильтровано по проекту/метке/исполнителю (НЕ по периоду —
    /// период график строит сам), ВСЕ статусы — активные нужны для
    /// «в работе»/«просрочено», завершённые — для кривой.
    let tasks: [ApiTask]
    let period: ActivityPeriod

    @State private var chartType: ChartKind = .line
    @State private var selectedPointIdx: Int?
    @State private var singleDayDate: String?
    @State private var drillDown: DrillDownScope?

    private enum ChartKind { case line, donut }

    private let today = DirectoryDate.todayKeyLocal()

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            header
            segmentControl
            if chartType == .line {
                lineView
            } else {
                donutView
            }
        }
        .padding(TFSpacing.md)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        .overlay {
            RoundedRectangle(cornerRadius: TFRadius.xl)
                .strokeBorder(Color.tfStroke.opacity(0.6), lineWidth: TFBorder.width)
        }
        .onChange(of: period) {
            drillDown = nil
            singleDayDate = nil
            selectedPointIdx = nil
        }
    }

    // MARK: - Шапка

    private var header: some View {
        HStack(alignment: .center, spacing: TFSpacing.sm) {
            if let drillDown {
                Button {
                    self.drillDown = nil
                    selectedPointIdx = nil
                    singleDayDate = nil
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                        Text(drillDown.parentPeriodLabel).tfText(.meta)
                    }
                    .foregroundStyle(Color.tfSub)
                    .padding(.horizontal, TFSpacing.sm)
                    .padding(.vertical, 4)
                    .background(Color.tfCard2)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
                }
                .buttonStyle(TFTapScaleStyle())
            } else {
                RoundedRectangle(cornerRadius: TFRadius.md)
                    .fill(chartGreen.opacity(0.15))
                    .frame(width: 28, height: 28)
                    .overlay {
                        Image(systemName: "waveform.path.ecg").font(.system(size: TFIconSize.xs)).foregroundStyle(chartGreen)
                    }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(drillDown?.title ?? "Продуктивность")
                    .tfText(.body).fontWeight(.semibold).foregroundStyle(Color.tfText).lineLimit(1)
                Text(periodSubtitle).tfText(.caption).foregroundStyle(Color.tfSub)
            }
            Spacer(minLength: 0)
        }
    }

    private var periodSubtitle: String {
        if let drillDown { return "Детализация (\(drillDown.parentPeriodLabel))" }
        switch period {
        case .week: return "За неделю"
        case .month: return "За месяц"
        case .quarter: return "За 3 месяца (по неделям)"
        case .year: return "За год (по месяцам)"
        }
    }

    private var segmentControl: some View {
        HStack(spacing: 2) {
            segmentButton("Кривая", isOn: chartType == .line) { chartType = .line }
            segmentButton("Кольцо", isOn: chartType == .donut) { chartType = .donut }
        }
        .padding(2)
        .background(Color.tfCard2)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        .frame(maxWidth: 200)
    }

    private func segmentButton(_ title: String, isOn: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .tfText(.meta)
                .foregroundStyle(isOn ? Color.tfText : Color.tfDim)
                .padding(.horizontal, TFSpacing.sm)
                .padding(.vertical, 5)
                .frame(maxWidth: .infinity)
                .background(isOn ? Color.tfCard : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
        }
        .buttonStyle(TFTapScaleStyle())
    }

    // MARK: - Точки графика (портировано 1:1 из ActivityChart.tsx)

    private var points: [ChartPoint] {
        if let drillDown {
            return drillDown.dates.map { dayPoint(for: $0, shortIsDayOnly: drillDown.type == .month) }
        }
        switch period {
        case .week:
            return (0...6).reversed().map { i in
                dayPoint(for: DirectoryDate.addDaysLocal(today, -i), shortIsWeekday: true)
            }
        case .month:
            let now = Date()
            let cal = Calendar.current
            let dayOfMonth = cal.component(.day, from: now)
            let year = cal.component(.year, from: now)
            let month = cal.component(.month, from: now)
            return (1...dayOfMonth).map { d in
                let key = String(format: "%04d-%02d-%02d", year, month, d)
                return dayPoint(for: key, shortIsDayOnly: true)
            }
        case .quarter:
            return (0...11).reversed().map { w in weekPoint(w) }
        case .year:
            let cal = Calendar.current
            let currentMonth = cal.component(.month, from: Date()) - 1 // 0-based
            return (0...currentMonth).map { m in monthPoint(m) }
        }
    }

    private func dayPoint(for key: String, shortIsWeekday: Bool = false, shortIsDayOnly: Bool = false) -> ChartPoint {
        let comps = parts(of: key)
        let dow = weekdaysRU[weekdayIndex(comps)]
        let mShort = DirectoryDate.monthsShort[comps.month - 1]
        let completed = tasks.filter { completionDayKey($0) == key }.count
        let assigned = tasks.filter { $0.dueDate == key }.count
        let active = tasks.filter { $0.dueDate == key && $0.status == .active }.count
        let overdue = tasks.filter { $0.dueDate == key && $0.status == .active && key < today }.count
        let onTrack = max(0, active - overdue)
        let shortLabel = shortIsWeekday ? dow : (shortIsDayOnly ? "\(comps.day)" : dow)
        return ChartPoint(
            key: key, label: "\(comps.day) \(mShort) (\(dow))", shortLabel: shortLabel,
            assigned: max(assigned, completed), completed: completed, active: active,
            overdue: overdue, onTrack: onTrack, dates: [key]
        )
    }

    private func weekPoint(_ w: Int) -> ChartPoint {
        let endOffset = w * 7
        let startOffset = endOffset + 6
        var weekDates: [String] = []
        var i = startOffset
        while i >= endOffset {
            weekDates.append(DirectoryDate.addDaysLocal(today, -i))
            i -= 1
        }
        let datesSet = Set(weekDates)
        let completed = tasks.filter { key in guard let k = completionDayKey(key) else { return false }; return datesSet.contains(k) }.count
        let assigned = tasks.filter { t in t.dueDate.map(datesSet.contains) ?? false }.count
        let active = tasks.filter { t in (t.dueDate.map(datesSet.contains) ?? false) && t.status == .active }.count
        let overdue = tasks.filter { t in
            guard let d = t.dueDate, datesSet.contains(d), t.status == .active else { return false }
            return d < today
        }.count
        let onTrack = max(0, active - overdue)
        // weekDates[0] — первая добавленная в цикле (i=startOffset, самая старая дата);
        // last — последняя добавленная (i=endOffset, самая свежая) — как startDStr/endDStr в вебе.
        let startComps = parts(of: weekDates.first ?? today)
        let endComps = parts(of: weekDates.last ?? today)
        let label = "\(startComps.day) \(DirectoryDate.monthsShort[startComps.month - 1]) — \(endComps.day) \(DirectoryDate.monthsShort[endComps.month - 1])"
        return ChartPoint(
            key: "week-\(w)", label: label, shortLabel: "Н\(12 - w)",
            assigned: max(assigned, completed), completed: completed, active: active,
            overdue: overdue, onTrack: onTrack, dates: weekDates
        )
    }

    private func monthPoint(_ m: Int) -> ChartPoint {
        let cal = Calendar.current
        let year = cal.component(.year, from: Date())
        let monthPrefix = String(format: "%04d-%02d-", year, m + 1)
        var comps = DateComponents(); comps.year = year; comps.month = m + 1; comps.day = 1
        let firstOfMonth = cal.date(from: comps) ?? Date()
        let lastDay = cal.range(of: .day, in: .month, for: firstOfMonth)?.count ?? 28
        let monthDates = (1...lastDay).map { monthPrefix + String(format: "%02d", $0) }
        let completed = tasks.filter { key in guard let k = completionDayKey(key) else { return false }; return k.hasPrefix(monthPrefix) }.count
        let assigned = tasks.filter { $0.dueDate?.hasPrefix(monthPrefix) ?? false }.count
        let active = tasks.filter { ($0.dueDate?.hasPrefix(monthPrefix) ?? false) && $0.status == .active }.count
        let overdue = tasks.filter { t in
            guard let d = t.dueDate, d.hasPrefix(monthPrefix), t.status == .active else { return false }
            return d < today
        }.count
        let onTrack = max(0, active - overdue)
        return ChartPoint(
            key: "month-\(m)", label: "\(monthsNominativeRU[m]) \(year)", shortLabel: monthsShortCapRU[m],
            assigned: max(assigned, completed), completed: completed, active: active,
            overdue: overdue, onTrack: onTrack, dates: monthDates
        )
    }

    private func completionDayKey(_ task: ApiTask) -> String? {
        guard let raw = task.completedAt ?? (task.status == .completed ? task.updatedAt : nil),
              let date = DateFormats.sqliteUTC(raw) else { return nil }
        return DirectoryDate.dayKeyLocal(date)
    }

    private func parts(of key: String) -> (year: Int, month: Int, day: Int) {
        let p = key.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return (1970, 1, 1) }
        return (p[0], p[1], p[2])
    }

    private func weekdayIndex(_ c: (year: Int, month: Int, day: Int)) -> Int {
        var comps = DateComponents(); comps.year = c.year; comps.month = c.month; comps.day = c.day
        guard let date = Calendar.current.date(from: comps) else { return 0 }
        return Calendar.current.component(.weekday, from: date) - 1
    }

    // MARK: - Тап по точке — drill-down

    private func handleTap(_ idx: Int) {
        guard points.indices.contains(idx) else { return }
        let pt = points[idx]
        if drillDown != nil || period == .week || period == .month {
            selectedPointIdx = idx
            singleDayDate = pt.key
            chartType = .donut
            return
        }
        if period == .year {
            selectedPointIdx = nil
            drillDown = DrillDownScope(type: .month, title: pt.label, parentPeriodLabel: "Год", dates: pt.dates)
            return
        }
        if period == .quarter {
            selectedPointIdx = nil
            drillDown = DrillDownScope(type: .week, title: "Неделя: \(pt.label)", parentPeriodLabel: "3 месяца", dates: pt.dates)
        }
    }

    // MARK: - Кольцо

    private var donutData: DonutData {
        if let singleDayDate {
            let dayCompleted = tasks.filter { completionDayKey($0) == singleDayDate }.count
            let dayActive = tasks.filter { $0.dueDate == singleDayDate && $0.status == .active }.count
            let dayOverdue = tasks.filter { $0.dueDate == singleDayDate && $0.status == .active && singleDayDate < today }.count
            let dayOnTrack = max(0, dayActive - dayOverdue)
            let total = dayCompleted + dayOnTrack + dayOverdue
            let (c, o, od) = percentages(dayCompleted, dayOnTrack, dayOverdue, total: total)
            let comps = parts(of: singleDayDate)
            let dow = weekdaysRU[weekdayIndex(comps)]
            let title = "\(comps.day) \(DirectoryDate.monthsShort[comps.month - 1]) (\(dow))"
            return DonutData(isSingleDay: true, title: title, total: total, completed: dayCompleted, onTrack: dayOnTrack, overdue: dayOverdue, completedPct: c, onTrackPct: o, overduePct: od)
        }
        let totalCompleted = points.reduce(0) { $0 + $1.completed }
        let activeTasks = tasks.filter { $0.status == .active }
        let totalOverdue = activeTasks.filter { t in guard let d = t.dueDate else { return false }; return d < today }.count
        let totalOnTrack = max(0, activeTasks.count - totalOverdue)
        let total = totalCompleted + totalOnTrack + totalOverdue
        let (c, o, od) = percentages(totalCompleted, totalOnTrack, totalOverdue, total: total)
        return DonutData(isSingleDay: false, title: "", total: total, completed: totalCompleted, onTrack: totalOnTrack, overdue: totalOverdue, completedPct: c, onTrackPct: o, overduePct: od)
    }

    private func percentages(_ completed: Int, _ onTrack: Int, _ overdue: Int, total: Int) -> (Int, Int, Int) {
        guard total > 0 else { return (0, 0, 0) }
        let c = Int((Double(completed) / Double(total) * 100).rounded())
        let o = Int((Double(onTrack) / Double(total) * 100).rounded())
        let od = max(0, 100 - c - o)
        return (c, o, od)
    }

    // MARK: - VIEW 1: Кривая

    private var maxVal: CGFloat {
        let pts = points
        let m = pts.map { CGFloat(max($0.assigned, max($0.completed, $0.active + $0.completed), 1)) }.max() ?? 4
        return max(m, 4)
    }

    private var lineView: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            GeometryReader { geo in
                let pts = points
                let plotPoints = layoutPoints(pts, size: geo.size)
                ZStack {
                    gridLines(size: geo.size)
                    if !plotPoints.isEmpty {
                        areaPath(plotPoints, height: geo.size.height).fill(
                            LinearGradient(colors: [chartGreen.opacity(0.35), chartGreen.opacity(0)], startPoint: .top, endPoint: .bottom)
                        )
                        curvePath(plotPoints).stroke(chartGreen, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                        ForEach(Array(plotPoints.enumerated()), id: \.offset) { idx, p in
                            let isSelected = selectedPointIdx == idx
                            let dotSize: CGFloat = isSelected ? 11 : (pts.count > 15 ? 6 : 8)
                            Circle()
                                .fill(chartGreen)
                                .frame(width: dotSize, height: dotSize)
                                .overlay { Circle().strokeBorder(Color.tfCard, lineWidth: 2) }
                                .position(p)
                            // Отдельный прозрачный тап-таргет 32×32, центрированный в той же
                            // точке — сама точка мельче минимального тап-порога (44pt), а
                            // `.contentShape` на уже смещённой `.position()`-вьюхе брал бы
                            // хит-зону от ЛОКАЛЬНЫХ границ (8×8), а не от видимого места точки.
                            Color.clear
                                .frame(width: 32, height: 32)
                                .contentShape(Circle())
                                .position(p)
                                .onTapGesture { handleTap(idx) }
                        }
                    }
                }
            }
            .frame(height: 140)

            axisLabels

            Divider().overlay(Color.tfStroke.opacity(0.4))
            HStack {
                HStack(spacing: 6) {
                    Circle().fill(chartGreen).frame(width: 10, height: 10)
                    Text(hintText).tfText(.action).foregroundStyle(Color.tfSub)
                }
                Spacer()
                if let idx = selectedPointIdx, points.indices.contains(idx) {
                    Text("\(points[idx].label): \(points[idx].completed) вып.").tfText(.action).fontWeight(.medium).foregroundStyle(Color.tfText)
                } else {
                    Text("Всего: \(donutData.completed) вып.").tfText(.action).fontWeight(.medium).foregroundStyle(Color.tfText)
                }
            }
        }
    }

    private var hintText: String {
        if drillDown != nil { return "Тапните день для кольца дня" }
        switch period {
        case .year: return "Тапните месяц для перехода"
        case .quarter: return "Тапните неделю для перехода"
        case .week, .month: return "Тапните точку для кольца дня"
        }
    }

    @ViewBuilder
    private var axisLabels: some View {
        let pts = points
        if period == .week || drillDown?.type == .week {
            HStack {
                ForEach(Array(pts.enumerated()), id: \.offset) { idx, p in
                    Button { handleTap(idx) } label: {
                        Text(p.shortLabel).tfText(.micro).fontWeight(.bold)
                            .foregroundStyle(p.key == today ? Color.tfRed : (selectedPointIdx == idx ? Color.tfText : Color.tfDim))
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        } else if (period == .month && drillDown == nil) || drillDown?.type == .month {
            HStack {
                Text(pts.first?.shortLabel ?? "").tfText(.meta).foregroundStyle(Color.tfDim.opacity(0.8))
                Spacer()
                Text(drillDown?.title ?? monthsNominativeRU[Calendar.current.component(.month, from: Date()) - 1])
                    .tfText(.meta).foregroundStyle(Color.tfText)
                    .padding(.horizontal, TFSpacing.sm).padding(.vertical, 2)
                    .background(Color.tfCard2.opacity(0.8))
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
                Spacer()
                Text(pts.last?.shortLabel ?? "").tfText(.meta).fontWeight(.semibold).foregroundStyle(Color.tfRed)
            }
        } else if period == .quarter && drillDown == nil {
            let m = Calendar.current.component(.month, from: Date()) - 1
            HStack {
                Text(monthsNominativeRU[(m - 2 + 12) % 12]).tfText(.meta).foregroundStyle(Color.tfDim)
                Spacer()
                Text(monthsNominativeRU[(m - 1 + 12) % 12]).tfText(.meta).foregroundStyle(Color.tfDim)
                Spacer()
                Text(monthsNominativeRU[m]).tfText(.meta).fontWeight(.semibold).foregroundStyle(Color.tfText)
            }
        } else if period == .year && drillDown == nil {
            HStack {
                ForEach(Array(pts.enumerated()), id: \.offset) { idx, p in
                    Button { handleTap(idx) } label: {
                        Text(p.shortLabel).tfText(.micro).foregroundStyle(Color.tfDim).frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }

    /// Точки в системе координат реального контейнера — то же соотношение,
    /// что у веба (viewBox 320×100, x∈[10,310], y = 90 − (completed/max)·75),
    /// пересчитанное на фактические `size.width`/`size.height`.
    private func layoutPoints(_ pts: [ChartPoint], size: CGSize) -> [CGPoint] {
        guard !pts.isEmpty else { return [] }
        let len = pts.count
        return pts.enumerated().map { idx, p in
            let xFrac = len > 1 ? CGFloat(idx) / CGFloat(len - 1) : 0.5
            let x = len > 1 ? (10 + xFrac * 300) / 320 * size.width : 0.5 * size.width
            let yFrac = 90 - (CGFloat(p.completed) / maxVal) * 75
            let y = yFrac / 100 * size.height
            return CGPoint(x: x, y: y)
        }
    }

    private func curvePath(_ pts: [CGPoint]) -> Path {
        var path = Path()
        guard let first = pts.first else { return path }
        path.move(to: first)
        if pts.count == 1 {
            path.addLine(to: CGPoint(x: first.x + 1, y: first.y))
        } else {
            for i in 0..<(pts.count - 1) {
                let p0 = pts[i], p1 = pts[i + 1]
                let cx = (p0.x + p1.x) / 2
                path.addCurve(to: p1, control1: CGPoint(x: cx, y: p0.y), control2: CGPoint(x: cx, y: p1.y))
            }
        }
        return path
    }

    private func areaPath(_ pts: [CGPoint], height: CGFloat) -> Path {
        var path = curvePath(pts)
        guard let last = pts.last, let first = pts.first else { return path }
        let baseline = 90 / 100 * height
        path.addLine(to: CGPoint(x: last.x, y: baseline))
        path.addLine(to: CGPoint(x: first.x, y: baseline))
        path.closeSubpath()
        return path
    }

    private func gridLines(size: CGSize) -> some View {
        ZStack {
            gridLine(y: 20 / 100 * size.height, width: size.width, opacity: 0.06, dashed: true)
            gridLine(y: 55 / 100 * size.height, width: size.width, opacity: 0.06, dashed: true)
            gridLine(y: 90 / 100 * size.height, width: size.width, opacity: 0.08, dashed: false)
        }
    }

    private func gridLine(y: CGFloat, width: CGFloat, opacity: Double, dashed: Bool) -> some View {
        Path { path in
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: width, y: y))
        }
        .stroke(Color.white.opacity(opacity), style: StrokeStyle(lineWidth: 1, dash: dashed ? [3, 3] : []))
    }

    // MARK: - VIEW 2: Кольцо

    private var donutView: some View {
        VStack(spacing: TFSpacing.sm) {
            if donutData.isSingleDay {
                HStack {
                    HStack(spacing: 6) {
                        Image(systemName: "calendar").font(.system(size: 12)).foregroundStyle(Color.tfRed)
                        Text(donutData.title).tfText(.action).fontWeight(.semibold).foregroundStyle(Color.tfText)
                    }
                    Spacer()
                    Button("Показать за весь период") {
                        singleDayDate = nil
                        selectedPointIdx = nil
                    }
                    .tfText(.meta).foregroundStyle(Color.tfDim).underline()
                    .buttonStyle(TFTapFadeStyle())
                }
                .padding(.horizontal, TFSpacing.sm).padding(.vertical, 6)
                .background(Color.tfCard2.opacity(0.8))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }

            HStack(spacing: TFSpacing.lg) {
                donutRing.frame(width: 104, height: 104)
                metricsGrid
            }
        }
        .padding(.vertical, 2)
    }

    private var donutRing: some View {
        ZStack {
            Circle().stroke(Color.tfCard2, lineWidth: 10)
            if donutData.total == 0 {
                Circle().stroke(Color.tfDim.opacity(0.3), lineWidth: 10)
            } else {
                let cFrac = CGFloat(donutData.completedPct) / 100
                let oFrac = CGFloat(donutData.onTrackPct) / 100
                let odFrac = CGFloat(donutData.overduePct) / 100
                if cFrac > 0 {
                    Circle().trim(from: 0, to: cFrac)
                        .stroke(chartGreen, style: StrokeStyle(lineWidth: 10, lineCap: .butt))
                        .rotationEffect(.degrees(-90))
                }
                if oFrac > 0 {
                    Circle().trim(from: min(1, cFrac), to: min(1, cFrac + oFrac))
                        .stroke(chartBlue, style: StrokeStyle(lineWidth: 10, lineCap: .butt))
                        .rotationEffect(.degrees(-90))
                }
                if odFrac > 0 {
                    Circle().trim(from: min(1, cFrac + oFrac), to: min(1, cFrac + oFrac + odFrac))
                        .stroke(chartCoral, style: StrokeStyle(lineWidth: 10, lineCap: .butt))
                        .rotationEffect(.degrees(-90))
                }
            }
            VStack(spacing: 2) {
                Text("\(donutData.total)").font(.system(size: 20, weight: .bold)).foregroundStyle(Color.tfText)
                Text("всего задач").tfText(.micro).foregroundStyle(Color.tfDim)
            }
        }
    }

    private var metricsGrid: some View {
        VStack(spacing: TFSpacing.xs) {
            HStack(spacing: TFSpacing.xs) {
                metricTile("Выполнено", value: donutData.completed, pct: donutData.completedPct, color: chartGreen)
                metricTile("В работе", value: donutData.onTrack, pct: donutData.onTrackPct, color: chartBlue)
            }
            metricTileWide("Просрочено", value: donutData.overdue, pct: donutData.overduePct, color: chartCoral)
        }
        .frame(maxWidth: .infinity)
    }

    private func metricTile(_ title: String, value: Int, pct: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(title).tfText(.caption).foregroundStyle(color)
            }
            (Text("\(value) ").font(.system(size: 16, weight: .bold)).foregroundColor(Color.tfText)
                + Text("(\(pct)%)").tfStyle(TFFont.caption, tracking: TFFont.captionTracking).foregroundColor(Color.tfDim))
        }
        .padding(TFSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.tfCard2.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private func metricTileWide(_ title: String, value: Int, pct: Int, color: Color) -> some View {
        HStack {
            HStack(spacing: 4) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(title).tfText(.caption).foregroundStyle(color)
            }
            Spacer()
            (Text("\(value) ").font(.system(size: 14, weight: .bold)).foregroundColor(color)
                + Text("(\(pct)%)").tfStyle(TFFont.caption, tracking: TFFont.captionTracking).foregroundColor(color.opacity(0.8)))
        }
        .padding(TFSpacing.sm)
        .background(Color.tfCard2.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }
}
