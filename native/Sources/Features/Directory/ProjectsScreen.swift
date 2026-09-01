import SwiftUI

// «Проекты» — spec/SCREENS-2.md §7, `/projects`. Сверено построчно с живым
// `src/screens/ProjectsScreen.tsx` 31.08.2026 (ARCHITECTURE.md правило 3 —
// расходится спека с кодом, верю коду):
//
// 1. Шапка — `compact`, НЕ `large` (спека ошибается, скриншот `projects.png`
//    подтверждает код: «<» + центрированный заголовок, без крупного h1).
// 2. У экрана НЕТ собственной кнопки/строки создания вообще — единственный
//    вход это `?create=1` от долгого нажатия центральной кнопки таббара
//    (веб-код, `showCreate` открывается только эффектом на этот квери-параметр).
//    ⚠️ КОНТРАКТНАЯ ДЫРА, не мой файл чинить: (а) `ProjectsScreen` по
//    INTEGRATION.md — БЕЗ параметров, передать сюда «открой форму» неоткуда;
//    (б) `TFTabBar`/`RootShellView` (проверено чтением) вообще не знают про
//    долгое нажатие — там всего один `Button` без alt-действия. Итог: создать
//    проект в приложении СЕЙЧАС неоткуда. В отчёте — оркестратору отдельно.
// 3. Пустое состояние — просто строка текста (не `TFEmptyState` с иконкой,
//    как у Меток) — 1:1 с кодом.
struct ProjectsScreen: View {
    @Environment(ProjectStore.self) private var projectStore

    @State private var editingID: String?
    @State private var deleteRequest: DirectoryConfirmRequest?
    @State private var errorMessage: String?

    private let apiClient = APIClient()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(projectStore.projects) { project in
                    if editingID == project.id {
                        ProjectEditForm(project: project, apiClient: apiClient, onSaved: {
                            editingID = nil
                            Task { await projectStore.load() }
                        }, onCancel: { editingID = nil })
                    } else {
                        DirectorySwipeRow(
                            onEdit: { editingID = project.id },
                            onDelete: { requestDelete(project) }
                        ) {
                            projectRow(project)
                        }
                    }
                }

                if projectStore.projects.isEmpty && !projectStore.isLoading {
                    Text("Проектов пока нет — удержите кнопку внизу, чтобы создать")
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, TFSpacing.xs)
                }

                if projectStore.isLoading { TFLoading(.block) }
                TFErrorBanner(projectStore.errorMessage, variant: .inline)
                TFErrorBanner(errorMessage, variant: .block)
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.top, TFSpacing.sm)
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Своя шапка уже несёт заголовок и кнопку «назад» — системный навбар
        // поверх неё давал ВТОРУЮ стрелку и лишнюю полосу.
        // Нативная сворачивающаяся шапка.
        .navigationTitle("Проекты")
        .navigationBarTitleDisplayMode(.large)
        .safeAreaInset(edge: .top, spacing: 0) {
            // `TFScreenHeader` сама стрелку «назад» не рисует (проверено кодом) —
            // `DirectoryBackButton()` тот же канонический ответ, что уже
            // используют соседи по папке (`NotificationsScreen`/`ActivityScreen`).
            TFScreenHeader("Проекты", variant: .compact, leading: { AnyView(DirectoryBackButton()) })
        }
        .task { if projectStore.projects.isEmpty { await projectStore.load() } }
        .directoryConfirm($deleteRequest)
    }

    private func projectRow(_ project: ApiProject) -> some View {
        NavigationLink(value: AppRoute.projectTasks(projectID: project.id)) {
            HStack(spacing: TFSpacing.md) {
                RoundedRectangle(cornerRadius: TFRadius.md)
                    .fill(Color(hex: project.color ?? "#A6A6A6").opacity(0.125))
                    .frame(width: 28, height: 28)
                    .overlay {
                        Image(systemName: "number")
                            .font(.system(size: 16))
                            .foregroundStyle(Color(hex: project.color ?? "#A6A6A6"))
                    }
                VStack(alignment: .leading, spacing: 1) {
                    Text(project.name)
                        .tfText(.body)
                        .foregroundStyle(Color.tfText)
                        .lineLimit(1)
                    let count = project.taskCount ?? 0
                    Text("\(count) \(DirectoryPluralize.taskWord(count))")
                        .tfText(.caption)
                        .foregroundStyle(Color.tfSub)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, TFSpacing.md)
            .padding(.horizontal, TFSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.tfCard)
        }
        .buttonStyle(TFTapRowStyle())
    }

    /// Текст confirm-а зависит от `task_count` — прямая цитата `ProjectsScreen.tsx`.
    private func requestDelete(_ project: ApiProject) {
        let count = project.taskCount ?? 0
        deleteRequest = DirectoryConfirmRequest(
            title: "Удалить проект «\(project.name)»?",
            description: count > 0
                ? "Задачи внутри (\(count) \(DirectoryPluralize.taskWord(count))) не удалятся — они останутся без проекта. Сам проект и его столбец на доске исчезнут без возможности отмены."
                : "В нём сейчас нет задач. Действие нельзя отменить.",
            onConfirm: {
                Task {
                    await projectStore.delete(projectId: project.id)
                }
            }
        )
    }
}

/// Инлайн-форма переименования — разворачивается на месте строки (spec §7),
/// поле + 7 свотчей `PROJECT_COLORS`, «Отмена»/«Сохранить». Своим `APIClient()`
/// зовёт `patchProject` — `ProjectStore` метода `update` не даёт (Core чужой),
/// после успеха родитель перезагружает стор, чтобы кэш не разъехался с сервером.
private struct ProjectEditForm: View {
    let project: ApiProject
    let apiClient: APIClient
    let onSaved: () -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var color: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(project: ApiProject, apiClient: APIClient, onSaved: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.project = project
        self.apiClient = apiClient
        self.onSaved = onSaved
        self.onCancel = onCancel
        _name = State(initialValue: project.name)
        _color = State(initialValue: project.color ?? DirectoryColors.project[0])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            TextField("Название проекта", text: $name)
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .padding(.horizontal, TFSpacing.sm + 4)
                .padding(.vertical, TFSpacing.sm + 2)
                .background(Color.tfCard2)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))

            DirectoryColorSwatches(colors: DirectoryColors.project, selected: $color, size: 24)

            TFErrorBanner(errorMessage, variant: .block)

            HStack(spacing: TFSpacing.sm) {
                Button("Отмена", action: onCancel)
                    .buttonStyle(TFTapRowStyle())
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .tfText(.row)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.tfSub)
                    .background(Color.tfCard2)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))

                Button {
                    Task { await save() }
                } label: {
                    Text(isSaving ? "Сохраняем…" : "Сохранить")
                        .frame(maxWidth: .infinity)
                        .frame(height: 44)
                        .tfText(.row)
                        .fontWeight(.semibold)
                        .foregroundStyle(.white)
                        .background(Color.tfRedSolid)
                        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                }
                .buttonStyle(TFTapFadeStyle())
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                .opacity(name.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
            }
        }
        .padding(TFSpacing.lg)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    private func save() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            _ = try await apiClient.patchProject(id: project.id, fields: ["name": .string(trimmed), "color": .string(color)])
            onSaved()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось переименовать проект"
        }
    }
}
