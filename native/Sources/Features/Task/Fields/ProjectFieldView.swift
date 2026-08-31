import SwiftUI

// `FieldRow «Проект»` — spec/SCREENS-1.md §5.5: раскрывающийся picker,
// пусто → «Проектов пока нет». Тот же аккордеон-паттерн, что у `PriorityField`.
struct ProjectFieldView: View {
    let projects: [ApiProject]
    @Binding var selectedProjectId: String?
    @State private var isExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            TFFieldRow(icon: "number", title: "Проект", value: selectedName) {
                withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded.toggle() }
            }
            if isExpanded {
                TFFieldDivider()
                if projects.isEmpty {
                    Text("Проектов пока нет")
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                        .padding(.horizontal, TFField.cardInsetH)
                        .padding(.vertical, TFSpacing.md)
                } else {
                    VStack(spacing: 0) {
                        optionRow(name: "Без проекта", color: nil, isSelected: selectedProjectId == nil) {
                            selectedProjectId = nil
                        }
                        ForEach(projects) { project in
                            TFFieldDivider()
                            optionRow(
                                name: project.name,
                                color: project.color.map { Color(hex: $0) },
                                isSelected: selectedProjectId == project.id
                            ) {
                                selectedProjectId = project.id
                            }
                        }
                    }
                    .padding(.vertical, TFSpacing.xs)
                }
            }
        }
        .onChange(of: selectedProjectId) { _, _ in
            withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded = false }
        }
    }

    private var selectedName: String {
        guard let selectedProjectId else { return "Без проекта" }
        return projects.first { $0.id == selectedProjectId }?.name ?? "Без проекта"
    }

    private func optionRow(name: String, color: Color?, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: TFField.iconTextGap) {
                Circle().fill(color ?? Color.tfDim).frame(width: 8, height: 8)
                Text(name).tfText(.body).foregroundStyle(Color.tfText)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(Color.tfRed)
                }
            }
            .padding(.horizontal, TFField.cardInsetH)
            .frame(minHeight: TFField.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }
}
