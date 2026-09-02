import SwiftUI
import UIKit

// Строка задачи со свайпом — spec/SCREENS-1.md §3.3 + живой `TaskRow.tsx`.
//
// НЕ переиспользует `TFTaskRow` из DesignSystem целиком: тот не умеет
// свайп (влево — «Изменить», вправо — «Удалить») и рисует «Просрочено» БЕЗ
// даты, а живой веб-код (TaskRow.tsx, строка ~549) печатает «Просрочено,
// {formatDueLabel}» — точность спеки важнее переиспользования здесь.
// Мелкие бейджи-примитивы (TFPill/TFPriorityFlag/TFAvatar/цвета) взяты из
// DesignSystem как есть. В отчёте — оркестратору свести оба варианта.
struct TodayTaskRow: View {
    let task: ApiTask
    /// TodayScreen передаёт true для просроченных задач — красная пилюля с датой
    /// вместо обычного бейджа срока (spec: `overdue` проп TaskRow.tsx).
    let overdue: Bool
    let onOpen: () -> Void
    let onComplete: () -> Void
    let onReschedule: () -> Void
    let onDelete: () -> Void

    private let actionWidth: CGFloat = 84
    /// Пороги открытия/закрытия — числа веб-хука `useRowSwipe.ts`.
    private let openThreshold: CGFloat = 36
    private let openVelocity: CGFloat = 280
    private let closeThreshold: CGFloat = 25
    private let closeVelocity: CGFloat = 250
    /// Точка покоя строки: 0 (закрыта), −actionWidth («Завершить» открыта),
    /// −2×actionWidth («Завершить» + «Перенести»), +actionWidth («Удалить»).
    @State private var settledOffset: CGFloat = 0
    @State private var dragOffset: CGFloat = 0
    @State private var confirmDelete = false

    private var offsetX: CGFloat { clamp(settledOffset + dragOffset) }

    var body: some View {
        ZStack {
            // ═══ Действия под строкой ═══
            //
            // Веб (`TaskRow.tsx`, `setRowPosition`) делает три вещи, которых
            // здесь не было, и владелец назвал все три (01.09.2026):
            //
            // 1. Кнопка РАСТЁТ вместе с пальцем: `btnW = max(absX, ACTION_W)`.
            //    Было — фиксированные 84pt, и кнопка выглядела «гораздо меньше
            //    самой карточки».
            // 2. Кнопка ПРОЯВЛЯЕТСЯ по ходу жеста: `opacity = min(1, progress×1.3)`.
            //    Было — `opacity(offsetX > 0 ? 1 : 0)`, то есть «появляется
            //    сразу, а не плавно вылазит».
            // 3. Кнопка занимает ВСЮ высоту строки (`top: 0; bottom: 0`).
            //    Было — фиксированные 70pt независимо от содержимого строки.
            HStack(spacing: 0) {
                actionButton(
                    icon: "trash", label: "Удалить",
                    identifier: "row.swipe.delete", color: .tfSwipeDelete
                ) { close(); confirmDelete = true }
                .frame(width: leftRevealWidth)
                .opacity(revealOpacity(leftRevealWidth))

                Spacer(minLength: 0)

                actionButton(
                    icon: "calendar", label: "Перенести",
                    identifier: "row.swipe.reschedule", color: .tfOrange
                ) { close(); onReschedule() }
                .frame(width: rightRevealWidth / 2)
                .opacity(revealOpacity(rightRevealWidth))

                actionButton(
                    icon: "checkmark", label: "Завершить",
                    identifier: "row.swipe.complete", color: .tfGreen
                ) { close(); onComplete() }
                .frame(width: rightRevealWidth / 2)
                .opacity(revealOpacity(rightRevealWidth))
            }
            .frame(maxHeight: .infinity)

            row
                // Непрозрачный фон — веб `className="bg-bg"` на строке. Без
                // него текст задачи читался ПОВЕРХ цветной кнопки, когда
                // строка над ней проезжала (владелец: «текст накладывается
                // на цветную кнопку»).
                .background(Color.tfBackground)
                .offset(x: offsetX)
                // Свайп ловит UIKit-распознаватель, а не DragGesture: любой
                // собственный SwiftUI-жест внутри ScrollView забирает касание
                // себе, и список перестаёт листаться пальцем по задаче
                // (владелец, 01.09.2026, третий заход: «скролла нет»).
                // Подробности и числа — HorizontalPan.swift.
                .gesture(
                    HorizontalPan(
                        onBegin: { UIImpactFeedbackGenerator(style: .soft).impactOccurred() },
                        onChange: { dx in dragOffset = dx },
                        onEnd: { dx, velocity in settle(dx: dx, velocity: velocity) }
                    )
                )
        }
        .clipped()
        // Разделитель под строкой — веб `border-b border-stroke/50`.
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.tfStroke.opacity(0.5))
                .frame(height: TFBorder.width)
        }
        .confirmationDialog("Удалить задачу?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Удалить", role: .destructive, action: onDelete)
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("«\(task.title)» будет удалена безвозвратно")
        }
    }

    /// Насколько раскрыт левый край (кнопка «Удалить») — прямо за пальцем.
    private var leftRevealWidth: CGFloat { max(offsetX, 0) }
    /// То же для правого края: там две кнопки, делят раскрытие пополам.
    private var rightRevealWidth: CGFloat { max(-offsetX, 0) }

    /// Проявление кнопки по ходу жеста. Веб: `min(1, (absX / ACTION_W) × 1.3)`
    /// — к трети ширины кнопка уже читается, дальше просто растёт.
    private func revealOpacity(_ width: CGFloat) -> Double {
        min(1, Double(width / actionWidth) * 1.3)
    }

    private func actionButton(
        icon: String, label: String, identifier: String, color: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: TFIconSize.md))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(color)
        }
        .buttonStyle(.plain)
        // Иконка не должна вылезать за узкую кнопку в начале жеста.
        .clipped()
        // Кнопка доступна для нажатия, только когда раскрыта заметно —
        // веб: `pointerEvents = absX >= ACTION_W * 0.7 ? "auto" : "none"`.
        .allowsHitTesting(abs(offsetX) >= actionWidth * 0.7)
        .accessibilityHidden(abs(offsetX) < actionWidth * 0.7)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }

    private var row: some View {
        Button {
            if settledOffset != 0 {
                close()
            } else {
                onOpen()
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                if let projectName = task.projectName {
                    HStack(spacing: 3) {
                        Image(systemName: "number")
                            .font(.system(size: 10))
                        Text(projectName)
                    }
                    .tfText(.caption)
                    .foregroundStyle(Color(hex: task.projectColor ?? "#A6A6A6"))
                    .lineLimit(1)
                }

                HStack(spacing: TFSpacing.sm) {
                    if let initials = task.assigneeInitials, task.assigneeId != nil {
                        TFAvatar(size: .sm, initials: initials, tint: Color(hex: task.assigneeColor ?? "#A6A6A6"))
                    }
                    Text(task.title)
                        .tfText(.body)
                        .foregroundStyle(task.status == .completed ? Color.tfSub : Color.tfText)
                        .strikethrough(task.status == .completed)
                        .lineLimit(1)
                }

                if let description = task.description, !description.isEmpty {
                    Text(description)
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                        .lineLimit(2)
                }

                if let agentText = TodayAgentStateTag.text(task) {
                    Text(agentText)
                        .tfText(.meta)
                        .foregroundStyle(TodayAgentStateTag.color(task))
                }

                if hasBadges {
                    HStack(spacing: TFSpacing.xs) {
                        if !task.subtasks.isEmpty {
                            let done = task.subtasks.count { $0.done }
                            TFPill("\(done)/\(task.subtasks.count)", color: .tfSub, solidBackground: .tfCard)
                        }
                        if task.priority <= 3, let priority = TaskPriority(rawValue: task.priority) {
                            TFPriorityFlag(priority)
                        }
                        if overdue, let due = task.dueDate {
                            TFPill("Просрочено, \(TodayDate.formatDueLabel(due))", color: .tfRed, backgroundOpacity: 0.15)
                        } else if let due = task.dueDate {
                            HStack(spacing: 3) {
                                Text(TodayDate.formatDuePlain(due))
                                Text("· \(TodayDate.formatDaysLeft(due))")
                                    .foregroundStyle(TodayDate.daysUntil(due) <= 3 ? Color.tfOrange : Color.tfDim)
                            }
                            .tfText(.caption)
                            .foregroundStyle(Color.tfSub)
                            .padding(.horizontal, TFSpacing.sm)
                            .padding(.vertical, 2)
                            .background(Color.tfCard)
                            .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
                        }
                        ForEach(task.labels, id: \.id) { label in
                            TFLabelPill(label.name, color: Color(hex: label.color ?? "#A6A6A6"))
                        }
                    }
                }
            }
            .padding(.top, 9)
            .padding(.bottom, 12)
            .padding(.horizontal, TFSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
        // ⚠️ Порядок важен: `accessibilityElement(children:)` создаёт НОВЫЙ
        // элемент и отбрасывает всё, что задано до него, — идентификатор,
        // поставленный выше, молча пропадал, и тесты не находили строку.
        // Сначала собираем элемент, потом даём ему имя и идентификатор.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(rowAccessibilityLabel)
        .accessibilityIdentifier("today.task-row")
        // Строка ЯВЛЯЕТСЯ кнопкой, но `children: .ignore` собирает новый
        // элемент и трейт кнопки при этом теряется: в дереве строка
        // становится «Other», VoiceOver не говорит «кнопка», а тесты её не
        // находят среди `app.buttons`. Трейт возвращаем руками.
        .accessibilityAddTraits(.isButton)
    }

    private var hasBadges: Bool {
        !task.subtasks.isEmpty || task.priority <= 3 || overdue || task.dueDate != nil || !task.labels.isEmpty
    }

    /// Короткое имя для VoiceOver: название задачи, опционально проект.
    /// Без проекта и бейджей — одна строка; с проектом — «Проект, Задача».
    private var rowAccessibilityLabel: String {
        if let projectName = task.projectName, !projectName.isEmpty {
            return "\(projectName), \(task.title)"
        }
        return task.title
    }

    private func close() {
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            settledOffset = 0
            dragOffset = 0
        }
    }

    /// Куда строка встаёт после жеста. Числа — из веба (`useRowSwipe.ts`):
    /// открытие при сдвиге >36px ИЛИ броске >280px/с, закрытие встречным
    /// движением >25px или >250px/с, «резина» за пределом — в `clamp`.
    ///
    /// Скорость здесь настоящая, от UIKit (px/с). Раньше она бралась как
    /// `predictedEndTranslation − translation` у SwiftUI-жеста — это НЕ px/с,
    /// а прогноз доката в пикселях, и сравнение с веб-порогом 280 срабатывало
    /// невпопад: бросок открывал строку через раз.
    private func settle(dx: CGFloat, velocity: CGFloat) {
        let finalOffset = clamp(settledOffset + dx)
        withAnimation(.timingCurve(0.2, 0.9, 0.28, 1, duration: 0.28)) {
            if settledOffset == 0 {
                // Влево открываются ОБЕ правые кнопки сразу — так ведёт себя
                // родная «Почта» и так честнее: раньше лёгкий свайп давал одну
                // кнопку, сильный вторую, и переход между ступенями дёргался.
                if finalOffset < -openThreshold || velocity < -openVelocity {
                    settledOffset = -2 * actionWidth
                } else if finalOffset > openThreshold || velocity > openVelocity {
                    settledOffset = actionWidth
                } else {
                    settledOffset = 0
                }
            } else if settledOffset < 0 {
                // Открыто — закрываем встречным движением.
                settledOffset = (dx > closeThreshold || velocity > closeVelocity) ? 0 : -2 * actionWidth
            } else {
                settledOffset = (dx < -closeThreshold || velocity < -closeVelocity) ? 0 : actionWidth
            }
            dragOffset = 0
        }
    }

    /// «Резина» за пределом раскрытия — веб: `W + over × 30 / (30 + over)`.
    /// Предел разный по сторонам: слева одна кнопка, справа две.
    private func clamp(_ raw: CGFloat) -> CGFloat {
        let limit = raw > 0 ? actionWidth : 2 * actionWidth
        if raw > limit {
            let over = raw - limit
            return limit + (over * 30) / (30 + over)
        } else if raw < -limit {
            let over = -raw - limit
            return -limit - (over * 30) / (30 + over)
        }
        return raw
    }
}

// RowHeightKey был удалён вместе с GeometryReader — измерение высоты через
// PreferenceKey вызывало двойной рендер (открытие «Сегодня» 2.44с вместо <2с).
// Высота кнопок свайпа больше не измеряется вовсе: они растягиваются на
// высоту ZStack (`frame(maxHeight: .infinity)`), которую задаёт сама строка,
// — как в вебе, где кнопка прибита `top: 0; bottom: 0`.
