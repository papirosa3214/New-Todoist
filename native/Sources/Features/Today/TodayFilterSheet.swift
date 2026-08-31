import SwiftUI

// Содержимое шторки фильтров — spec §3.9 `TaskFilterSheet`. Подключается
// модификатором `.tfBottomSheet(isPresented:)` из `TodayScreen` (та же
// шторка-обёртка, что и у всех остальных экранов — хендл/крестик/скругление).
//
// Заголовок и «Сбросить» собраны вручную, а не через встроенные
// `title`/`actionTitle` `tfBottomSheet` — той версии не хватает состояния
// «неактивна, если ничего не выбрано» для правой кнопки, а спека его
// требует буквально.
struct TodayFilterSheetContent: View {
    @Binding var filters: TodayTaskFilters
    let onClose: () -> Void
    let projectOptions: [TodayFilterOption]
    let labelOptions: [TodayFilterOption]
    let assigneeOptions: (list: [TodayAssigneeOption], hasUnassigned: Bool)
    let allProjects: [ApiProject]
    let visibleProjectIds: [String: Bool]
    let onTogglePlannerProject: (String) -> Void
    /// Секция «Показывать в разделе» открыта сразу — когда шторку открыли через «+ проект».
    var openPlannerSection = false

    @State private var expanded: Set<String> = []

    var body: some View {
        VStack(spacing: TFSpacing.lg) {
            HStack {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 18)).foregroundStyle(Color.tfText)
                }
                .frame(width: 44, height: 44)
                Spacer()
                Text("Фильтры").tfText(.title).foregroundStyle(Color.tfText)
                Spacer()
                Button("Сбросить") { filters = .empty }
                    .font(.system(size: 13))
                    .foregroundStyle(filters.isActive ? Color.tfRed : Color.tfDim)
                    .disabled(!filters.isActive)
                    .frame(width: 44, height: 44)
            }

            section(id: "project", title: "Проект") {
                optionRow(title: "Все проекты", selected: filters.projectId == nil) { filters.projectId = nil }
                if projectOptions.isEmpty {
                    emptyRow("Нет задач с проектом")
                } else {
                    ForEach(projectOptions) { option in
                        optionRow(title: option.label, color: option.color, selected: filters.projectId == option.id) {
                            filters.projectId = option.id
                        }
                    }
                }
            }

            section(id: "label", title: "Метка") {
                optionRow(title: "Все метки", selected: filters.labelId == nil) { filters.labelId = nil }
                if labelOptions.isEmpty {
                    emptyRow("Нет задач с метками")
                } else {
                    ForEach(labelOptions) { option in
                        optionRow(title: option.label, color: option.color, selected: filters.labelId == option.id) {
                            filters.labelId = option.id
                        }
                    }
                }
            }

            section(id: "assignee", title: "Исполнитель") {
                optionRow(title: "Все исполнители", selected: filters.assigneeKey == nil) { filters.assigneeKey = nil }
                if assigneeOptions.hasUnassigned {
                    optionRow(title: "Без исполнителя", selected: filters.assigneeKey == "__none") { filters.assigneeKey = "__none" }
                }
                if assigneeOptions.list.isEmpty && !assigneeOptions.hasUnassigned {
                    emptyRow("Нет данных об исполнителях")
                } else {
                    ForEach(assigneeOptions.list) { option in
                        optionRow(title: option.name, color: option.color, selected: filters.assigneeKey == option.id) {
                            filters.assigneeKey = option.id
                        }
                    }
                }
            }

            TFCard {
                HStack {
                    Text("Показывать выполненные").tfText(.body).foregroundStyle(Color.tfText)
                    Spacer()
                    TFToggle(isOn: $filters.showCompleted)
                }
            }

            plannerSection
        }
        .padding(.bottom, TFSpacing.xl)
        .onAppear {
            if openPlannerSection { expanded = ["planner"] }
        }
    }

    private var plannerSection: some View {
        section(id: "planner", title: "Показывать в разделе") {
            Text("Выбери проекты, задачи которых показывать в этом разделе. По умолчанию раздел показывает только задачи без проекта.")
                .tfText(.action)
                .foregroundStyle(Color.tfSub)
                .padding(.bottom, TFSpacing.xs)

            let addable = allProjects.filter { visibleProjectIds[$0.id] != true }
            if allProjects.isEmpty {
                emptyRow("Нет проектов для добавления")
            } else if addable.isEmpty {
                emptyRow("Все проекты уже в разделе")
            } else {
                ForEach(addable) { project in
                    optionRow(title: project.name, color: Color(hex: project.color ?? "#A6A6A6"), selected: false) {
                        onTogglePlannerProject(project.id)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func section(id: String, title: String, @ViewBuilder rows: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
            } label: {
                HStack {
                    Text(title).tfText(.body).foregroundStyle(Color.tfText)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.tfDim)
                        .rotationEffect(.degrees(expanded.contains(id) ? 90 : 0))
                }
                .padding(TFSpacing.lg)
                .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())

            if expanded.contains(id) {
                VStack(alignment: .leading, spacing: TFSpacing.xs) {
                    rows()
                }
                .padding(.horizontal, TFSpacing.lg)
                .padding(.bottom, TFSpacing.md)
            }
        }
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    private func optionRow(title: String, color: Color = .tfSub, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(title).tfText(.row).foregroundStyle(Color.tfText)
                Spacer()
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.tfRed)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapMenuStyle())
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text).tfText(.action).foregroundStyle(Color.tfDim)
    }
}
