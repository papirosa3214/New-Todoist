import SwiftUI

// `DueDateField` («Срок и время») — spec/SCREENS-1.md §3.7. Используется
// ТОЛЬКО формой (`TaskFormScreen`) — карточка задачи показывает срок как
// обычный текст в метаданных, без интерактивного поля.
struct DueDateFieldView: View {
    @Binding var dueDate: Date?
    /// Минуты от полуночи, `nil` — время не задано.
    @Binding var startMinutes: Int?
    /// `nil` — без длительности.
    @Binding var durationMin: Int?

    @State private var isExpanded = false

    private static let durationOptions: [(minutes: Int, label: String)] = [
        (15, "15м"), (30, "30м"), (45, "45м"), (60, "1ч"), (120, "2ч"), (180, "3ч"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            TFFieldRow(icon: "calendar", title: "Срок и время", value: collapsedValue) {
                withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded.toggle() }
            }
            if isExpanded {
                TFFieldDivider()
                VStack(alignment: .leading, spacing: TFSpacing.lg) {
                    quickButtons
                    MiniCalendarView(selectedDate: $dueDate)
                    timeSection
                    if dueDate != nil { durationSection }
                    if dueDate != nil { removeButton }
                }
                .padding(.horizontal, TFField.cardInsetH)
                .padding(.vertical, TFSpacing.lg)
            }
        }
        .onChange(of: dueDate == nil) { _, isNil in
            // При снятии даты обнуляется и время (сервер не принимает время без срока).
            if isNil { startMinutes = nil; durationMin = nil }
        }
    }

    private var collapsedValue: String {
        guard let dueDate else { return "Не установлен" }
        let label = TaskDateText.dueLabel(dueDate)
        guard let startMinutes else { return label }
        let hhmm = String(format: "%02d:%02d", startMinutes / 60, startMinutes % 60)
        return "\(label) · \(TaskDateText.timeRange(start: hhmm, durationMin: durationMin))"
    }

    private var quickButtons: some View {
        HStack(spacing: TFSpacing.sm) {
            quickButton("Сегодня") { dueDate = moscowStartOfDay(offsetDays: 0) }
            quickButton("Завтра") { dueDate = moscowStartOfDay(offsetDays: 1) }
        }
    }

    private func quickButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .tfText(.body)
                .fontWeight(.medium)
                .foregroundStyle(Color.tfText)
                .frame(maxWidth: .infinity)
                .frame(height: 40)
                .background(Color.tfCard2)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
        .buttonStyle(TFTapScaleStyle())
    }

    @ViewBuilder
    private var timeSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Во сколько").tfText(.action).foregroundStyle(Color.tfSub)
            if dueDate == nil {
                Text("сначала выберите день").tfText(.action).foregroundStyle(Color.tfDim)
            } else {
                // Штатный DatePicker (iOS 14+ .wheel) вместо самодельного
                // TimeWheelView с цилиндром и scrollTransition. Конверт
                // Int (минуты от полуночи) ↔ Date.
                DatePicker(
                    "Время",
                    selection: startTimeBinding,
                    displayedComponents: .hourAndMinute
                )
                .datePickerStyle(.wheel)
                .labelsHidden()
            }
        }
    }

    /// DatePicker работает с `Date` — конверт в `Int` минуты от полуночи.
    /// По умолчанию 09:00, пока пользователь ничего не выбрал (как было
    /// в TimeWheelView).
    private var startTimeBinding: Binding<Date> {
        Binding(
            get: {
                let m = startMinutes ?? 9 * 60
                return Calendar.current.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()) ?? Date()
            },
            set: { newDate in
                let comps = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                startMinutes = (comps.hour ?? 9) * 60 + (comps.minute ?? 0)
            }
        )
    }

    private var durationSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Продолжительность").tfText(.action).foregroundStyle(Color.tfSub)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TFSpacing.sm) {
                    ForEach(Self.durationOptions, id: \.minutes) { option in
                        durationChip(option)
                    }
                }
            }
        }
    }

    private func durationChip(_ option: (minutes: Int, label: String)) -> some View {
        let isSelected = durationMin == option.minutes
        return Button {
            durationMin = isSelected ? nil : option.minutes
        } label: {
            Text(option.label)
                .tfText(.action)
                .fontWeight(.medium)
                .foregroundStyle(isSelected ? .white : Color.tfText)
                .padding(.horizontal, TFSpacing.md)
                .padding(.vertical, TFSpacing.sm)
                .background(isSelected ? Color.tfRed : Color.tfCard2)
                .clipShape(Capsule())
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private var removeButton: some View {
        Button {
            dueDate = nil
        } label: {
            Text(startMinutes != nil ? "Убрать дату и время" : "Убрать дату")
                .tfText(.body)
                .foregroundStyle(Color.tfCoral)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(TFTapFadeStyle())
    }

    private func moscowStartOfDay(offsetDays: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TaskDateText.moscow
        let today = cal.startOfDay(for: Date())
        return cal.date(byAdding: .day, value: offsetDays, to: today) ?? today
    }
}
