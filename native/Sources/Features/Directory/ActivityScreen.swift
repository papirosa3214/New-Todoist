import SwiftUI

// «Активность» — spec/SCREENS-2.md §12, `/activity`. Данные — целиком из
// уже прогретого `TaskStore.tasks` (тот же приём, что `OverviewScreen`):
// у сервера нет ни фильтра по периоду, ни по проекту/метке/исполнителю
// (`GET /tasks` отдаёт список целиком, spec/API.md §5.1) — весь подсчёт,
// группировка и фильтрация клиентские, портированы из живого
// `src/screens/ActivityScreen.tsx` (только чтение, спека сама формул не
// даёт). Заголовок компактный со стрелкой назад — по кадру `activity.png`,
// хотя §12 пишет «large»: кадр авторитетнее (ARCHITECTURE.md правило 3).
struct ActivityScreen: View {
    @Environment(TaskStore.self) private var taskStore

    @State private var period: ActivityPeriod = .week
    @State private var projectId: String?
    @State private var labelId: String?
    /// nil — все, "__none" — без исполнителя, иначе id пользователя.
    @State private var assigneeKey: String?
    @State private var sheetOpen = false
    @State private var openSection: String?
    @State private var route: AppRoute?

    private var today: String { DirectoryDate.todayKeyLocal() }
    private var yesterday: String { DirectoryDate.addDaysLocal(today, -1) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: TFSpacing.md) {
                TFErrorBanner(taskStore.errorMessage, variant: .inline)
                    .padding(.horizontal, TFSpacing.screenHorizontal)

                ActivityChart(tasks: filteredAllTasks, period: period)
                    .padding(.horizontal, TFSpacing.screenHorizontal)

                if !showTrueEmpty {
                    Text(summaryText)
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                        .padding(.horizontal, TFSpacing.screenHorizontal + 4)
                }

                if showTrueEmpty {
                    TFEmptyState(icon: "checkmark", text: "Пока ничего не выполнено")
                        .padding(.top, TFSpacing.xl)
                    Text("Задачи, которые вы отметите выполненными, появятся здесь — и их всегда можно будет вернуть в работу")
                        .tfText(.caption).foregroundStyle(Color.tfDim)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, TFSpacing.xl)
                        .frame(maxWidth: .infinity)
                } else if showFilteredEmpty {
                    filteredEmptyState
                } else {
                    ForEach(groups, id: \.key) { group in
                        VStack(alignment: .leading, spacing: TFSpacing.sm) {
                            Text(group.label).tfText(.action).fontWeight(.semibold).foregroundStyle(Color.tfSub)
                                .padding(.horizontal, TFSpacing.screenHorizontal + 4)
                            VStack(spacing: TFSpacing.sm) {
                                ForEach(group.tasks, id: \.id) { task in
                                    completedCard(task)
                                }
                            }
                            .padding(.horizontal, TFSpacing.screenHorizontal)
                        }
                    }
                }
            }
            .padding(.top, TFSpacing.sm)
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Нативная сворачивающаяся шапка.
        .navigationTitle("Активность")
        .navigationBarTitleDisplayMode(.large)
        .safeAreaInset(edge: .top, spacing: 0) {
            TFScreenHeader(
                "Активность", variant: .compact,
                leading: { AnyView(DirectoryBackButton()) },
                actions: [TFHeaderAction(icon: "line.3.horizontal.decrease") { sheetOpen = true }]
            )
        }
        .navigationDestination(item: $route) { routeDestination($0) }
        .tfBottomSheet(isPresented: $sheetOpen, title: "Фильтры", actionTitle: "Сбросить", action: resetFilters) {
            filterSheetContent
        }
    }

    // MARK: - Карточка выполненной задачи

    private func completedCard(_ task: ApiTask) -> some View {
        VStack(spacing: 0) {
            Button { route = .taskDetail(taskID: task.id) } label: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(task.title).tfText(.body).foregroundStyle(Color.tfSub).strikethrough()
                    HStack(spacing: TFSpacing.xs) {
                        if let time = completionTime(task) {
                            Text(time).tfText(.caption).foregroundStyle(Color.tfDim)
                        }
                        if let name = task.projectName {
                            TFLabelPill(name, color: task.projectColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
                        }
                        ForEach(task.labels, id: \.id) { label in
                            TFLabelPill(label.name, color: label.color.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
                        }
                    }
                }
                .padding(.horizontal, TFSpacing.lg)
                .padding(.top, TFSpacing.sm + 4)
                .padding(.bottom, TFSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())

            TFDivider()
            Button {
                Task { await restore(task) }
            } label: {
                HStack(spacing: TFSpacing.xs) {
                    Image(systemName: "arrow.triangle.2.circlepath").font(.system(size: 14))
                    Text("Вернуть в работу").tfText(.action).fontWeight(.semibold)
                }
                .foregroundStyle(Color.tfRed)
                .frame(maxWidth: .infinity)
                .frame(height: 44)
            }
            .buttonStyle(TFTapRowStyle())
        }
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    private func completionTime(_ task: ApiTask) -> String? {
        guard let raw = task.completedAt ?? (task.status == .completed ? task.updatedAt : nil),
              let date = DateFormats.sqliteUTC(raw) else { return nil }
        return DirectoryDate.timeLocal(date)
    }

    private func restore(_ task: ApiTask) async {
        await taskStore.patch(taskId: task.id, fields: ["status": .string("active")]) { _ in }
    }

    // MARK: - Пустое состояние «под фильтры ничего не подошло»

    private var filteredEmptyState: some View {
        VStack(spacing: TFSpacing.md) {
            Image(systemName: "list.bullet").font(.system(size: 36)).foregroundStyle(Color.tfSub)
            Text("Под выбранные фильтры ничего не подошло").tfText(.body).foregroundStyle(Color.tfText)
            Text("Попробуйте изменить период или сбросить фильтры").tfText(.caption).foregroundStyle(Color.tfDim)
            Button("Сбросить фильтры") { resetFilters() }
                .tfText(.body).foregroundStyle(Color.tfText)
                .padding(.horizontal, TFSpacing.lg).frame(height: 44)
                .background(Color.tfCard2)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                .buttonStyle(TFTapFadeStyle())
        }
        .multilineTextAlignment(.center)
        .padding(.top, TFSpacing.xl)
        .padding(.horizontal, TFSpacing.xl)
        .frame(maxWidth: .infinity)
    }

    private func resetFilters() {
        projectId = nil
        labelId = nil
        assigneeKey = nil
        period = .week
    }

    // MARK: - Данные (портировано 1:1 из ActivityScreen.tsx)

    private var completed: [ApiTask] { taskStore.tasks.filter { $0.status == .completed } }

    private func completionDate(_ task: ApiTask) -> Date? {
        guard let raw = task.completedAt ?? (task.status == .completed ? task.updatedAt : nil) else { return nil }
        return DateFormats.sqliteUTC(raw)
    }

    /// Скользящее окно (сейчас − N дней), не календарный месяц/неделя —
    /// «неделя» значит «последние 7 дней».
    private var periodCutoff: Date {
        let now = Date()
        let cal = Calendar.current
        switch period {
        case .week: return cal.date(byAdding: .day, value: -7, to: now) ?? now
        case .month:
            let comps = cal.dateComponents([.year, .month], from: now)
            return cal.date(from: comps) ?? now
        case .quarter: return cal.date(byAdding: .day, value: -90, to: now) ?? now
        case .year:
            var comps = DateComponents(); comps.year = cal.component(.year, from: now); comps.month = 1; comps.day = 1
            return cal.date(from: comps) ?? now
        }
    }

    private func matchesFilters(_ t: ApiTask) -> Bool {
        if let projectId, t.projectId != projectId { return false }
        if let labelId, !t.labels.contains(where: { $0.id == labelId }) { return false }
        if assigneeKey == "__none" {
            if t.assigneeId != nil { return false }
        } else if let assigneeKey, t.assigneeId != assigneeKey {
            return false
        }
        return true
    }

    private var filtered: [ApiTask] {
        let cutoff = periodCutoff
        return completed.filter { t in
            guard matchesFilters(t) else { return false }
            guard let cd = completionDate(t) else { return true } // как в вебе: непарсимая дата не исключает задачу
            return cd >= cutoff
        }
    }

    private var groups: [(key: String, label: String, tasks: [ApiTask])] {
        var map: [String: [ApiTask]] = [:]
        for t in filtered {
            guard let cd = completionDate(t) else { continue }
            map[DirectoryDate.dayKeyLocal(cd), default: []].append(t)
        }
        for key in map.keys {
            map[key]?.sort { (completionDate($0) ?? .distantPast) > (completionDate($1) ?? .distantPast) }
        }
        let todayKey = today, yesterdayKey = yesterday
        return map.keys.sorted(by: >).map { key in
            (key: key, label: DirectoryDate.groupLabel(key, today: todayKey, yesterday: yesterdayKey), tasks: map[key] ?? [])
        }
    }

    /// Для графика — фильтр по проекту/метке/исполнителю, БЕЗ периода
    /// (график сам режет на бакеты) и БЕЗ статуса (нужны и active, и completed).
    private var filteredAllTasks: [ApiTask] { taskStore.tasks.filter(matchesFilters) }

    private var showTrueEmpty: Bool { completed.isEmpty }
    private var showFilteredEmpty: Bool { !completed.isEmpty && filtered.isEmpty }

    private var summaryText: String {
        let word: String
        switch period {
        case .week: word = "неделю"
        case .month: word = "месяц"
        case .quarter: word = "3 месяца"
        case .year: word = "год"
        }
        return "За \(word) выполнено \(filtered.count)"
    }

    // MARK: - Опции фильтров (из полного набора выполненных, не из уже отфильтрованных)

    private struct FilterOption: Identifiable { let id: String; let label: String; let color: Color }

    private var projectOptions: [FilterOption] {
        var seen = Set<String>()
        var result: [FilterOption] = []
        for t in completed {
            guard let pid = t.projectId, let name = t.projectName, !seen.contains(pid) else { continue }
            seen.insert(pid)
            result.append(FilterOption(id: pid, label: name, color: t.projectColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6")))
        }
        return result.sorted { $0.label.localizedCompare($1.label) == .orderedAscending }
    }

    private var labelOptions: [FilterOption] {
        var seen = Set<String>()
        var result: [FilterOption] = []
        for t in completed {
            for l in t.labels where !seen.contains(l.id) {
                seen.insert(l.id)
                result.append(FilterOption(id: l.id, label: l.name, color: l.color.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6")))
            }
        }
        return result.sorted { $0.label.localizedCompare($1.label) == .orderedAscending }
    }

    private struct AssigneeOption: Identifiable { let id: String; let name: String; let initials: String; let color: Color }

    private var assigneeOptions: (list: [AssigneeOption], hasUnassigned: Bool) {
        var seen = Set<String>()
        var result: [AssigneeOption] = []
        var hasUnassigned = false
        for t in completed {
            if let aid = t.assigneeId {
                if !seen.contains(aid) {
                    seen.insert(aid)
                    result.append(AssigneeOption(
                        id: aid, name: t.assigneeName ?? "Без имени",
                        initials: t.assigneeInitials ?? "?",
                        color: t.assigneeColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6")
                    ))
                }
            } else {
                hasUnassigned = true
            }
        }
        return (result.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }, hasUnassigned)
    }

    // MARK: - Шторка фильтров

    private var projectLabel: String { projectId.flatMap { id in projectOptions.first { $0.id == id }?.label } ?? "Все проекты" }
    private var labelLabel: String { labelId.flatMap { id in labelOptions.first { $0.id == id }?.label } ?? "Все метки" }
    private var assigneeLabel: String {
        if assigneeKey == "__none" { return "Без исполнителя" }
        if let key = assigneeKey { return assigneeOptions.list.first { $0.id == key }?.name ?? "Все исполнители" }
        return "Все исполнители"
    }

    @ViewBuilder
    private var filterSheetContent: some View {
        VStack(spacing: TFSpacing.md) {
            TFFieldGroup {
                TFFieldRow(icon: "number", title: "Проект", value: projectLabel) { toggleSection("project") }
                if openSection == "project" {
                    TFFieldDivider()
                    optionsList(
                        allLabel: "Все проекты", isAllSelected: projectId == nil, onSelectAll: { projectId = nil; openSection = nil },
                        options: projectOptions, selectedId: projectId, optionIcon: "number",
                        emptyText: "Нет выполненных задач с проектом"
                    ) { id in projectId = id; openSection = nil }
                }
            }
            TFFieldGroup {
                TFFieldRow(icon: "tag", title: "Метка", value: labelLabel) { toggleSection("label") }
                if openSection == "label" {
                    TFFieldDivider()
                    optionsList(
                        allLabel: "Все метки", isAllSelected: labelId == nil, onSelectAll: { labelId = nil; openSection = nil },
                        options: labelOptions, selectedId: labelId, optionIcon: "tag",
                        emptyText: "Нет выполненных задач с метками"
                    ) { id in labelId = id; openSection = nil }
                }
            }
            TFFieldGroup {
                TFFieldRow(icon: "person", title: "Исполнитель", value: assigneeLabel) { toggleSection("assignee") }
                if openSection == "assignee" { assigneeOptionsList }
            }
            TFFieldGroup {
                TFFieldRow(icon: "calendar", title: "Период", value: period.label) { toggleSection("period") }
                if openSection == "period" {
                    TFFieldDivider()
                    VStack(spacing: 0) {
                        ForEach(ActivityPeriod.allCases) { p in
                            filterOptionRow(label: p.label, isSelected: period == p, color: nil, icon: nil) {
                                period = p; openSection = nil
                            }
                        }
                    }
                }
            }
        }
        .padding(.bottom, TFSpacing.xl)
    }

    private func toggleSection(_ key: String) { openSection = openSection == key ? nil : key }

    private func optionsList(
        allLabel: String, isAllSelected: Bool, onSelectAll: @escaping () -> Void,
        options: [FilterOption], selectedId: String?, optionIcon: String, emptyText: String,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        VStack(spacing: 0) {
            filterOptionRow(label: allLabel, isSelected: isAllSelected, color: nil, icon: nil, action: onSelectAll)
            ForEach(options) { opt in
                filterOptionRow(label: opt.label, isSelected: selectedId == opt.id, color: opt.color, icon: optionIcon) {
                    onSelect(opt.id)
                }
            }
            if options.isEmpty {
                Text(emptyText).tfText(.action).foregroundStyle(Color.tfDim)
                    .padding(.horizontal, TFField.cardInsetH).padding(.vertical, TFSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var assigneeOptionsList: some View {
        VStack(spacing: 0) {
            TFFieldDivider()
            filterOptionRow(label: "Все исполнители", isSelected: assigneeKey == nil, color: nil, icon: nil) {
                assigneeKey = nil; openSection = nil
            }
            ForEach(assigneeOptions.list) { a in
                HStack(spacing: TFSpacing.sm) {
                    Circle().fill(a.color).frame(width: 22, height: 22)
                        .overlay { Text(a.initials).font(.system(size: 9, weight: .semibold)).foregroundStyle(.white) }
                    Text(a.name).tfText(.row).foregroundStyle(Color.tfText).lineLimit(1)
                    Spacer()
                    if assigneeKey == a.id {
                        Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.tfRed)
                    }
                }
                .padding(.horizontal, TFField.cardInsetH).padding(.vertical, TFSpacing.sm)
                .contentShape(Rectangle())
                .onTapGesture { assigneeKey = a.id; openSection = nil }
            }
            if assigneeOptions.hasUnassigned {
                HStack(spacing: TFSpacing.sm) {
                    Circle().fill(Color.tfCard2).frame(width: 22, height: 22)
                        .overlay { Image(systemName: "person").font(.system(size: 10)).foregroundStyle(Color.tfDim) }
                    Text("Без исполнителя").tfText(.row).foregroundStyle(Color.tfText)
                    Spacer()
                    if assigneeKey == "__none" {
                        Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.tfRed)
                    }
                }
                .padding(.horizontal, TFField.cardInsetH).padding(.vertical, TFSpacing.sm)
                .contentShape(Rectangle())
                .onTapGesture { assigneeKey = "__none"; openSection = nil }
            }
            if assigneeOptions.list.isEmpty && !assigneeOptions.hasUnassigned {
                Text("Нет данных об исполнителях").tfText(.action).foregroundStyle(Color.tfDim)
                    .padding(.horizontal, TFField.cardInsetH).padding(.vertical, TFSpacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func filterOptionRow(label: String, isSelected: Bool, color: Color?, icon: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: TFSpacing.sm) {
                if let icon, let color {
                    Image(systemName: icon).font(.system(size: 14)).foregroundStyle(color)
                }
                Text(label).tfText(.row).foregroundStyle(Color.tfText).lineLimit(1)
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.tfRed)
                }
            }
            .padding(.horizontal, TFField.cardInsetH)
            .padding(.vertical, TFSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }
}
