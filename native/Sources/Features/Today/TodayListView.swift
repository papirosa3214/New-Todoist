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

    private var sections: [TodaySectionInfo] {
        TodaySectionInfo.list(waiting: waitingTasks, overdue: overdueTasks, today: todayTasks, todayDate: today)
    }

    var body: some View {
        // Первый существующий подзаголовок рисует передний слой TodayScreen:
        // так он всегда находится НАД общей полупрозрачной подложкой. Остальные
        // заголовки едут в ленте и сообщают шапке свою позицию; когда очередной
        // доезжает наверх, шапка заменяет им текущий подзаголовок.
        LazyVStack(alignment: .leading, spacing: 0) {
            if !waitingTasks.isEmpty {
                Section {
                    ForEach(waitingTasks) { task in
                        TodayTaskRow(task: task, overdue: task.dueDate != nil && task.dueDate! < today,
                                     onOpen: { onOpen(task) }, onComplete: { onComplete(task) },
                                     onReschedule: { onReschedule(task) }, onDelete: { onDelete(task) })
                    }
                } header: {
                    header(.waiting)
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
                    header(.overdue)
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
                header(.today)
            }
        }
    }

    @ViewBuilder
    private func header(_ kind: TodaySectionKind) -> some View {
        let secs = sections
        if let index = secs.firstIndex(where: { $0.kind == kind }) {
            let info = secs[index]
            Group {
                if index == 0 {
                    // Первая подпись уже нарисована в TodayScreen над glow.
                    // Нулевая метка остаётся здесь только для геометрии.
                    Color.clear.frame(height: 0)
                } else {
                    HStack(spacing: 6) {
                        if let icon = info.icon {
                            Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Color.tfText)
                        }
                        Text(info.title)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(info.color)
                    }
                    .padding(.horizontal, TFSpacing.lg)
                    .padding(.top, 8)
                    .padding(.bottom, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background {
                GeometryReader { geo in
                    Color.clear.preference(
                        key: TodaySectionKey.self,
                        value: [TodaySectionMark(
                            title: info.title,
                            icon: info.icon,
                            color: info.color,
                            minY: geo.frame(in: .named(todayScrollSpace)).minY
                        )]
                    )
                }
            }
        }
    }
}

// MARK: - Состав секций

enum TodaySectionKind: Equatable { case waiting, overdue, today }

struct TodaySectionInfo: Equatable {
    let kind: TodaySectionKind
    let title: String
    let icon: String?
    let color: Color

    /// Единственное место, где решается состав и порядок секций.
    static func list(waiting: [ApiTask], overdue: [ApiTask], today: [ApiTask], todayDate: String) -> [TodaySectionInfo] {
        var result: [TodaySectionInfo] = []
        if !waiting.isEmpty {
            result.append(.init(kind: .waiting, title: "Ждут вас",
                                icon: "person.crop.circle.badge.clock", color: .tfText))
        }
        if !overdue.isEmpty {
            result.append(.init(kind: .overdue, title: "Просрочено", icon: nil, color: .tfRed))
        }
        if !today.isEmpty {
            result.append(.init(kind: .today, title: TodayDate.formatDueLabel(todayDate),
                                icon: nil, color: .tfSub))
        }
        return result
    }
}

// MARK: - Координаты секций для общей шапки

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
