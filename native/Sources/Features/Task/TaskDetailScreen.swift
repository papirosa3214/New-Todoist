import SwiftUI
import UniformTypeIdentifiers

/// Карточка задачи — вид TickTick: шторка с компактными строками.
/// spec/SCREENS-1.md §5.4 — данные те же, только внешний вид изменён.
/// Имя и параметр — контракт `INTEGRATION.md`, буквально.
struct TaskDetailScreen: View {
    let taskID: String

    @State private var viewModel: TaskDetailViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var session
    @Environment(TaskStore.self) private var taskStore

    @State private var toast: TaskToastMessage?
    @State private var confirmRequest: TaskConfirmRequest?
    @State private var isTaskFilePickerPresented = false
    @State private var isCommentFilePickerPresented = false

    init(taskID: String) {
        self.taskID = taskID
        self._viewModel = State(initialValue: TaskDetailViewModel(taskID: taskID))
    }

    var body: some View {
        ZStack {
            Color.tfBackground
                .ignoresSafeArea()

            if viewModel.isLoading {
                VStack {
                    Spacer()
                    TFLoading(.block)
                    Spacer()
                }
            } else if viewModel.notFound {
                VStack {
                    Spacer()
                    TFEmptyState(text: "Задача не найдена")
                    Spacer()
                }
            } else if let task = viewModel.task {
                ScrollView {
                    VStack(spacing: 0) {
                        // Пространство перед карточкой
                        Color.clear.frame(height: TFSpacing.lg)

                        // Основная карточка с данными
                        metadataCard(task)
                            .padding(.horizontal, TFSpacing.screenHorizontal)

                        // Вложения
                        if !(task.attachments ?? []).isEmpty {
                            attachmentsSection(task)
                                .padding(.horizontal, TFSpacing.screenHorizontal)
                                .padding(.top, TFSpacing.xl)
                        }

                        // Метки
                        if !task.labels.isEmpty {
                            labelsSection(task)
                                .padding(.horizontal, TFSpacing.screenHorizontal)
                                .padding(.top, TFSpacing.xl)
                        }

                        // Подзадачи
                        if !task.subtasks.isEmpty {
                            SubtaskFeedView(
                                subtasks: task.subtasks, isOwner: isOwner,
                                onToggleDone: { subtask in Task { await viewModel.toggleSubtaskDone(subtask) } },
                                onSubmitReply: { subtask, text in Task { await viewModel.replyToSubtask(subtask, text: text) } },
                                onAccept: { subtask in Task { await viewModel.acceptSubtask(subtask) } }
                            )
                            .padding(.horizontal, TFSpacing.screenHorizontal)
                            .padding(.top, TFSpacing.xl)
                        }

                        // Дочерние задачи
                        if let children = task.children, !children.isEmpty {
                            VStack(alignment: .leading, spacing: TFSpacing.sm) {
                                Text("Дочерние задачи").tfText(.action).foregroundStyle(Color.tfSub)
                                TFFieldGroup {
                                    ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                                        TFTaskRow(rowModel(for: child)) {}
                                        if index != children.count - 1 { TFFieldDivider() }
                                    }
                                }
                            }
                            .padding(.horizontal, TFSpacing.screenHorizontal)
                            .padding(.top, TFSpacing.xl)
                        }

                        // Кнопки действий
                        actionButtons(task)
                            .padding(.horizontal, TFSpacing.screenHorizontal)
                            .padding(.top, TFSpacing.xl)

                        // Сообщение об ошибке
                        if let actionError = viewModel.actionErrorMessage, actionError.isEmpty == false {
                            TFErrorBanner(actionError, variant: .block)
                                .padding(.horizontal, TFSpacing.screenHorizontal)
                                .padding(.top, TFSpacing.md)
                        }

                        // Лента комментариев
                        TaskJournalView(
                            task: task,
                            entries: viewModel.journalEntries,
                            isOwner: isOwner,
                            composerText: $viewModel.commentText,
                            onSend: { Task { await viewModel.sendComment() } },
                            onAttach: { isCommentFilePickerPresented = true },
                            pendingFileNames: viewModel.pendingCommentAttachments.map(\.name),
                            onRemovePendingFile: { viewModel.removePendingCommentAttachment(at: $0) },
                            onOwnerAction: { kind, comment in Task { await viewModel.performOwnerAction(kind, comment: comment) } }
                        )
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                        .padding(.top, TFSpacing.xl)

                        Color.clear.frame(height: TFSpacing.xl * 2)
                    }
                }
                .safeAreaInset(edge: .top) {
                    sheetHeader
                }
            } else {
                VStack {
                    Spacer()
                    TFErrorBanner(viewModel.loadErrorMessage, variant: .block)
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                    Spacer()
                }
            }
        }
        // Нативная сворачивающаяся шапка (большой заголовок сворачивается в плашку).
        .navigationTitle(viewModel.task?.title ?? "Задача")
        .navigationBarTitleDisplayMode(.large)
        .taskToast($toast)
        .taskConfirm($confirmRequest)
        .fileImporter(isPresented: $isTaskFilePickerPresented, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await viewModel.attachTaskFile(url: url) } }
        }
        .fileImporter(isPresented: $isCommentFilePickerPresented, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await viewModel.attachCommentFile(url: url) } }
        }
        .task { await viewModel.load() }
        // Реалтайм кладёт свежую задачу (включая derived `subtask.state`) в
        // TaskStore. Детальная карточка держит расширенный отдельный снимок,
        // поэтому тихо перечитываем его только при изменении своей задачи.
        // Так `running` немедленно включает уже существующий спиннер, а
        // обычное кольцо ожидания (`pending`) остаётся без изменений.
        .onChange(of: liveTask) { _, updated in
            guard updated != nil else { return }
            Task { await viewModel.refreshAfterRealtimeUpdate() }
        }
    }

    private var liveTask: ApiTask? {
        taskStore.tasks.first(where: { $0.id == taskID })
    }

    // MARK: - Шапка шторки: ручка, кнопка закрытия, кнопка меню

    private var sheetHeader: some View {
        VStack(spacing: TFSpacing.md) {
            // Ручка
            RoundedRectangle(cornerRadius: TFSheet.handleHeight / 2)
                .fill(Color.tfDim)
                .frame(width: TFSheet.handleWidth, height: TFSheet.handleHeight)

            // Кнопки: X слева, меню справа
            HStack(spacing: TFSpacing.screenHorizontal) {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.tfText)
                        .frame(width: TFSheet.headerCloseSize, height: TFSheet.headerCloseSize)
                        .background(Circle().fill(Color.tfCard2))
                }
                .buttonStyle(TFTapScaleStyle())

                Spacer()

                Button(action: { showMenu() }) {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.tfText)
                        .frame(width: TFSheet.headerCloseSize, height: TFSheet.headerCloseSize)
                        .background(Circle().fill(Color.tfCard2))
                }
                .buttonStyle(TFTapScaleStyle())
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.top, TFSpacing.md)
            .padding(.bottom, TFSpacing.lg)
        }
        .background(Color.tfBackground)
        .background(
            VStack(spacing: 0) {
                Spacer()
                Divider()
                    .background(Color.tfStroke)
            }
        )
    }

    private func showMenu() {
        // TODO: добавить context menu или action sheet для меню
        // Действия: сохранить как шаблон, вывести в Dynamic Island
    }

    private func outputDynamicIsland() {
        // ⚠️ Тост по спеке, БЕЗ реального ActivityKit — Live Activity живёт в
        // отдельном таргете `Widgets` (см. `NATIVE-PARTS.md` §3), не в
        // `Features/Task`. Показывает успех безусловно — реального запуска нет.
        toast = TaskToastMessage("Задача выведена в Dynamic Island")
    }

    private func saveAsTemplate() {
        // ⚠️ На сервере нет эндпоинта шаблонов (проверено — в `server/src`
        // нет ни одного маршрута с «template») — тост показывается по спеке,
        // но ничего не сохраняется. См. отчёт.
        toast = TaskToastMessage("Задача сохранена в шаблоны")
    }

    // MARK: - Основная карточка метаданных в стиле TickTick

    private func metadataCard(_ task: ApiTask) -> some View {
        VStack(spacing: 0) {
            // Чекбокс + название задачи
            HStack(spacing: TFSpacing.md) {
                Button(action: {
                    if task.status == .completed {
                        Task { await viewModel.reopen() }
                    } else {
                        requestComplete(task)
                    }
                }) {
                    Image(systemName: task.status == .completed ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 22))
                        .foregroundStyle(task.status == .completed ? Color.tfTeal : Color.tfDim)
                }
                .buttonStyle(TFTapScaleStyle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .tfText(.body)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.tfText)
                        .strikethrough(task.status == .completed)
                        .lineLimit(2)

                    if let description = task.description, !description.isEmpty {
                        Text(description)
                            .tfText(.action)
                            .foregroundStyle(Color.tfSub)
                            .lineLimit(1)
                    }
                }

                Spacer()

                TFPriorityFlag(TaskPriority(rawValue: task.priority) ?? .low)
                    .frame(width: 20, height: 20)
            }
            .padding(.horizontal, TFSpacing.lg)
            .padding(.vertical, TFSpacing.md)

            // Разделитель
            TFDivider(inset: TFSpacing.lg)

            // Проект
            if let projectName = task.projectName {
                metaDataRow(
                    icon: "folder",
                    text: projectName,
                    color: task.projectColor.map { Color(hex: $0) } ?? .tfBlue
                )
                TFDivider(inset: TFSpacing.lg)
            }

            // Дата и время
            if let dueRow = dueMetaText(task) {
                metaDataRow(
                    icon: "calendar",
                    text: dueRow,
                    color: task.isOverdueNow ? .tfRed : .tfText
                )
                TFDivider(inset: TFSpacing.lg)
            }

            // Приоритет
            let priority = TaskPriority(rawValue: task.priority) ?? .low
            metaDataRow(
                icon: "flag",
                text: priority.label,
                color: priority.color
            )

            // Исполнитель
            if let assigneeName = task.assigneeName {
                TFDivider(inset: TFSpacing.lg)
                HStack(spacing: TFSpacing.md) {
                    TFAvatar(
                        size: .sm,
                        initials: task.assigneeInitials ?? "?",
                        tint: task.assigneeColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6")
                    )
                    Text(assigneeName)
                        .tfText(.body)
                        .foregroundStyle(Color.tfText)
                    Spacer()
                }
                .padding(.horizontal, TFSpacing.lg)
                .padding(.vertical, TFSpacing.md)
            }

            // Напоминание (если есть — спека говорит о звоночке)
            // Поле добавить, когда будет в модели данных
        }
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    /// Компактная строка метаданных: иконка (16×16) + текст, разделитель снизу
    private func metaDataRow(icon: String, text: String, color: Color) -> some View {
        HStack(spacing: TFSpacing.md) {
            Image(systemName: icon)
                .font(.system(size: TFIconSize.sm))
                .foregroundStyle(color)
                .frame(width: 22, alignment: .center)

            Text(text)
                .tfText(.body)
                .foregroundStyle(color)
                .lineLimit(1)

            Spacer()
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.vertical, TFSpacing.md)
    }

    /// Текст для отображения даты/времени — тот же, что в старом коде
    private func dueMetaText(_ task: ApiTask) -> String? {
        guard let dueDate = task.dueDateAsDate else { return nil }
        let label = TaskDateText.dueLabel(dueDate)
        guard let startTime = task.startTime else { return label }
        return "\(label) · \(TaskDateText.timeRange(start: startTime, durationMin: task.durationMin))"
    }

    // MARK: - Вложения

    @ViewBuilder
    private func attachmentsSection(_ task: ApiTask) -> some View {
        let attachments = task.attachments ?? []
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Вложения").tfText(.action).foregroundStyle(Color.tfSub)

            ForEach(attachments) { attachment in
                HStack(spacing: TFField.iconTextGap) {
                    Image(systemName: TaskAttachmentDisplay.icon(mime: attachment.mime))
                        .font(.system(size: TFIconSize.sm))
                        .foregroundStyle(Color.tfDim)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attachment.fileName)
                            .tfText(.body)
                            .foregroundStyle(Color.tfText)
                            .lineLimit(1)
                        if let size = TaskAttachmentDisplay.sizeText(attachment.size) {
                            Text(size).tfText(.action).foregroundStyle(Color.tfSub)
                        }
                    }
                    Spacer()
                }
                .padding(.horizontal, TFField.cardInsetH)
                .frame(minHeight: TFField.height)
                .background(Color.tfCard)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }

            Button {
                isTaskFilePickerPresented = true
            } label: {
                HStack(spacing: TFField.iconTextGap) {
                    Image(systemName: "paperclip")
                        .font(.system(size: TFIconSize.sm))
                        .foregroundStyle(Color.tfDim)
                    Text("Прикрепить файл")
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                    Spacer()
                }
                .padding(.horizontal, TFField.cardInsetH)
                .frame(height: 40)
            }
            .buttonStyle(TFTapRowStyle())
        }
    }

    // MARK: - Метки

    @ViewBuilder
    private func labelsSection(_ task: ApiTask) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Метки").tfText(.action).foregroundStyle(Color.tfSub)

            FlowLayout(spacing: TFSpacing.xs) {
                ForEach(task.labels) { label in
                    TFLabelPill(label.name, color: Color(hex: label.color ?? "#A6A6A6"))
                }
            }
        }
    }

    // MARK: - Кнопки действий

    @ViewBuilder
    private func actionButtons(_ task: ApiTask) -> some View {
        VStack(spacing: TFSpacing.sm) {
            if task.status == .active && task.agentState == nil {
                TFButton("Завершить задачу", icon: "checkmark", variant: .primary) {
                    requestComplete(task)
                }
            } else if task.status == .completed {
                TFButton("Открыть задачу заново", icon: "arrow.triangle.2.circlepath", variant: .secondary) {
                    Task { await viewModel.reopen() }
                }
            }

            NavigationLink(value: AppRoute.taskForm(taskID: task.id)) {
                Text("Изменить")
                    .tfText(.body)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.tfSub)
                    .frame(maxWidth: .infinity)
                    .frame(height: TFButtonMetrics.height)
                    .overlay {
                        RoundedRectangle(cornerRadius: TFButtonMetrics.radius)
                            .strokeBorder(Color.tfStroke, lineWidth: TFBorder.width)
                    }
            }
            .buttonStyle(TFTapScaleStyle())
        }
    }

    // MARK: - Действия

    private func requestComplete(_ task: ApiTask) {
        let openCount = viewModel.openSubtasksCount
        guard openCount > 0 else {
            Task { await viewModel.complete() }
            return
        }
        let description: String
        if openCount == 1, let onlyOpen = task.subtasks.first(where: { !$0.done }) {
            description = "Шаг «\(onlyOpen.title)» останется невыполненным, а задача уйдёт в готовые."
        } else {
            description = "Осталось невыполненных шагов: \(openCount). Завершить задачу?"
        }
        confirmRequest = TaskConfirmRequest(
            title: "Завершить задачу?",
            description: description,
            confirmLabel: "Завершить",
            cancelLabel: "Отмена",
            danger: false
        ) {
            Task { await viewModel.complete() }
        }
    }

    private func requestDelete() {
        confirmRequest = TaskConfirmRequest(
            title: "Удалить задачу без возможности отмены?",
            confirmLabel: "Удалить",
            cancelLabel: "Отмена",
            danger: true
        ) {
            Task {
                await viewModel.delete(taskStore: taskStore)
                dismiss()
            }
        }
    }

    private var isOwner: Bool { session.currentUser?.role == .owner }

    private func rowModel(for task: ApiTask) -> TFTaskRowModel {
        TFTaskRowModel(
            projectName: task.projectName,
            projectColor: task.projectColor.map { Color(hex: $0) },
            assigneeInitials: task.assigneeInitials,
            assigneeColor: task.assigneeColor.map { Color(hex: $0) },
            title: task.title,
            isDone: task.status == .completed,
            description: task.description,
            subtasksDone: task.subtasks.isEmpty ? nil : task.subtasks.count { $0.done },
            subtasksTotal: task.subtasks.isEmpty ? nil : task.subtasks.count,
            priority: TaskPriority(rawValue: task.priority),
            isOverdue: task.isOverdueNow,
            dueText: task.dueDateAsDate.map { TaskDateText.dueLabel($0) },
            labels: task.labels.map { ($0.name, Color(hex: $0.color ?? "#A6A6A6")) }
        )
    }
}

private extension ApiTask {
    /// `due_date < сегодня` (МСК) и задача ещё активна — просрочена.
    var isOverdueNow: Bool {
        guard status == .active, let due = dueDateAsDate else { return false }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TaskDateText.moscow
        return cal.startOfDay(for: due) < cal.startOfDay(for: Date())
    }
}
