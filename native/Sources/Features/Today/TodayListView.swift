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
    let onSectionBoundary: (TodaySectionInfo, CGFloat) -> Void

    private var sections: [TodaySectionInfo] {
        TodaySectionInfo.list(waiting: waitingTasks, overdue: overdueTasks, today: todayTasks, todayDate: today)
    }

    var body: some View {
        // Первый существующий подзаголовок рисует передний слой TodayScreen:
        // так он всегда находится НАД общей полупрозрачной подложкой. Остальные
        // заголовки едут в ленте и сообщают шапке свою позицию; когда очередной
        // доезжает наверх, шапка заменяет им текущий подзаголовок.
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
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
                    // Геометрическую метку для неё не публикуем: при
                    // виртуализации LazyVStack нулевая метка могла повторно
                    // появиться рядом с порогом и вернуть sticky-подпись с
                    // «Просрочено» обратно на «Ждут вас».
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
            // Каждая НЕ первая секция сама сообщает пересечение порога.
            // Это намеренно не PreferenceKey: внутри LazyVStack preference-
            // массив может на кадр стать пустым или потерять отдельный header,
            // из-за чего «Просрочено» не заменяло «Ждут вас».
            .onGeometryChange(for: CGFloat.self) { geo in
                geo.frame(in: .named(todayScrollSpace)).minY
            } action: { _, minY in
                if index > 0 { onSectionBoundary(info, minY) }
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

/// Редуктор переходов sticky-подзаголовка. Все реальные секции равноправны;
/// nil означает первую существующую секцию, которую рисует fallback шапки.
enum TodaySectionTracker {
    static func next(
        current: TodaySectionMark?,
        crossing: TodaySectionInfo,
        minY: CGFloat,
        sections: [TodaySectionInfo],
        threshold: CGFloat
    ) -> TodaySectionMark? {
        guard let boundaryIndex = sections.firstIndex(where: { $0.kind == crossing.kind }) else {
            return current
        }
        let currentIndex = current.flatMap { mark in
            sections.firstIndex(where: { $0.title == mark.title })
        } ?? 0

        if minY <= threshold {
            guard boundaryIndex >= currentIndex else { return current }
            return mark(crossing)
        }

        guard boundaryIndex == currentIndex else { return current }
        let previousIndex = boundaryIndex - 1
        return previousIndex > 0 ? mark(sections[previousIndex]) : nil
    }

    private static func mark(_ info: TodaySectionInfo) -> TodaySectionMark {
        TodaySectionMark(title: info.title, icon: info.icon, color: info.color, minY: 0)
    }
}
