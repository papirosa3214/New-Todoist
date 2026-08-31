import Foundation
import SwiftUI

// Геометрия и раскладка сетки «часы» — порт `DayHours.tsx` (spec §3.5).
// Числа — замер, не круглые величины (см. комментарий в живом коде):
enum TodayHoursMetrics {
    static let hourH: CGFloat = 124 / 3          // высота часа
    static let gutterW: CGFloat = 161 / 3        // левая колонка с подписями
    static let snapMin: Int = 15                 // шаг привязки перетаскивания
    static let minH: CGFloat = 24                // минимальная высота плашки
    static let rightInset: CGFloat = 6
    static let colGap: CGFloat = 3
    /// Часы 0...23, плюс замыкающая подпись «24:00» — потолок шкалы, задачу
    /// туда уже не поставить (владелец 19.08.2026, см. живой код).
    static let hoursCount = 24
    /// Декоративные строки-подписи ПОСЛЕ полуночи следующих суток — просто
    /// фон, задачу туда не поставить (web считает точную высоту хвоста
    /// страницы под кнопку; здесь — то самое «пять секций», которые
    /// упомянул владелец в комментарии живого кода, фиксированное число
    /// вместо динамического замера свободного места).
    static let decorativeHoursBelow = 5
}

/// «14:30» → 14.5.
func hoursFromTime(_ raw: String?) -> Double? {
    guard let (h, m) = DateFormats.localTimeComponents(raw) else { return nil }
    return Double(h) + Double(m) / 60
}

/// Смещение от верха сетки → «ЧЧ:ММ», округлённое до SNAP_MIN, зажатое сутками.
func timeFromOffset(_ y: CGFloat) -> String {
    let raw = (y / TodayHoursMetrics.hourH) * 60
    let snap = CGFloat(TodayHoursMetrics.snapMin)
    let snapped = (raw / snap).rounded() * snap
    let clamped = min(max(snapped, 0), CGFloat(TodayHoursMetrics.hoursCount * 60) - snap)
    let h = Int(clamped) / 60
    let m = Int(clamped) % 60
    return String(format: "%02d:%02d", h, m)
}

func hourLabel(_ h: Int) -> String { String(format: "%02d:00", h) }

/// Подпись с зацикливанием суток: −1 → «23:00», 25 → «01:00»; ровно 24 остаётся «24:00».
func cycleLabel(_ h: Int) -> String {
    if h == 24 { return "24:00" }
    let m = ((h % 24) + 24) % 24
    return hourLabel(m)
}

struct TodayPlacedBlock: Identifiable {
    var id: String { task.id }
    let task: ApiTask
    let top: CGFloat
    let height: CGFloat
    let colIndex: Int
    let columns: Int
    let durKnown: Bool
}

/// Раскладывает задачи одного дня по вертикали и, при коллизиях по
/// времени, по колонкам side-by-side (кластеры пересекающихся задач,
/// внутри — жадная раскладка). Порт `layoutDay()` (DayHours.tsx).
func layoutHoursDay(_ tasks: [ApiTask]) -> [TodayPlacedBlock] {
    struct Item { let task: ApiTask; let start: Double; let end: Double; let durKnown: Bool }
    let items = tasks
        .compactMap { t -> Item? in
            guard let start = hoursFromTime(t.startTime) else { return nil }
            let durKnown = t.durationMin != nil
            let dur = t.durationMin ?? 30
            return Item(task: t, start: start, end: start + Double(dur) / 60, durKnown: durKnown)
        }
        .sorted { $0.start != $1.start ? $0.start < $1.start : $0.end < $1.end }

    var placed: [TodayPlacedBlock] = []
    var cluster: [Item] = []
    var clusterEnd = -Double.infinity

    func flush() {
        guard !cluster.isEmpty else { return }
        var colEnds: [Double] = []
        var colOf: [Int] = []
        for item in cluster {
            if let existing = colEnds.firstIndex(where: { $0 <= item.start }) {
                colEnds[existing] = item.end
                colOf.append(existing)
            } else {
                colOf.append(colEnds.count)
                colEnds.append(item.end)
            }
        }
        let cols = colEnds.count
        for (i, item) in cluster.enumerated() {
            placed.append(TodayPlacedBlock(
                task: item.task,
                top: max(0, CGFloat(item.start) * TodayHoursMetrics.hourH + 1),
                height: max(TodayHoursMetrics.minH, CGFloat(item.end - item.start) * TodayHoursMetrics.hourH - 3),
                colIndex: colOf[i],
                columns: cols,
                durKnown: item.durKnown
            ))
        }
        cluster = []
    }

    for item in items {
        if !cluster.isEmpty && item.start >= clusterEnd {
            flush()
            clusterEnd = -Double.infinity
        }
        cluster.append(item)
        clusterEnd = max(clusterEnd, item.end)
    }
    flush()
    return placed
}

/// Текст на цветной плашке — тёмный (WCAG-аудит 19.08.2026, spec §3.5/живой код).
let todayChipInk = Color(hex: "#141414")
