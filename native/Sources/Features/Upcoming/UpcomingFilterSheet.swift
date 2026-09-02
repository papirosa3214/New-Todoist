import SwiftUI

// Шторка фильтров — spec/SCREENS-1.md §3.9 `TaskFilterSheet`/`TaskFilterButton`.
// Общая для «Сегодня»/«Планирования» в вебе — здесь СВОЯ копия (см. пояснение
// у `UpcomingTaskFilters`, тот же принцип «экраны сдаются по одному»).

struct UpcomingPlannerProjectsConfig {
    let projects: [ApiProject]
    let visibleProjectIds: Set<String>
    let onToggle: (String) -> Void
}

struct UpcomingFilterSheetContent: View {
    @Binding var filters: UpcomingTaskFilters
    let projectOptions: [UpcomingFilterOption]
    let labelOptions: [UpcomingFilterOption]
    let assigneeOptions: (list: [UpcomingAssigneeOption], hasUnassigned: Bool)
    let planner: UpcomingPlannerProjectsConfig
    /// Секция «Показывать в разделе» открыта сразу — тап по [+ проект] в полоске чипов (спека §3.10).
    let openPlannerOnAppear: Bool
    let onClose: () -> Void

    @State private var openSection: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: TFIconSize.sm)).foregroundStyle(Color.tfSub)
                        .frame(width: 44, height: 44)
                }
                Spacer()
                Text("Фильтры").tfText(.title).foregroundStyle(Color.tfText)
                Spacer()
                Button("Сбросить") { filters = .empty }
                    .tfText(.action)
                    .foregroundStyle(Color.tfSub)
                    .opacity(filters.isActive ? 1 : 0.4)
                    .disabled(!filters.isActive)
                    .frame(height: 44)
            }
            .padding(.bottom, TFSpacing.md)

            VStack(spacing: TFSpacing.md) {
                picker(
                    key: "project", icon: "number", label: "Проект", allLabel: "Все проекты",
                    currentLabel: projectOptions.first { $0.id == filters.projectId }?.label ?? "Все проекты",
                    options: projectOptions, selectedId: filters.projectId, emptyText: "Нет задач с проектом"
                ) { filters.projectId = $0 }

                picker(
                    key: "label", icon: "tag", label: "Метка", allLabel: "Все метки",
                    currentLabel: labelOptions.first { $0.id == filters.labelId }?.label ?? "Все метки",
                    options: labelOptions, selectedId: filters.labelId, emptyText: "Нет задач с метками"
                ) { filters.labelId = $0 }

                assigneeCard
                completedCard
                if !planner.projects.isEmpty { plannerCard }
            }
            .padding(.bottom, TFSpacing.xl)
        }
        .onAppear { if openPlannerOnAppear { openSection = "planner" } }
    }

    // MARK: - Проект/Метка

    @ViewBuilder
    private func picker(
        key: String, icon: String, label: String, allLabel: String, currentLabel: String,
        options: [UpcomingFilterOption], selectedId: String?, emptyText: String,
        onSelect: @escaping (String?) -> Void
    ) -> some View {
        TFCard(padding: 0) {
            VStack(spacing: 0) {
                fieldRow(icon: icon, label: label, value: currentLabel, isOpen: openSection == key) {
                    openSection = openSection == key ? nil : key
                }
                if openSection == key {
                    VStack(spacing: 0) {
                        TFDivider()
                        optionRow(icon: nil, label: allLabel, selected: selectedId == nil) {
                            onSelect(nil); openSection = nil
                        }
                        ForEach(options) { opt in
                            optionRow(icon: icon, iconColor: opt.color, label: opt.label, selected: selectedId == opt.id) {
                                onSelect(opt.id); openSection = nil
                            }
                        }
                        if options.isEmpty { emptyRow(emptyText) }
                    }
                }
            }
        }
    }

    // MARK: - Исполнитель

    private var assigneeCard: some View {
        TFCard(padding: 0) {
            VStack(spacing: 0) {
                let label = filters.assigneeKey == "__none"
                    ? "Без исполнителя"
                    : (assigneeOptions.list.first { $0.id == filters.assigneeKey }?.name ?? "Все исполнители")
                fieldRow(icon: "person", label: "Исполнитель", value: label, isOpen: openSection == "assignee") {
                    openSection = openSection == "assignee" ? nil : "assignee"
                }
                if openSection == "assignee" {
                    VStack(spacing: 0) {
                        TFDivider()
                        optionRow(icon: nil, label: "Все исполнители", selected: filters.assigneeKey == nil) {
                            filters.assigneeKey = nil; openSection = nil
                        }
                        ForEach(assigneeOptions.list) { a in
                            HStack(spacing: TFSpacing.md) {
                                TFAvatar(size: .xs, initials: a.initials, tint: a.color)
                                Text(a.name).tfText(.row).foregroundStyle(Color.tfText).lineLimit(1)
                                Spacer()
                                if filters.assigneeKey == a.id {
                                    Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(Color.tfRed)
                                }
                            }
                            .padding(.horizontal, TFSpacing.lg).padding(.vertical, 10)
                            .contentShape(Rectangle())
                            .onTapGesture { filters.assigneeKey = a.id; openSection = nil }
                        }
                        if assigneeOptions.hasUnassigned {
                            optionRow(icon: "person", label: "Без исполнителя", selected: filters.assigneeKey == "__none") {
                                filters.assigneeKey = "__none"; openSection = nil
                            }
                        }
                        if assigneeOptions.list.isEmpty && !assigneeOptions.hasUnassigned {
                            emptyRow("Нет данных об исполнителях")
                        }
                    }
                }
            }
        }
    }

    // MARK: - Показывать выполненные

    private var completedCard: some View {
        TFCard(padding: 0) {
            Button {
                filters.showCompleted.toggle()
            } label: {
                HStack(spacing: TFSpacing.md) {
                    Image(systemName: "checkmark").font(.system(size: TFIconSize.sm)).foregroundStyle(Color.tfSub)
                    Text("Показывать выполненные").tfText(.row).foregroundStyle(Color.tfText)
                    Spacer()
                    TFToggle(isOn: $filters.showCompleted)
                        .allowsHitTesting(false) // тап обрабатывает вся строка
                }
                .padding(.horizontal, TFSpacing.lg).padding(.vertical, TFSpacing.md)
                .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())
        }
    }

    // MARK: - Показывать в разделе

    private var plannerCard: some View {
        TFCard(padding: 0) {
            VStack(spacing: 0) {
                let count = planner.projects.count { planner.visibleProjectIds.contains($0.id) }
                fieldRow(
                    icon: "folder", label: "Показывать в разделе",
                    value: count == 0 ? "Проекты не выбраны" : "Проектов: \(count)",
                    isOpen: openSection == "planner"
                ) {
                    openSection = openSection == "planner" ? nil : "planner"
                }
                if openSection == "planner" {
                    VStack(alignment: .leading, spacing: 0) {
                        TFDivider()
                        Text("Выбери проекты, задачи которых показывать в этом разделе. По умолчанию раздел показывает только задачи без проекта.")
                            .tfText(.meta)
                            .foregroundStyle(Color.tfDim)
                            .padding(.horizontal, TFSpacing.lg).padding(.top, 10).padding(.bottom, 4)

                        let remaining = planner.projects.filter { !planner.visibleProjectIds.contains($0.id) }
                        if planner.projects.isEmpty {
                            emptyRow("Нет проектов для добавления")
                        } else if remaining.isEmpty {
                            emptyRow("Все проекты уже в разделе")
                        } else {
                            ForEach(remaining) { p in
                                HStack(spacing: TFSpacing.md) {
                                    Image(systemName: "number").font(.system(size: 16))
                                        .foregroundStyle(Color(hex: p.color ?? "#A6A6A6"))
                                    Text(p.name).tfText(.row).foregroundStyle(Color.tfText).lineLimit(1)
                                    Spacer()
                                    TFToggle(isOn: .constant(false)).allowsHitTesting(false)
                                }
                                .padding(.horizontal, TFSpacing.lg).padding(.vertical, 10)
                                .contentShape(Rectangle())
                                .onTapGesture { planner.onToggle(p.id) }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Общие кирпичи

    private func fieldRow(icon: String, label: String, value: String, isOpen: Bool, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            HStack(spacing: TFSpacing.md) {
                Image(systemName: icon).font(.system(size: TFIconSize.sm)).foregroundStyle(Color.tfSub).frame(width: 22)
                Text(label).tfText(.body).foregroundStyle(Color.tfText)
                Spacer()
                Text(value).tfText(.body).foregroundStyle(Color.tfSub).lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.tfDim)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
            }
            .padding(.horizontal, TFSpacing.lg).padding(.vertical, TFSpacing.md)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }

    private func optionRow(icon: String?, iconColor: Color = .tfSub, label: String, selected: Bool, onTap: @escaping () -> Void) -> some View {
        Button(action: onTap) {
            HStack(spacing: TFSpacing.md) {
                if let icon {
                    Image(systemName: icon).font(.system(size: 16)).foregroundStyle(iconColor)
                }
                Text(label).tfText(.row).foregroundStyle(Color.tfText).lineLimit(1)
                Spacer()
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(Color.tfRed)
                }
            }
            .padding(.horizontal, TFSpacing.lg).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }

    private func emptyRow(_ text: String) -> some View {
        Text(text).tfText(.action).foregroundStyle(Color.tfDim)
            .padding(.horizontal, TFSpacing.lg).padding(.vertical, TFSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Полоска чипов проектов под шапкой — spec §3.10 `PlannerProjectChips`.
struct UpcomingPlannerProjectChips: View {
    let projects: [ApiProject]
    let visibleProjectIds: Set<String>
    let onAdd: () -> Void

    var body: some View {
        let visible = projects.filter { visibleProjectIds.contains($0.id) }
        // Полоска целиком (включая неснимаемый чип «Входящие») показана, только
        // если список видимых проектов не пуст — спека §3.10.
        if !visible.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TFSpacing.sm) {
                    Text("Входящие")
                        .tfText(.meta)
                        .foregroundStyle(Color.tfText)
                        .padding(.horizontal, TFSpacing.md).padding(.vertical, TFSpacing.xs)
                        .background(Color.tfCard2)
                        .overlay(Capsule().strokeBorder(Color.tfStroke, lineWidth: TFBorder.width))
                        .clipShape(Capsule())

                    ForEach(visible) { p in
                        Text(p.name)
                            .tfText(.meta)
                            .foregroundStyle(Color(hex: p.color ?? "#999999"))
                            .lineLimit(1)
                            .padding(.horizontal, TFSpacing.md).padding(.vertical, TFSpacing.xs)
                            .background(Color(hex: p.color ?? "#999999").opacity(0.15))
                            .clipShape(Capsule())
                    }

                    Button(action: onAdd) {
                        HStack(spacing: 4) {
                            Image(systemName: "plus").font(.system(size: 12))
                            Text("проект")
                        }
                        .tfText(.meta)
                        .foregroundStyle(Color.tfSub)
                        .padding(.horizontal, TFSpacing.md).padding(.vertical, TFSpacing.xs)
                        .overlay(Capsule().strokeBorder(style: StrokeStyle(lineWidth: TFBorder.width, dash: [4])).foregroundStyle(Color.tfStroke))
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, TFSpacing.screenHorizontal).padding(.vertical, TFSpacing.sm)
            }
            .background(Color.tfBackground)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.tfStroke).frame(height: TFBorder.width) }
        }
    }
}
