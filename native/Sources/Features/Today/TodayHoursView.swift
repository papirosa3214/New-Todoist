import SwiftUI
import Combine

// Вид «Один день» — spec/SCREENS-1.md §3.5/§5.1, порт `DayHours.tsx`.
//
// Упрощено относительно веба (честно, не «телепортация»):
// - «липкий» пул задач без времени сделан как ПОСТОЯННО видимая полоса над
//   сеткой (не CSS sticky-после-прокрутки) — тот же результат («пул всегда
//   на глазах»), проще геометрия на native;
// - фон-«хвост» часовых линий после полуночи — фиксировано 5 декоративных
//   строк (веб замеряет точный остаток места под кнопкой; здесь константа,
//   см. `TodayHoursMetrics.decorativeHoursBelow`);
// - точка захвата плашки при перетаскивании — всегда «под пальцем», без
//   вычисления смещения от исходной позиции (в вебе есть для плашек на
//   сетке, у пула и так 0) — упрощение, не влияет на итоговое время;
// - виброотклик на пересечение часа/деления не реализован (нет прямого
//   аналога дискретного «нотч»-фидбека без Core Haptics-обвязки в общем коде).
struct TodayHoursView: View {
    let day: TodayHourDay
    /// Цвет плашки — по проекту задачи (та же логика, что в списке/доске).
    let projectColor: (ApiTask) -> Color
    let onOpenTask: (String) -> Void
    let onSchedule: (String, String, String) -> Void
    let onPrevDay: () -> Void
    let onNextDay: () -> Void

    private struct DragState {
        let taskID: String
        let title: String
        let color: Color
        let height: CGFloat
        var y: CGFloat
    }

    @State private var dragState: DragState?
    @State private var previewTime: String?
    @State private var gridFrame: CGRect = .zero

    private var untimed: [ApiTask] {
        day.tasks.filter { hoursFromTime($0.startTime) == nil }
    }
    private var placedBlocks: [TodayPlacedBlock] { layoutHoursDay(day.tasks) }
    private let totalHours = TodayHoursMetrics.hoursCount + TodayHoursMetrics.decorativeHoursBelow

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            if !untimed.isEmpty {
                untimedPool
            }

            ScrollViewReader { proxy in
                ScrollView {
                    gridBody
                }
                .task {
                    // Прокрутка к текущему часу при открытии — запас ~120pt сверху
                    // достигается якорем на 3 часа раньше текущего (≈124pt).
                    guard day.isToday else { return }
                    let anchorHour = max(0, Calendar.current.component(.hour, from: Date()) - 3)
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    withAnimation(nil) {
                        proxy.scrollTo("hour-\(anchorHour)", anchor: .top)
                    }
                }
            }

            if placedBlocks.isEmpty {
                Text("На время пока ничего не назначено")
                    .tfText(.meta)
                    .foregroundStyle(Color.tfDim)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .coordinateSpace(name: "hoursGrid")
    }

    // MARK: - Пул задач без времени

    private var untimedPool: some View {
        VStack(spacing: 0) {
            ForEach(Array(untimed.enumerated()), id: \.element.id) { index, task in
                if index > 0 {
                    TFDivider(dimmed: false)
                }
                untimedRow(task)
            }
        }
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        .tfShadow(TFShadow.dropdown)
        .frame(maxHeight: 132)
    }

    private func untimedRow(_ task: ApiTask) -> some View {
        HStack(spacing: TFSpacing.sm) {
            if task.priority <= 3, let priority = TaskPriority(rawValue: task.priority) {
                TFPriorityFlag(priority)
            }
            if !task.subtasks.isEmpty {
                let done = task.subtasks.count { $0.done }
                Text("\(done)/\(task.subtasks.count)")
                    .tfText(.caption)
                    .foregroundStyle(Color.tfDim)
            }
            Text(task.title)
                .tfText(.action)
                .foregroundStyle(task.status == .completed ? Color.tfSub : Color.tfText)
                .strikethrough(task.status == .completed)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.leading, TFSpacing.md)
        .padding(.trailing, TFSpacing.md)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .opacity(dragState?.taskID == task.id ? 0.3 : 1)
        .gesture(dragGesture(for: task, height: TodayHoursMetrics.minH))
        .onTapGesture { if dragState == nil { onOpenTask(task.id) } }
    }

    // MARK: - Сетка часов

    private var gridBody: some View {
        HStack(alignment: .top, spacing: 0) {
            // Левая колонка — подписи часов, без линии под ними.
            ZStack(alignment: .topLeading) {
                ForEach(0..<totalHours, id: \.self) { h in
                    Text(cycleLabel(h))
                        .tfText(.micro)
                        .foregroundStyle(Color.tfDim)
                        .frame(width: TodayHoursMetrics.gutterW, alignment: .trailing)
                        .id(h == TodayHoursMetrics.hoursCount ? "hour-24" : "hour-\(h)")
                        .offset(y: CGFloat(h) * TodayHoursMetrics.hourH - 6)
                }
            }
            .frame(width: TodayHoursMetrics.gutterW, height: CGFloat(totalHours) * TodayHoursMetrics.hourH, alignment: .topLeading)

            // Область сетки — часовые линии, плашки, линия «сейчас», превью перетаскивания.
            GeometryReader { geo in
                ZStack(alignment: .topLeading) {
                    // Часовые линии — только в пределах реальных суток (0...24), дальше фон декоративный.
                    ForEach(0...TodayHoursMetrics.hoursCount, id: \.self) { h in
                        Rectangle()
                            .fill(Color.tfStroke)
                            .frame(height: TFBorder.width)
                            .offset(y: CGFloat(h) * TodayHoursMetrics.hourH)
                    }

                    ForEach(placedBlocks) { block in
                        timedBlockView(block, availableWidth: geo.size.width)
                    }

                    if day.isToday {
                        TodayNowLine(hourH: TodayHoursMetrics.hourH, gutterW: 0)
                    }

                    if let preview = previewTime, let minutes = minutesFrom(preview) {
                        previewLine(at: CGFloat(minutes) / 60 * TodayHoursMetrics.hourH, text: preview)
                    }
                }
                .frame(width: geo.size.width, height: CGFloat(totalHours) * TodayHoursMetrics.hourH, alignment: .topLeading)
                .contentShape(Rectangle())
                .gesture(daySwipeGesture)
                .onAppear { gridFrame = geo.frame(in: .named("hoursGrid")) }
                .onChange(of: geo.size) { _, _ in gridFrame = geo.frame(in: .named("hoursGrid")) }
            }
            .frame(height: CGFloat(totalHours) * TodayHoursMetrics.hourH)
        }
        .overlay(alignment: .topLeading) {
            if let dragState {
                ghostView(dragState)
                    .offset(x: TodayHoursMetrics.gutterW, y: dragState.y - dragState.height / 2)
                    .allowsHitTesting(false)
            }
        }
    }

    private func minutesFrom(_ hhmm: String) -> Int? {
        let parts = hhmm.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2 else { return nil }
        return parts[0] * 60 + parts[1]
    }

    private func timedBlockView(_ block: TodayPlacedBlock, availableWidth: CGFloat) -> some View {
        let usable = max(0, availableWidth - TodayHoursMetrics.rightInset)
        let totalGap = CGFloat(block.columns - 1) * TodayHoursMetrics.colGap
        let width = block.columns > 0 ? (usable - totalGap) / CGFloat(block.columns) : usable
        let left = CGFloat(block.colIndex) * (width + TodayHoursMetrics.colGap)
        let color = projectColor(block.task)
        let done = block.task.status == .completed
        let hidden = dragState?.taskID == block.task.id

        return Text(block.task.title)
            .tfText(.meta)
            .foregroundStyle(todayChipInk)
            .strikethrough(done)
            .opacity(done ? 0.7 : 1)
            .lineLimit(max(1, Int((block.height - 8) / 16)))
            .multilineTextAlignment(.leading)
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, 4)
            .frame(width: width, height: block.height, alignment: .topLeading)
            .background(color)
            .mask(
                block.durKnown
                    ? AnyView(Rectangle())
                    : AnyView(LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom))
            )
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.sm))
            .opacity(hidden ? 0 : 1)
            .position(x: left + width / 2, y: block.top + block.height / 2)
            .gesture(dragGesture(for: block.task, height: block.height))
            .onTapGesture { if dragState == nil { onOpenTask(block.task.id) } }
    }

    private func ghostView(_ state: DragState) -> some View {
        Text(state.title)
            .tfText(.meta)
            .foregroundStyle(todayChipInk)
            .lineLimit(max(1, Int((state.height - 8) / 16)))
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, 4)
            .frame(width: 160, height: state.height, alignment: .topLeading)
            .background(state.color)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.sm))
            .shadow(color: .black.opacity(0.5), radius: 12, x: 0, y: 6)
            .scaleEffect(1.015)
    }

    private func previewLine(at y: CGFloat, text: String) -> some View {
        HStack(spacing: 0) {
            Rectangle().fill(Color.tfRed.opacity(0.7)).frame(height: 1.5)
        }
        .overlay(alignment: .leading) {
            Text(text)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(Color.tfRed)
                .padding(.horizontal, 2)
                .background(Color.tfBackground)
                .offset(x: -TodayHoursMetrics.gutterW)
        }
        .offset(y: y)
    }

    // MARK: - Перетаскивание (long-press+drag было бы точнее вебу, но конфликтует
    // с ScrollView на native без доп. обвязки — минимальный сдвиг 12pt отличает
    // жест от тапа и от вертикальной прокрутки достаточно надёжно).

    private func dragGesture(for task: ApiTask, height: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .named("hoursGrid"))
            .onChanged { value in
                let y = value.location.y - gridFrame.minY
                let color = projectColor(task)
                if dragState?.taskID != task.id {
                    dragState = DragState(taskID: task.id, title: task.title, color: color, height: max(TodayHoursMetrics.minH, height), y: y)
                } else {
                    dragState?.y = y
                }
                previewTime = timeFromOffset(y)
            }
            .onEnded { value in
                let y = value.location.y - gridFrame.minY
                dragState = nil
                previewTime = nil
                guard y >= -TodayHoursMetrics.hourH else { return }
                onSchedule(task.id, day.date, timeFromOffset(y))
            }
    }

    // MARK: - Горизонтальный свайп между днями (порог 45px, spec §3.5).

    private var daySwipeGesture: some Gesture {
        DragGesture(minimumDistance: 20, coordinateSpace: .local)
            .onEnded { value in
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) > abs(dy) * 1.3, abs(dx) >= 45 else { return }
                if dx < 0 { onNextDay() } else { onPrevDay() }
            }
    }
}

/// Линия «сейчас» — красная, через всю сетку, пересчитывается раз в минуту (spec §3.5).
private struct TodayNowLine: View {
    let hourH: CGFloat
    let gutterW: CGFloat
    @State private var now = Date()

    var body: some View {
        let comps = Calendar.current.dateComponents([.hour, .minute], from: now)
        let pos = CGFloat(comps.hour ?? 0) + CGFloat(comps.minute ?? 0) / 60
        HStack(spacing: 4) {
            Circle().fill(Color.tfRed).frame(width: 7, height: 7)
            Rectangle().fill(Color.tfRed).frame(height: 1.5)
        }
        .overlay(alignment: .leading) {
            Text(now.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)))
                .tfText(.micro)
                .foregroundStyle(Color.tfRed)
                .background(Color.tfBackground)
                .offset(x: -TodayHoursMetrics.gutterW)
        }
        .offset(y: pos * hourH)
        .onReceive(Timer.publish(every: 60, on: .main, in: .common).autoconnect()) { now = $0 }
    }
}
