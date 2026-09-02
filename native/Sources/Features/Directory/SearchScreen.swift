import SwiftUI

// «Поиск» — spec/SCREENS-2.md §11, `/search`. Разошлась спека с Core:
// `Core/Networking/APIClient+Search.swift` объявляет `/search` как «список
// задач» — устарело, живой сервер отдаёт три группы разом (spec §11 и сам
// живой `src/screens/SearchScreen.tsx` их так и показывают). Используем
// `apiClient.directorySearch(_:)` из Support/DirectoryAPI.swift — тот же
// гэп уже нашёл и завёл параллельный исполнитель (правивший Проекты/Метки),
// здесь только читаю и переиспользую, не правлю чужой файл.
//
// Строка задачи в результатах — `TFTaskRow` (DesignSystem), БЕЗ чекбокса:
// живой веб ещё дёргает чекбокс `active↔completed` прямо в строке поиска,
// но это старый паттерн — во всём остальном приложении чекбокс из строки
// задачи убран 18.08.2026 (см. комментарий `TFTaskRow.swift`), а завершение
// перенесено на карточку задачи. Держусь актуального дизайн-языка проекта,
// а не устаревшего угла веба (тап по строке — просто переход к задаче).
struct SearchScreen: View {
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var result: APIClient.DirectorySearchResult?
    @State private var isSearching = false
    @State private var errorMessage: String?
    @State private var route: AppRoute?
    @FocusState private var fieldFocused: Bool

    private let apiClient = APIClient()

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasQuery: Bool { !trimmedQuery.isEmpty }
    private var totalCount: Int { (result?.tasks.count ?? 0) + (result?.projects.count ?? 0) + (result?.labels.count ?? 0) }

    var body: some View {
        ScrollView {
            content
                .padding(.horizontal, TFSpacing.screenHorizontal)
                .padding(.top, TFSpacing.md)
                .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Штатный .searchable — iOS 15+. Заменяет самодельную searchBar
        // в safeAreaInset: поле поиска и кнопка «Отмена» рисуются
        // системным навбаром (поведение Cancel при dismiss).
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Задачи, проекты, метки"
        )
        .navigationDestination(item: $route) { routeDestination($0) }
        .onAppear { fieldFocused = true }
        // Дебаунс 300мс на САМ запрос (не на отображение вводимого текста):
        // `.task(id:)` перезапускает и автоматически отменяет предыдущий
        // запуск при смене id — ровно то же самое, что useEffect+setTimeout
        // +clearTimeout в вебе.
        .task(id: trimmedQuery) {
            guard hasQuery else {
                result = nil; errorMessage = nil; isSearching = false
                return
            }
            isSearching = true
            errorMessage = nil
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            do {
                result = try await apiClient.directorySearch(trimmedQuery)
            } catch {
                errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось выполнить поиск"
            }
            isSearching = false
        }
    }

    // MARK: - Липкая строка поиска (НЕ ScreenHeader — своя, спека §11)

    private var searchBar: some View {
        VStack(spacing: 0) {
            HStack(spacing: TFSpacing.sm) {
                HStack(spacing: TFSpacing.sm) {
                    Image(systemName: "magnifyingglass").font(.system(size: TFIconSize.sm)).foregroundStyle(Color.tfDim)
                    TextField("", text: $query, prompt: Text("Задачи, проекты, метки").foregroundStyle(Color.tfDim))
                        .tfText(.input)
                        .foregroundStyle(Color.tfText)
                        .focused($fieldFocused)
                        .submitLabel(.search)
                    if hasQuery {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(Color.tfDim)
                        }
                        .buttonStyle(TFTapScaleStyle())
                    }
                }
                .padding(.horizontal, TFSpacing.md)
                .frame(height: 44)
                .background(Color.tfCard)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))

                Button("Отмена") { dismiss() }
                    .tfText(.body).foregroundStyle(Color.tfSub)
                    .buttonStyle(TFTapFadeStyle())
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .frame(height: 48)
            TFDivider()
        }
        .background(.ultraThinMaterial)
    }

    // MARK: - Тело

    @ViewBuilder
    private var content: some View {
        if !hasQuery {
            TFEmptyState(icon: "magnifyingglass", text: "Начните вводить, чтобы найти задачи, проекты и метки")
                .padding(.top, 60)
        } else if let errorMessage {
            TFErrorBanner(errorMessage, variant: .inline)
        } else if isSearching {
            Text("Ищем…").tfText(.action).foregroundStyle(Color.tfDim)
        } else if let result {
            if totalCount == 0 {
                emptyResultsState
            } else {
                VStack(alignment: .leading, spacing: TFSpacing.lg) {
                    if !result.tasks.isEmpty { taskSection(result.tasks) }
                    if !result.projects.isEmpty { projectSection(result.projects) }
                    if !result.labels.isEmpty { labelSection(result.labels) }
                }
            }
        }
    }

    private var emptyResultsState: some View {
        VStack(spacing: TFSpacing.md) {
            Image(systemName: "magnifyingglass").font(.system(size: 36)).foregroundStyle(Color.tfSub)
            Text("Ничего не найдено").tfText(.body).foregroundStyle(Color.tfText)
            Text("По запросу «\(trimmedQuery)» нет ни задач, ни проектов, ни меток")
                .tfText(.caption).foregroundStyle(Color.tfDim).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 60)
        .padding(.horizontal, TFSpacing.xl)
    }

    // MARK: - Секции результатов

    private func sectionHeader(_ title: String) -> some View {
        Text(title).tfText(.action).fontWeight(.semibold).foregroundStyle(Color.tfSub)
    }

    private func taskSection(_ tasks: [ApiTask]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader("Задачи")
            VStack(spacing: 0) {
                ForEach(Array(tasks.enumerated()), id: \.element.id) { idx, task in
                    TFTaskRow(TFTaskRowModel(
                        projectName: task.projectName,
                        projectColor: task.projectColor.map { Color(hex: $0) },
                        title: task.title,
                        isDone: task.status == .completed,
                        description: task.description
                    )) {
                        route = .taskDetail(taskID: task.id)
                    }
                    if idx < tasks.count - 1 { TFDivider(inset: TFSpacing.lg, dimmed: true) }
                }
            }
            .background(Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        }
    }

    private func projectSection(_ projects: [ApiProject]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader("Проекты")
            VStack(spacing: TFSpacing.xs / 2) {
                ForEach(projects) { project in
                    TFListRow(
                        icon: "number",
                        iconTint: project.color.map { Color(hex: $0) } ?? .tfRed,
                        title: project.name,
                        subtitle: taskCountLabel(project.taskCount ?? 0),
                        action: { route = .projectTasks(projectID: project.id) }
                    )
                    .background(Color.tfCard)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                }
            }
        }
    }

    private func labelSection(_ labels: [ApiLabel]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            sectionHeader("Метки")
            VStack(spacing: TFSpacing.xs / 2) {
                ForEach(labels) { label in
                    TFListRow(
                        icon: "tag",
                        iconTint: label.color.map { Color(hex: $0) } ?? .tfRed,
                        title: label.name,
                        action: { route = .labelTasks(labelID: label.id) }
                    )
                    .background(Color.tfCard.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                }
            }
        }
    }

    /// «1 задача» / «2 задачи» / «5 задач» — русское склонение по числу.
    private func taskCountLabel(_ n: Int) -> String {
        let mod10 = n % 10, mod100 = n % 100
        let word: String
        if mod10 == 1 && mod100 != 11 { word = "задача" }
        else if (2...4).contains(mod10) && !(12...14).contains(mod100) { word = "задачи" }
        else { word = "задач" }
        return "\(n) \(word)"
    }
}
