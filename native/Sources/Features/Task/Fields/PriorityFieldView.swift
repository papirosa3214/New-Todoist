import SwiftUI

// `PriorityField` — spec/SCREENS-1.md §3.7. Свёрнутый вид: `FieldRow` с
// флажком цвета текущего приоритета + название тем же цветом (без пилюли).
// Разворачивается ВНУТРИ карточки (аккордеон, не отдельная шторка — так же,
// как остальные поля `TaskFields.tsx`) в список из 4 вариантов: кружок P1–P4
// цветом приоритета + название + галочка у выбранного. Выбор сворачивает
// панель обратно — в спеке явно не сказано, но это стандартное поведение
// одиночного выбора во всех похожих полях проекта (допущение, отмечено в отчёте).
struct PriorityFieldView: View {
    @Binding var priority: TaskPriority
    @State private var isExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            TFFieldRow(icon: "flag", title: "Приоритет", value: priority.label, valueColor: priority.color) {
                withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded.toggle() }
            }
            if isExpanded {
                TFFieldDivider()
                VStack(spacing: 0) {
                    ForEach(TaskPriority.allCases, id: \.rawValue) { option in
                        optionRow(option)
                        if option != TaskPriority.allCases.last {
                            TFFieldDivider()
                        }
                    }
                }
                .padding(.vertical, TFSpacing.xs)
            }
        }
    }

    private func optionRow(_ option: TaskPriority) -> some View {
        Button {
            priority = option
            withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded = false }
        } label: {
            HStack(spacing: TFField.iconTextGap) {
                Circle()
                    .strokeBorder(option.color, lineWidth: 1.5)
                    .background(Circle().fill(option.color.opacity(0.15)))
                    .frame(width: 22, height: 22)
                    .overlay {
                        Text("P\(option.rawValue)")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(option.color)
                    }
                Text(option.label).tfText(.body).foregroundStyle(Color.tfText)
                Spacer()
                if option == priority {
                    Image(systemName: "checkmark")
                        .tfText(.input)
                        .foregroundStyle(Color.tfRed)
                }
            }
            .padding(.horizontal, TFField.cardInsetH)
            .frame(minHeight: TFField.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }
}
