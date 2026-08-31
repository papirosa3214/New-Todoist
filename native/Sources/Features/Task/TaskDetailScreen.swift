import SwiftUI
import UniformTypeIdentifiers

/// Карточка задачи — spec/SCREENS-1.md §5.4 + компоненты из
/// spec/SCREENS-2.md §19 (`SubtaskFeed`, `TaskJournal`, `AttachmentsField`).
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
        VStack(spacing: 0) {
            header
            if viewModel.isLoading {
                TFLoading(.block)
                Spacer()
            } else if viewModel.notFound {
                Spacer()
                TFEmptyState(text: "Задача не найдена")
                Spacer()
            } else if let task = viewModel.task {
                ScrollView {
                    body(for: task)
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                        .padding(.top, TFSpacing.lg)
                        .padding(.bottom, TFSpacing.xl * 2)
                }
            } else {
                Spacer()
                TFErrorBanner(viewModel.loadErrorMessage, variant: .block)
                    .padding(.horizontal, TFSpacing.screenHorizontal)
                Spacer()
            }
        }
        .background(Color.tfBackground)
        .toolbar(.hidden, for: .navigationBar)
        .taskToast($toast)
        .taskConfirm($confirmRequest)
        .fileImporter(isPresented: $isTaskFilePickerPresented, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await viewModel.attachTaskFile(url: url) } }
        }
        .fileImporter(isPresented: $isCommentFilePickerPresented, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result { Task { await viewModel.attachCommentFile(url: url) } }
        }
        .task { await viewModel.load() }
    }

    // MARK: - Шапка: variant="compact", заголовок пуст (сама задача — заголовок
    // тела). 3 действия — trash КОРАЛЛОВЫЙ, чего готовый `TFIconButton` не
    // умеет (фикс. `Color.tfText`) — своя шапка, та же геометрия 48pt.

    private var header: some View {
        HStack(spacing: TFSpacing.headerActionsGap) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18))
                    .foregroundStyle(Color.tfText)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
            }
            .buttonStyle(TFTapScaleStyle())
            Spacer()
            headerIcon("waveform.path.ecg") { outputDynamicIsland() }
            headerIcon("bookmark") { saveAsTemplate() }
            headerIcon("trash", tint: .tfCoral) { requestDelete() }
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(height: 48)
        .background(.ultraThinMaterial)
    }

    private func headerIcon(_ systemName: String, tint: Color = .tfText, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 18))
                .foregroundStyle(tint)
                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
        }
        .buttonStyle(TFTapScaleStyle())
    }

    // MARK: - Тело

    @ViewBuilder
    private func body(for task: ApiTask) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.xl) {
            if let projectName = task.projectName {
                Text("# \(projectName)")
                    .tfText(.body).fontWeight(.semibold)
                    .foregroundStyle(task.projectColor.map { Color(hex: $0) } ?? .tfBlue)
            }

            HStack(alignment: .top) {
                Text(task.title)
                    .tfText(.taskTitle)
                    .foregroundStyle(Color.tfText)
                    .strikethrough(task.status == .completed)
                Spacer()
                TFPriorityFlag(TaskPriority(rawValue: task.priority) ?? .low)
            }

            if let description = task.description, !description.isEmpty {
                Text(description).tfText(.body).foregroundStyle(Color.tfSub)
            }

            attachmentsSection(task)
            metadataCard(task)

            if !task.labels.isEmpty {
                FlowLayout(spacing: TFSpacing.xs) {
                    ForEach(task.labels) { label in
                        TFLabelPill(label.name, color: Color(hex: label.color ?? "#A6A6A6"))
                    }
                }
            }

            if !task.subtasks.isEmpty {
                SubtaskFeedView(
                    subtasks: task.subtasks, isOwner: isOwner,
                    onToggleDone: { subtask in Task { await viewModel.toggleSubtaskDone(subtask) } },
                    onSubmitReply: { subtask, text in Task { await viewModel.replyToSubtask(subtask, text: text) } },
                    onAccept: { subtask in Task { await viewModel.acceptSubtask(subtask) } }
                )
            }

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
            }

            actionButtons(task)

            TFErrorBanner(viewModel.actionErrorMessage, variant: .block)

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
        }
    }

    // MARK: - Вложения (AttachmentView — вне подробного разбора спеки,
    // геометрия строки взята из `AttachmentsField` §19.3, тот же паттерн).

    @ViewBuilder
    private func attachmentsSection(_ task: ApiTask) -> some View {
        let attachments = task.attachments ?? []
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
                ForEach(attachments) { attachment in
                    HStack(spacing: TFField.iconTextGap) {
                        Image(systemName: TaskAttachmentDisplay.icon(mime: attachment.mime))
                            .font(.system(size: TFIconSize.sm)).foregroundStyle(Color.tfDim)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(attachment.fileName).tfText(.body).foregroundStyle(Color.tfText).lineLimit(1)
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
                        Image(systemName: "paperclip").font(.system(size: TFIconSize.sm)).foregroundStyle(Color.tfDim)
                        Text("Прикрепить файл").tfText(.action).foregroundStyle(Color.tfSub)
                        Spacer()
                    }
                    .padding(.horizontal, TFField.cardInsetH)
                    .frame(height: 40)
                }
                .buttonStyle(TFTapRowStyle())
        }
    }

    // MARK: - Метаданные

    private func metadataCard(_ task: ApiTask) -> some View {
        TFCard(padding: 0) {
            VStack(spacing: 0) {
                if let dueRow = dueMetaText(task) {
                    metaRow(icon: "calendar", text: dueRow, color: task.isOverdueNow ? .tfRed : .tfText)
                    TFDivider(inset: TFSpacing.lg)
                }
                let priority = TaskPriority(rawValue: task.priority) ?? .low
                metaRow(icon: "flag", text: priority.label, color: priority.color)
                if let assigneeName = task.assigneeName {
                    TFDivider(inset: TFSpacing.lg)
                    HStack(spacing: TFSpacing.md) {
                        TFAvatar(size: .sm, initials: task.assigneeInitials ?? "?",
                                  tint: task.assigneeColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
                        Text(assigneeName).tfText(.body).foregroundStyle(Color.tfText)
                        Spacer()
                    }
                    .padding(.horizontal, TFSpacing.lg)
                    .padding(.vertical, TFSpacing.md)
                }
            }
        }
    }

    private func metaRow(icon: String, text: String, color: Color) -> some View {
        HStack(spacing: TFSpacing.md) {
            Image(systemName: icon).font(.system(size: TFIconSize.sm)).foregroundStyle(color)
            Text(text).tfText(.body).foregroundStyle(color)
            Spacer()
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.vertical, TFSpacing.md)
    }

    private func dueMetaText(_ task: ApiTask) -> String? {
        guard let dueDate = task.dueDateAsDate else { return nil }
        let label = TaskDateText.dueLabel(dueDate)
        guard let startTime = task.startTime else { return label }
        return "\(label) · \(TaskDateText.timeRange(start: startTime, durationMin: task.durationMin))"
    }

    // MARK: - Кнопки действий

    @ViewBuilder
    private func actionButtons(_ task: ApiTask) -> some View {
        VStack(spacing: TFSpacing.sm) {
            if task.status == .active && task.agentState == nil {
                TFButton("Завершить задачу", icon: "checkmark", variant: .primary) { requestComplete(task) }
            } else if task.status == .completed {
                TFButton("Открыть задачу заново", icon: "arrow.triangle.2.circlepath", variant: .secondary) {
                    Task { await viewModel.reopen() }
                }
            }
            NavigationLink(value: AppRoute.taskForm(taskID: task.id)) {
                Text("Изменить")
                    .tfText(.body).fontWeight(.semibold)
                    .foregroundStyle(Color.tfSub)
                    .frame(maxWidth: .infinity)
                    .frame(height: TFButtonMetrics.height)
                    .overlay {
                        RoundedRectangle(cornerRadius: TFButtonMetrics.radius).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width)
                    }
            }
            .buttonStyle(TFTapScaleStyle())
        }
    }

    // MARK: - Действия шапки

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

    private func requestDelete() {
        confirmRequest = TaskConfirmRequest(
            title: "Удалить задачу без возможности отмены?",
            confirmLabel: "Удалить", cancelLabel: "Отмена", danger: true
        ) {
            Task {
                await viewModel.delete(taskStore: taskStore)
                dismiss()
            }
        }
    }

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
            title: "Завершить задачу?", description: description,
            confirmLabel: "Завершить", cancelLabel: "Отмена", danger: false
        ) {
            Task { await viewModel.complete() }
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
