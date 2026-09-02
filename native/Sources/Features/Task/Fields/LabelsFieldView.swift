import SwiftUI

// `LabelsField` — spec/SCREENS-1.md §3.7. Свёрнутый вид не помещается в
// текстовое значение `TFFieldRow` (там пилюли меток, а не строка) — строка
// собрана вручную с той же геометрией (52pt высота, отступы `TFField`).
struct LabelsFieldView: View {
    let allLabels: [ApiLabel]
    @Binding var selectedIds: Set<String>
    @State private var isExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: TFField.iconTextGap) {
                    Image(systemName: "tag")
                        .font(.system(size: TFIconSize.sm))
                        .foregroundStyle(Color.tfDim)
                        .frame(width: TFIconSize.sm)
                    Text("Метки").tfText(.body).fontWeight(.medium).foregroundStyle(Color.tfText)
                    Spacer()
                    collapsedValue
                    Image(systemName: "chevron.right")
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                }
                .padding(.horizontal, TFField.cardInsetH)
                .frame(minHeight: TFField.height)
                .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())

            if isExpanded {
                TFFieldDivider()
                expandedCloud
                    .padding(.horizontal, TFField.cardInsetH)
                    .padding(.vertical, TFSpacing.md)
            }
        }
    }

    private var selectedLabels: [ApiLabel] { allLabels.filter { selectedIds.contains($0.id) } }

    @ViewBuilder
    private var collapsedValue: some View {
        if selectedLabels.isEmpty {
            Text("Нет").tfText(.body).foregroundStyle(Color.tfSub)
        } else {
            HStack(spacing: TFSpacing.xs) {
                ForEach(selectedLabels.prefix(2)) { label in
                    TFLabelPill(label.name, color: Color(hex: label.color ?? "#A6A6A6"))
                }
                if selectedLabels.count > 2 {
                    Text("+\(selectedLabels.count - 2)").tfText(.caption).foregroundStyle(Color.tfSub)
                }
            }
        }
    }

    @ViewBuilder
    private var expandedCloud: some View {
        if allLabels.isEmpty {
            Text("Нет доступных меток").tfText(.action).foregroundStyle(Color.tfSub)
        } else {
            // "Облако" пилюль — перенос по строкам, без фиксированной сетки.
            FlowLayout(spacing: TFSpacing.sm) {
                ForEach(allLabels) { label in
                    let isOn = selectedIds.contains(label.id)
                    Button {
                        if isOn { selectedIds.remove(label.id) } else { selectedIds.insert(label.id) }
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "tag.fill").font(.system(size: 10))
                            Text(label.name).tfText(.caption)
                            if isOn { Image(systemName: "checkmark").font(.system(size: 10)) }
                        }
                        .foregroundStyle(isOn ? Color.tfText : (label.color.map { Color(hex: $0) } ?? .tfSub))
                        .padding(.horizontal, TFSpacing.sm)
                        .padding(.vertical, 6)
                        .background((label.color.map { Color(hex: $0) } ?? .tfSub).opacity(isOn ? 0.32 : 0.15))
                        .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
                    }
                    .buttonStyle(TFTapScaleStyle())
                }
            }
        }
    }
}

/// Простой перенос по строкам (SwiftUI до 16 не имеет `Layout`-примитива для
/// «облака» из коробки в стабильном виде на всех версиях) — своя реализация
/// протокола `Layout`, минимальная, без зависимостей.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
