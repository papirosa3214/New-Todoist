import SwiftUI

// «Метки» — spec/SCREENS-2.md §9, `/labels`. Сверено построчно с живым
// `src/screens/LabelsScreen.tsx` 31.08.2026 — здесь, в отличие от «Проектов»,
// код и скриншот дают САМОСТОЯТЕЛЬНЫЙ вход создания: пунктирная строка
// «Создать метку» внизу списка (`showCreate`, локальный @State), да ещё
// кнопка в самом пустом состоянии — экран рабочий целиком без App/, не
// зависит от недостроенного долгого нажатия таббара (в отличие от Проектов,
// см. комментарий там).
struct LabelsScreen: View {
    @Environment(LabelStore.self) private var labelStore
    @Environment(TaskStore.self) private var taskStore

    @State private var editingID: String?
    @State private var showCreate = false
    @State private var deleteRequest: DirectoryConfirmRequest?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TFSpacing.md) {
                if showCreate {
                    LabelCreateForm(onCreated: { showCreate = false }, onCancel: { showCreate = false })
                }

                if labelStore.isLoading { TFLoading(.block) }
                TFErrorBanner(labelStore.errorMessage, variant: .inline)

                if !labelStore.isLoading && labelStore.labels.isEmpty && !showCreate {
                    emptyState
                } else {
                    VStack(spacing: 2) {
                        ForEach(labelStore.labels) { label in
                            if editingID == label.id {
                                LabelEditForm(label: label, onSaved: { editingID = nil }, onCancel: { editingID = nil })
                            } else {
                                labelRow(label)
                            }
                        }
                    }

                    if !showCreate && !labelStore.labels.isEmpty {
                        Button {
                            showCreate = true
                        } label: {
                            HStack(spacing: TFSpacing.md) {
                                Image(systemName: "plus")
                                    .font(.system(size: 18))
                                    .foregroundStyle(Color.tfDim)
                                Text("Создать метку")
                                    .tfText(.action)
                                    .foregroundStyle(Color.tfSub)
                            }
                            .padding(.vertical, TFSpacing.md)
                            .padding(.horizontal, TFSpacing.lg)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .overlay {
                                RoundedRectangle(cornerRadius: TFRadius.lg)
                                    .strokeBorder(Color.tfStroke, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                            }
                        }
                        .buttonStyle(TFTapRowStyle())
                        .padding(.top, TFSpacing.sm)
                    }
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.top, TFSpacing.sm)
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        .safeAreaInset(edge: .top, spacing: 0) {
            TFScreenHeader("Метки", variant: .compact, leading: { AnyView(DirectoryBackButton()) })
        }
        .task {
            if labelStore.labels.isEmpty { await labelStore.load() }
            if taskStore.tasks.isEmpty { await taskStore.load() }
        }
        .directoryConfirm($deleteRequest)
    }

    // MARK: - Строка метки — без свайпа, две видимые иконки (spec §9)

    private func labelRow(_ label: ApiLabel) -> some View {
        HStack(spacing: 0) {
            NavigationLink(value: AppRoute.labelTasks(labelID: label.id)) {
                HStack(spacing: TFSpacing.md) {
                    RoundedRectangle(cornerRadius: TFRadius.md)
                        .fill(Color(hex: label.color ?? "#A6A6A6").opacity(0.125))
                        .frame(width: 28, height: 28)
                        .overlay {
                            Image(systemName: "tag")
                                .font(.system(size: 16))
                                .foregroundStyle(Color(hex: label.color ?? "#A6A6A6"))
                        }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(label.name)
                            .tfText(.body)
                            .foregroundStyle(Color.tfText)
                            .lineLimit(1)
                        if let count = taskCounts?[label.id] ?? (taskCounts != nil ? 0 : nil) {
                            Text(count == 0 ? "Нет задач" : "\(count) \(DirectoryPluralize.taskWord(count))")
                                .tfText(.caption)
                                .foregroundStyle(Color.tfSub)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, TFSpacing.md)
                .padding(.leading, TFSpacing.lg)
            }
            .buttonStyle(TFTapRowStyle())

            Button { editingID = label.id } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 16))
                    .foregroundStyle(Color.tfDim)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                    .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())

            Button { requestDelete(label) } label: {
                Image(systemName: "trash")
                    .font(.system(size: 16))
                    .foregroundStyle(Color.tfDim)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                    .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())
            .padding(.trailing, TFSpacing.xs)
        }
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private var emptyState: some View {
        VStack(spacing: TFSpacing.md) {
            Circle()
                .fill(Color.tfCard)
                .frame(width: 64, height: 64)
                .overlay {
                    Image(systemName: "tag")
                        .font(.system(size: 28))
                        .foregroundStyle(Color.tfDim)
                }
            Text("Меток пока нет")
                .tfText(.title)
                .foregroundStyle(Color.tfText)
            Text("Метки помогают группировать задачи по-своему — независимо от проектов и сроков. Создайте первую, а состав всегда можно поменять позже.")
                .tfText(.row)
                .foregroundStyle(Color.tfSub)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
            TFButton("Создать метку", icon: "plus", variant: .primary) { showCreate = true }
                .frame(width: 200)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.horizontal, TFSpacing.lg)
    }

    /// Счётчик — производный от уже загруженного кэша задач (`TaskStore.tasks`),
    /// не отдельный запрос (spec §9). `nil` пока кэш реально пустой холодный —
    /// как только `.task{}` выше прогреет `taskStore`, у всех меток появится число.
    private var taskCounts: [String: Int]? {
        if taskStore.tasks.isEmpty && taskStore.isLoading { return nil }
        var counts: [String: Int] = [:]
        for task in taskStore.tasks {
            for label in task.labels { counts[label.id, default: 0] += 1 }
        }
        return counts
    }

    /// Текст зависит от того, известно ли число задач (spec §9 + `LabelsScreen.tsx`).
    private func requestDelete(_ label: ApiLabel) {
        let count = taskCounts?[label.id]
        let description: String
        if let count {
            description = count > 0
                ? "Она снимется со всех задач, которым сейчас назначена (\(count) \(DirectoryPluralize.taskWord(count))). Сами задачи не удалятся — только метка на них."
                : "Сейчас ею не помечена ни одна задача. Действие нельзя отменить."
        } else {
            description = "Она снимется со всех задач, которым сейчас назначена, если такие есть. Сами задачи не удалятся — только метка на них. Действие нельзя отменить."
        }
        deleteRequest = DirectoryConfirmRequest(
            title: "Удалить метку «\(label.name)»?",
            description: description,
            onConfirm: { Task { await labelStore.delete(labelId: label.id) } }
        )
    }
}

/// Форма создания — над списком, а не по месту строки (spec §9, `showCreate`).
private struct LabelCreateForm: View {
    @Environment(LabelStore.self) private var labelStore
    let onCreated: () -> Void
    let onCancel: () -> Void

    @State private var name = ""
    @State private var color = DirectoryColors.label[0]
    @State private var isSaving = false

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            TextField("Название метки", text: $name)
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .padding(.horizontal, TFSpacing.sm + 4)
                .padding(.vertical, TFSpacing.sm + 2)
                .background(Color.tfCard2)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))

            DirectoryColorSwatches(colors: DirectoryColors.label, selected: $color, size: 26)

            TFErrorBanner(labelStore.errorMessage, variant: .block)

            TFButton(isSaving ? "Создаём…" : "Создать", variant: .primary, isEnabled: !name.trimmingCharacters(in: .whitespaces).isEmpty && !isSaving) {
                Task { await create() }
            }
        }
        .padding(TFSpacing.lg)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    private func create() async {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        isSaving = true
        defer { isSaving = false }
        if await labelStore.create(name: trimmed, color: color) != nil {
            onCreated()
        }
    }
}

/// Инлайн-правка по месту строки (spec §9, симметрично `ProjectEditForm`) —
/// свой `APIClient()` для `patchLabel` (`LabelStore` метода `update` не даёт),
/// после успеха просит стор перезагрузиться, чтобы кэш не разошёлся с сервером.
private struct LabelEditForm: View {
    @Environment(LabelStore.self) private var labelStore
    let label: ApiLabel
    let onSaved: () -> Void
    let onCancel: () -> Void

    @State private var name: String
    @State private var color: String
    @State private var isSaving = false
    @State private var errorMessage: String?
    private let apiClient = APIClient()

    init(label: ApiLabel, onSaved: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.label = label
        self.onSaved = onSaved
        self.onCancel = onCancel
        _name = State(initialValue: label.name)
        _color = State(initialValue: label.color ?? DirectoryColors.label[0])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            TextField("Название метки", text: $name)
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .padding(.horizontal, TFSpacing.sm + 4)
                .padding(.vertical, TFSpacing.sm + 2)
                .background(Color.tfCard2)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))

            DirectoryColorSwatches(colors: DirectoryColors.label, selected: $color, size: 26)

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
            // Сервер 400-ит PATCH без `name`, даже когда меняется только цвет
            // (проверено чтением `LabelsScreen.tsx` — комментарий у `handleSave`) —
            // поэтому оба поля шлём всегда, не только изменившееся.
            _ = try await apiClient.patchLabel(id: label.id, fields: ["name": .string(trimmed), "color": .string(color)])
            await labelStore.load()
            onSaved()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось сохранить метку"
        }
    }
}
