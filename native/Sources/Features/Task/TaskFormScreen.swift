import SwiftUI

/// Форма задачи — spec/SCREENS-1.md §5.5, обслуживает `/task/new` и
/// `/task/:id/edit` ОДНОЙ структурой (различие — заголовок секции и способ
/// отправки патча). Имя и параметр — контракт `INTEGRATION.md`, буквально.
///
/// ⚠️ 31.08.2026, задача «компактное создание»: полноэкранный бланк при
/// СОЗДАНИИ (`taskID == nil`) владелец назвал «формой заявки на анкету» —
/// заменён компактной панелью `QuickAddTaskView` (см. файл рядом), эта
/// структура при создании теперь ТОЛЬКО хост для неё и площадка для
/// «развернуть». Редактирование (`taskID != nil`) — без изменений, старое
/// полноэкранное тело (`fullFormBody`) как было.
struct TaskFormScreen: View {
    let taskID: String?

    @State private var viewModel: TaskFormViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(TaskStore.self) private var taskStore
    @Environment(ProjectStore.self) private var projectStore
    @Environment(LabelStore.self) private var labelStore
    @FocusState private var isTitleFocused: Bool

    /// Показывает `QuickAddTaskView` как `.sheet` НАД этим экраном — временный
    /// мост, пока точка входа («+» → «Задача» в `RootShellView.swift`, App/,
    /// чужая папка) не переключена на прямой показ панели без пуша (диф —
    /// в отчёте оркестратору). Пока мост жив: перед панелью на мгновение
    /// виден пустой фон вместо экрана-источника — известный, не финальный вид.
    @State private var showQuickAdd: Bool
    /// «Развернуть» из панели — та же вью-модель (не копия: в
    /// `TaskAttachmentsController` уже могут лежать выбранные локальные
    /// файлы, копия их потеряла бы), эта же структура показывает `fullFormBody`.
    @State private var isExpanded: Bool

    /// `presetDueToday`/`startDictation` — контракт `INTEGRATION.md`,
    /// обновлён оркестратором по ходу этой задачи (`/task/new?due=today`,
    /// `/task/new?dictate=1` из `CreateMenu` веба). Диктовку саму не
    /// подключаю (в проекте нет живого ASR-провода на native, см.
    /// `NATIVE-PARTS.md`) — только состояние: поле названия сфокусировано,
    /// кнопка микрофона показана (по прямой просьбе оркестратора).
    init(taskID: String?, presetDueToday: Bool = false, startDictation: Bool = false) {
        self.taskID = taskID
        self._viewModel = State(initialValue: TaskFormViewModel(taskID: taskID, presetDueToday: presetDueToday, startDictation: startDictation))
        self._showQuickAdd = State(initialValue: taskID == nil)
        self._isExpanded = State(initialValue: false)
    }

    /// «Развернуть» из `QuickAddTaskView` — тот же экран, СРАЗУ с готовой
    /// вью-моделью и в режиме полной формы (сохранение всё ещё «создание»:
    /// `viewModel.taskID == nil`, поэтому различаем через `isExpanded`, не
    /// через `isEditing`).
    init(expandingFrom viewModel: TaskFormViewModel) {
        self.taskID = viewModel.taskID
        self._viewModel = State(initialValue: viewModel)
        self._showQuickAdd = State(initialValue: false)
        self._isExpanded = State(initialValue: true)
    }

    var body: some View {
        if viewModel.isEditing || isExpanded {
            fullFormBody
        } else {
            // Создание, панель ещё не показана/уже закрыта — фон-заглушка
            // моста (см. комментарий у `showQuickAdd`).
            Color.tfBackground
                .ignoresSafeArea()
                .toolbar(.hidden, for: .navigationBar)
                .sheet(isPresented: $showQuickAdd, onDismiss: {
                    // `isExpanded` к этому моменту уже true, если сюда пришли
                    // через «развернуть» (устанавливается синхронно ДО сброса
                    // showQuickAdd в onExpand ниже) — тогда экран не закрываем,
                    // а показываем `fullFormBody`. Иначе (сохранили или смахнули
                    // панель вниз) — обычное закрытие экрана создания.
                    if !isExpanded { dismiss() }
                }) {
                    QuickAddTaskView(
                        viewModel: viewModel,
                        onSaved: { showQuickAdd = false },
                        onExpand: {
                            isExpanded = true
                            showQuickAdd = false
                        }
                    )
                }
        }
    }

    private var fullFormBody: some View {
        VStack(spacing: 0) {
            header
            if viewModel.isLoadingTask {
                TFLoading(.block)
                Spacer()
            } else if viewModel.notFound {
                Spacer()
                TFEmptyState(text: "Задача не найдена")
                Spacer()
            } else {
                ScrollView {
                    content
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                        .padding(.top, TFSpacing.lg)
                        .padding(.bottom, TFSpacing.xl * 2)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
        .background(Color.tfBackground)
        .overlay(alignment: .bottomTrailing) { if isTitleFocused { micKeyboardBar } }
        // Нативная сворачивающаяся шапка по официальным гайдам SwiftUI.
        .navigationTitle(viewModel.title.isEmpty ? "Новая задача" : viewModel.title)
        .navigationBarTitleDisplayMode(.large)
        .task {
            await viewModel.loadIfNeeded()
            await viewModel.loadAgents()
            if viewModel.startDictation { isTitleFocused = true }
        }
    }

    /// `MicKeyboardBar` — spec/SCREENS-2.md §0.7: плавающая круглая кнопка
    /// 44×44 над клавиатурой, полупрозрачное стекло. Здесь ТОЛЬКО видимость
    /// по фокусу поля названия — само распознавание не подключено (см. header).
    private var micKeyboardBar: some View {
        Button {
            // Не подключено — см. комментарий у `init`.
        } label: {
            Image(systemName: "mic.fill")
                .font(.system(size: 18))
                .foregroundStyle(Color.tfText)
                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(TFTapScaleStyle())
        .padding(.trailing, TFSpacing.lg)
        .padding(.bottom, TFSpacing.lg)
    }

    // MARK: - Шапка (variant="compact": крестик слева, «Готово»/«Сохранение…» справа —
    // ТЕКСТОВАЯ кнопка-действие, которую `TFScreenHeader` не поддерживает
    // (его `actions` — только иконки), поэтому шапка здесь своя, той же
    // геометрии 48pt/ultraThinMaterial. Предложение в отчёте — завести
    // текстовый вариант действия в `TFScreenHeader`.

    private var header: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 18))
                    .foregroundStyle(Color.tfText)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
            }
            .buttonStyle(TFTapScaleStyle())
            Spacer()
            Button {
                Task { await submit() }
            } label: {
                Text(viewModel.isSaving ? "Сохранение…" : "Готово")
                    .tfText(.title)
                    .foregroundStyle(Color.tfRed)
                    .opacity(viewModel.isSaveEnabled ? 1 : 0.5)
            }
            .buttonStyle(TFTapFadeStyle())
            .disabled(!viewModel.isSaveEnabled)
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(height: 48)
        // Общий фон шапок — полупрозрачный blur (frosted glass) в вебе,
        // в SwiftUI это `.background(.ultraThinMaterial)`. Сплошной Color.tfCard
        // (был в коммите 12) — это НЕ как в вебе.
        // safeAreaInset, не навбар — явный `.background`, потому что
        // штатный `toolbarBackground` сюда не доходит (Claude_Bot 02.09.2026).
        .background(.ultraThinMaterial)
    }

    // MARK: - Тело

    @ViewBuilder
    private var content: some View {
        VStack(alignment: .leading, spacing: TFSpacing.xl) {
            Text(viewModel.isEditing ? "Изменить задачу" : "Новая задача")
                .tfText(.taskTitle)
                .foregroundStyle(Color.tfText)

            if viewModel.showAiButton {
                aiStructureButton
            }

            titleField
            noteSection
            subtasksSection
            AttachmentsFieldView(controller: viewModel.attachments)

            TFFieldGroup {
                DueDateFieldView(dueDate: $viewModel.dueDate, startMinutes: $viewModel.startMinutes, durationMin: $viewModel.durationMin)
                TFFieldDivider()
                ProjectFieldView(projects: projectStore.projects, selectedProjectId: $viewModel.projectId)
                TFFieldDivider()
                PriorityFieldView(priority: $viewModel.priority)
                TFFieldDivider()
                LabelsFieldView(allLabels: labelStore.labels, selectedIds: $viewModel.selectedLabelIds)
            }

            AssigneeFieldView(agents: viewModel.agents, selectedAgentId: $viewModel.assigneeId)

            TFErrorBanner(viewModel.directoriesErrorMessage, variant: .block)
            TFErrorBanner(viewModel.saveErrorMessage, variant: .block)
        }
    }

    private var aiStructureButton: some View {
        Button {
            // Стаб: `/ai/structure-task` есть на сервере (spec/API.md §5.11),
            // но точная форма ответа не проверена живым запросом в этой
            // задаче — рисковать угадыванием decode-схемы не стал (см. отчёт).
        } label: {
            HStack(spacing: TFSpacing.sm) {
                Image(systemName: "sparkles").font(.system(size: 14, weight: .semibold))
                Text("Структурировать с AI").tfText(.body).fontWeight(.semibold)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, TFSpacing.lg)
            .padding(.vertical, TFSpacing.sm)
            .background(
                LinearGradient(colors: [.tfPurple, .tfPink], startPoint: .leading, endPoint: .trailing)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private var titleField: some View {
        TextField("", text: $viewModel.title, prompt: Text("Название задачи").foregroundStyle(Color.tfDim), axis: .vertical)
            .tfText(.input)
            .foregroundStyle(Color.tfText)
            .lineLimit(1...6)
            .focused($isTitleFocused)
    }

    private var noteSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Заметка").tfText(.title).foregroundStyle(Color.tfText)
            TextField("", text: $viewModel.taskDescription, prompt: Text("Описание").foregroundStyle(Color.tfDim), axis: .vertical)
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .lineLimit(1...10)
        }
    }

    @ViewBuilder
    private var subtasksSection: some View {
        if viewModel.isEditing {
            SubtaskEditListView(
                subtasks: viewModel.subtasks,
                onReorder: { newOrder in Task { await viewModel.reorderSubtasks(newOrder) } },
                onRename: { subtask, newTitle in Task { await viewModel.renameSubtask(subtask, to: newTitle) } },
                onDelete: { subtask in Task { await viewModel.deleteSubtask(subtask) } },
                onAdd: { title in Task { await viewModel.addSubtask(title) } }
            )
        } else {
            SubtaskDraftListView(drafts: $viewModel.subtaskDrafts)
        }
    }

    private func submit() async {
        if await viewModel.save(taskStore: taskStore) {
            dismiss()
        }
    }
}
