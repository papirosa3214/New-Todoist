import SwiftUI

// Полоска чипов под шапкой — spec §3.10 `PlannerProjectChips`. Неснимаемый
// чип «Входящие» + чипы видимых проектов (тап пока ничего не делает — то
// же в вебе, `onRemove` не подключён) + «+ проект» → открывает фильтры с
// раскрытой секцией «Показывать в разделе».
struct PlannerProjectChips: View {
    let projects: [ApiProject]
    let visibleProjectIds: [String: Bool]
    let onAdd: () -> Void

    private var visible: [ApiProject] {
        projects.filter { visibleProjectIds[$0.id] == true }
    }

    var body: some View {
        if !visible.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TFSpacing.sm) {
                    chip(title: "Входящие", color: .tfSub, filled: false)
                    ForEach(visible) { project in
                        chip(title: project.name, color: Color(hex: project.color ?? "#A6A6A6"), filled: true)
                    }
                    Button(action: onAdd) {
                        Text("+ проект")
                            .tfText(.caption)
                            .foregroundStyle(Color.tfSub)
                            .padding(.horizontal, TFSpacing.sm)
                            .padding(.vertical, 6)
                            .overlay {
                                RoundedRectangle(cornerRadius: TFRadius.full)
                                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                                    .foregroundStyle(Color.tfStroke)
                            }
                    }
                }
                .padding(.horizontal, TFSpacing.lg)
            }
            .padding(.vertical, TFSpacing.sm)
        }
    }

    private func chip(title: String, color: Color, filled: Bool) -> some View {
        Text(title)
            .tfText(.caption)
            .foregroundStyle(filled ? color : Color.tfSub)
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, 6)
            .background(filled ? color.opacity(0.15) : Color.tfCard2)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.full))
    }
}
