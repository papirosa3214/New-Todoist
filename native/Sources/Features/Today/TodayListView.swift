import SwiftUI

// Вид «Список» — spec §5.1. Секции сверху вниз: «Ждут вас» → «Просрочено» →
// дата-заголовок (только если выше уже была секция) → задачи на сегодня.
// `AppleCalendarEvents` (события календаря устройства) — вне спеки Волны 1
// (`spec/NATIVE-PARTS.md` относит интеграцию с системным календарём к
// более поздней волне), здесь не рисуется.
struct TodayListView: View {
    /// Зазор после затухающей плашки: первая строка не должна начинаться прямо
    /// под её хвостом, иначе цвет проекта выглядит выцветшим уже в покое.
    private static let sectionContentTopInset: CGFloat = 16

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
        // Настоящее прилипание штатным `pinnedViews`: первый существующий
        // подзаголовок уже на первом кадре вплотную примыкает к «Вторнику»,
        // а при прокрутке паркуется под компактной шапкой и выталкивается
        // следующим. Никаких координат и подмены текста в шапке нет.
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
            if !waitingTasks.isEmpty {
                Section {
                    Color.clear.frame(height: Self.sectionContentTopInset)
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
                    Color.clear.frame(height: Self.sectionContentTopInset)
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
                Color.clear.frame(height: Self.sectionContentTopInset)
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
            HStack(spacing: 6) {
                if let icon = info.icon {
                    Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Color.tfText)
                }
                Text(info.title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(info.color)
            }
            .padding(.horizontal, TFSpacing.lg)
            // Без верхнего отступа: первый заголовок образует с большим днём
            // недели единый стартовый блок, а припаркованный остаётся вплотную
            // под компактной датой.
            .padding(.top, 2)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Затухание — здесь, у подзаголовка (просьба владельца): плотная
            // часть под самой надписью, а ниже неё хвост, в котором строка
            // мягко уходит под заголовок. У шапки хвоста нет.
            .background(alignment: .top) {
                // Сильный blur начинается ещё в зоне подзаголовка, а не после
                // пустого отступа: лента под ним быстро становится мутной и
                // затем растворяется. Высота 58pt вместе с 16pt inset ниже
                // оставляет первой синей строке уже чистый фон.
                FrostedGlass(axis: .top)
                    .frame(height: 58)
                    .padding(.bottom, -24)
            }
            // При pinnedViews фон заголовка должен лежать поверх уезжающих
            // строк, иначе blur остаётся только декоративным фоном позади них.
            .zIndex(1)
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
        if !today.isEmpty && !result.isEmpty {
            result.append(.init(kind: .today, title: TodayDate.formatDueLabel(todayDate),
                                icon: nil, color: .tfSub))
        }
        return result
    }
}
