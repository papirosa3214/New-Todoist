import SwiftUI

// Вид «Список» — spec §5.1. Секции сверху вниз: «Ждут вас» → «Просрочено» →
// дата-заголовок (только если выше уже была секция) → задачи на сегодня.
// `AppleCalendarEvents` (события календаря устройства) — вне спеки Волны 1
// (`spec/NATIVE-PARTS.md` относит интеграцию с системным календарём к
// более поздней волне), здесь не рисуется.
struct TodayListView: View {
    let waitingTasks: [ApiTask]
    let overdueTasks: [ApiTask]
    let todayTasks: [ApiTask]
    let today: String
    let onOpen: (ApiTask) -> Void
    let onComplete: (ApiTask) -> Void
    let onReschedule: (ApiTask) -> Void
    let onDelete: (ApiTask) -> Void

    var body: some View {
        // Заголовки секций НЕ прилипают сами (`pinnedViews` убран 01.09.2026):
        // владелец попросил, чтобы название секции вставало не под шапкой, а
        // НА ту же линию, где стоят дата и кнопки. Поэтому заголовок едет с
        // лентой как обычная строка, публикуя свою координату; какой из них
        // сейчас «наверху», решает `TodayScreen` и показывает его в шапке
        // слева, на месте крупной даты.
        LazyVStack(alignment: .leading, spacing: 0) {
            if !waitingTasks.isEmpty {
                Section {
                    ForEach(waitingTasks) { task in
                        TodayTaskRow(task: task, overdue: task.dueDate != nil && task.dueDate! < today,
                                     onOpen: { onOpen(task) }, onComplete: { onComplete(task) },
                                     onReschedule: { onReschedule(task) }, onDelete: { onDelete(task) })
                    }
                } header: {
                    sectionHeader("Ждут вас", icon: "person.crop.circle.badge.clock", color: .tfText)
                }
            }
            if !overdueTasks.isEmpty {
                Section {
                    ForEach(overdueTasks) { task in
                        TodayTaskRow(task: task, overdue: true,
                                     onOpen: { onOpen(task) }, onComplete: { onComplete(task) },
                                     onReschedule: { onReschedule(task) }, onDelete: { onDelete(task) })
                    }
                } header: {
                    sectionHeader("Просрочено", color: .tfRed)
                }
            }
            Section {
                ForEach(todayTasks) { task in
                    TodayTaskRow(task: task, overdue: false,
                                 onOpen: { onOpen(task) }, onComplete: { onComplete(task) },
                                 onReschedule: { onReschedule(task) }, onDelete: { onDelete(task) })
                }
            } header: {
                // Дата — заголовок последней секции, но только когда выше уже
                // была секция: иначе она дублировала бы шапку экрана.
                if !todayTasks.isEmpty && (!overdueTasks.isEmpty || !waitingTasks.isEmpty) {
                    sectionHeader(TodayDate.formatDueLabel(today), color: .tfSub)
                }
            }
        }
    }

    private func sectionHeader(_ title: String, icon: String? = nil, color: Color) -> some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Color.tfText)
            }
            Text(title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(color)
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.top, TFSpacing.md)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Своей подложки больше нет: под шапку заголовок уходит целиком, а
        // гасит его подложка самой шапки. Вместо этого он сообщает наверх,
        // где сейчас находится, — по этой координате шапка и выбирает,
        // название какой секции показывать слева.
        .background {
            GeometryReader { geo in
                Color.clear.preference(
                    key: TodaySectionKey.self,
                    value: [TodaySectionMark(
                        title: title,
                        icon: icon,
                        color: color,
                        minY: geo.frame(in: .named(todayScrollSpace)).minY
                    )]
                )
            }
        }
    }
}

// MARK: - Какая секция сейчас наверху

/// Имя системы координат прокрутки «Сегодня»: в ней заголовки меряют, ушли ли
/// они под полосу шапки.
let todayScrollSpace = "today.scroll"

struct TodaySectionMark: Equatable {
    let title: String
    let icon: String?
    let color: Color
    let minY: CGFloat
}

enum TodaySectionKey: PreferenceKey {
    static let defaultValue: [TodaySectionMark] = []
    static func reduce(value: inout [TodaySectionMark], nextValue: () -> [TodaySectionMark]) {
        value.append(contentsOf: nextValue())
    }
}
