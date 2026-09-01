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
        // Заголовки секций прилипают к шапке: доехав до верха, «Ждут вас»
        // встаёт под шапкой, лента продолжает идти под ним, а следующий
        // заголовок («Просрочено») выталкивает предыдущий вверх и занимает
        // его место — обычное поведение списков iOS, владелец попросил
        // 01.09.2026. В SwiftUI это `pinnedViews` + `Section`, свои
        // измерения прокрутки не нужны.
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
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
        // Подложка — то же затухание, что у шапки, а не сплошная плашка
        // (владелец, 01.09.2026: «надо сделать прозрачный фон у этой
        // прилипалки… но чтобы текст гасился, а не прокручивался сквозь
        // надпись»). `FrostedGlass` размывает и притемняет ленту под
        // заголовком у верхней кромки и мягко сходит на нет к нижней —
        // строки уходят под него, а не сквозь.
        .background(FrostedGlass(axis: .top))
        // Заголовок чуть заходит под нижнюю, самую прозрачную кромку шапки —
        // владелец просил «пусть чуть-чуть наслаивается, главное чтобы на
        // текст не наслаивалось». Сдвиг визуальный (`offset`), поэтому
        // положение прилипания и высота секции не меняются.
        .offset(y: -6)
    }
}
