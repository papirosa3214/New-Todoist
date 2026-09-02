import SwiftUI
import UniformTypeIdentifiers

// `TaskJournal` — spec/SCREENS-2.md §19.2 (тот же случай, что у SubtaskFeed:
// компонент карточки задачи, прямо адресованный этому экрану). Лента
// объединяет комментарии и системные события, новые СВЕРХУ.
//
// Упрощения относительно полной спеки (осознанно, см. отчёт):
// - «живая строка чем занят агент» (тикает раз в 2с) — статичный текст,
//   без опроса `activity.ts` (§5.14, отдельный крупный роут, не читан);
// - `ResumeSessionButton` — не сделан («служебная функциональность, для
//   нативного приложения актуальность уточнить отдельно», сама спека
//   разрешает пропустить);
// - формы владельца (ReturnToWorkSheet) — текстовое поле + отправка, без
//   микрофона/файла (диктовки в этой волне нигде нет, `NATIVE-PARTS.md` §0).
enum TaskJournalEntry: Identifiable {
    case comment(ApiComment)
    case event(ApiTaskEvent)

    var id: String {
        switch self {
        case .comment(let c): "c-\(c.id)"
        case .event(let e): "e-\(e.id)"
        }
    }

    var date: Date? {
        switch self {
        case .comment(let c): c.createdAtDate
        case .event(let e): e.createdAtDate
        }
    }

    /// Сортировка «новые сверху» — spec §19.2.
    static func merged(comments: [ApiComment], events: [ApiTaskEvent]) -> [TaskJournalEntry] {
        (comments.map(TaskJournalEntry.comment) + events.map(TaskJournalEntry.event))
            .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }
}

enum AgentOwnerActionKind {
    case acceptReview
    case returnToWorkFromReview
    case replyAndReturnFromBlocked
    case acceptAndClose
    case returnToWorkFromInProgress

    /// spec §7 `commentRequiredFor()` — переходы В blocked/review и
    /// review→in_progress требуют комментарий. Здесь релевантны два случая.
    var commentRequired: Bool {
        switch self {
        case .returnToWorkFromReview, .replyAndReturnFromBlocked: true
        default: false
        }
    }
}

struct TaskJournalView: View {
    let task: ApiTask
    let entries: [TaskJournalEntry]
    let isOwner: Bool
    @Binding var composerText: String
    var onSend: () -> Void
    var onAttach: () -> Void
    var pendingFileNames: [String]
    var onRemovePendingFile: (Int) -> Void
    var onOwnerAction: (AgentOwnerActionKind, String?) -> Void

    @State private var pendingAction: AgentOwnerActionKind?
    @State private var actionComment = ""

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            if task.agentState != nil {
                agentStatusRow
                if isOwner { ownerActions }
            }

            Text("Лента").tfText(.action).foregroundStyle(Color.tfSub)
            composer

            ForEach(entries) { entry in
                switch entry {
                case .comment(let comment): commentCard(comment)
                case .event(let event): eventRow(event)
                }
            }
        }
        .sheet(item: $pendingAction) { action in
            TFBottomSheetContent(title: "Комментарий", onClose: { pendingAction = nil }) {
                VStack(alignment: .leading, spacing: TFSpacing.md) {
                    TFTextField(action.commentRequired ? "Комментарий (обязателен)" : "Комментарий (необязательно)", text: $actionComment)
                    TFButton("Отправить", variant: .primary, isEnabled: !action.commentRequired || !actionComment.trimmingCharacters(in: .whitespaces).isEmpty) {
                        onOwnerAction(action, actionComment.isEmpty ? nil : actionComment)
                        actionComment = ""
                        pendingAction = nil
                    }
                }
                .padding(.bottom, TFSpacing.xl)
            }
            .presentationDetents([.height(220)])
            .presentationDragIndicator(.hidden)
            .presentationBackground(Color.tfCard)
        }
    }

    // MARK: - Статус агента

    @ViewBuilder
    private var agentStatusRow: some View {
        if task.agentStale == true {
            VStack(alignment: .leading, spacing: 4) {
                Text("Агент пропал").tfText(.body).fontWeight(.semibold).foregroundStyle(Color.tfCoral)
                Text("Аренда истекла — последний сигнал: \(lastSignalText)")
                    .tfText(.action).foregroundStyle(Color.tfCoral)
            }
            .padding(TFSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.tfCoral.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        } else if let state = task.agentState {
            Text(agentStateLabel(state))
                .tfText(.body)
                .fontWeight(.semibold)
                .foregroundStyle(agentStateColor(state))
                .padding(.horizontal, TFSpacing.md)
                .padding(.vertical, TFSpacing.sm)
                .background(agentStateColor(state).opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
    }

    private var lastSignalText: String {
        guard let heartbeat = DateFormats.sqliteUTC(task.agentHeartbeatAt) else { return "неизвестно" }
        return TaskDateText.relativeTime(heartbeat)
    }

    private func agentStateLabel(_ state: AgentState) -> String {
        switch state {
        case .inProgress: "Агент работает"
        case .blocked: "Заблокировано — нужны ваши действия"
        case .review: "На проверке — ждёт вашей приёмки"
        }
    }

    private func agentStateColor(_ state: AgentState) -> Color {
        switch state {
        case .inProgress: .tfTeal
        case .blocked: .tfOrange
        case .review: .tfBlue
        }
    }

    @ViewBuilder
    private var ownerActions: some View {
        switch task.agentState {
        case .review:
            HStack(spacing: TFSpacing.sm) {
                TFButton("Принять", icon: "checkmark", variant: .primary) { onOwnerAction(.acceptReview, nil) }
                TFButton("Вернуть на доработку", variant: .secondary) { pendingAction = .returnToWorkFromReview }
            }
        case .blocked:
            HStack(spacing: TFSpacing.sm) {
                TFButton("Ответить и вернуть в работу", variant: .primary) { pendingAction = .replyAndReturnFromBlocked }
                TFButton("Принять и закрыть задачу", variant: .secondary) { onOwnerAction(.acceptAndClose, nil) }
            }
        case .inProgress:
            HStack(spacing: TFSpacing.sm) {
                TFButton("Вернуть на доработку", variant: task.agentStale == true ? .primary : .secondary) {
                    onOwnerAction(.returnToWorkFromInProgress, nil)
                }
                TFButton("Принять и закрыть задачу", variant: .secondary) { onOwnerAction(.acceptAndClose, nil) }
            }
        case nil:
            EmptyView()
        }
    }

    // MARK: - Композер

    private var composer: some View {
        VStack(alignment: .leading, spacing: TFSpacing.xs) {
            if !pendingFileNames.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: TFSpacing.xs) {
                        ForEach(Array(pendingFileNames.enumerated()), id: \.offset) { index, name in
                            HStack(spacing: 4) {
                                Text(name).tfText(.caption).foregroundStyle(Color.tfSub).lineLimit(1)
                                Button { onRemovePendingFile(index) } label: {
                                    Image(systemName: "xmark").font(.system(size: 9)).foregroundStyle(Color.tfDim)
                                }
                            }
                            .padding(.horizontal, TFSpacing.sm).padding(.vertical, 4)
                            .background(Color.tfCard2).clipShape(Capsule())
                        }
                    }
                }
            }
            HStack(spacing: TFSpacing.sm) {
                Button(action: onAttach) {
                    Image(systemName: "paperclip").font(.system(size: TFIconSize.sm)).foregroundStyle(Color.tfDim)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
                .buttonStyle(TFTapScaleStyle())
                TFTextField("Комментарий…", text: $composerText)
                Button(action: onSend) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Color.tfRed)
                        .clipShape(Circle())
                }
                .buttonStyle(TFTapScaleStyle())
                .disabled(composerText.trimmingCharacters(in: .whitespaces).isEmpty && pendingFileNames.isEmpty)
            }
        }
    }

    // MARK: - Комментарий/событие

    private func commentCard(_ comment: ApiComment) -> some View {
        let isSystem = (comment.userName ?? "").isEmpty
        return HStack(alignment: .top, spacing: TFSpacing.sm) {
            if isSystem {
                Image(systemName: "gearshape.fill")
                    .tfText(.row)
                    .foregroundStyle(Color.tfDim)
                    .frame(width: 28, height: 28)
                    .background(Color.tfCard2)
                    .clipShape(Circle())
            } else {
                TFAvatar(size: .sm, initials: comment.userInitials ?? "?",
                          tint: comment.userColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: TFSpacing.xs) {
                    Text(isSystem ? "Система" : (comment.userName ?? ""))
                        .tfText(.action).fontWeight(.semibold).foregroundStyle(Color.tfText)
                    if let date = comment.createdAtDate {
                        Text(TaskDateText.relativeTime(date)).tfText(.caption).foregroundStyle(Color.tfDim)
                    }
                }
                Text(comment.text).tfText(.body).foregroundStyle(Color.tfText)
            }
        }
        .padding(.vertical, TFSpacing.xs)
    }

    private func eventRow(_ event: ApiTaskEvent) -> some View {
        HStack(spacing: TFSpacing.sm) {
            Circle().fill(Color.tfDim).frame(width: 5, height: 5)
            Text(Self.eventText(event)).tfText(.action).foregroundStyle(Color.tfSub)
            Spacer()
            if let date = event.createdAtDate {
                Text(TaskDateText.relativeTime(date)).tfText(.caption).foregroundStyle(Color.tfDim)
            }
        }
        .padding(.vertical, 4)
    }

    /// Словарь формулировок §19.2, ДОСЛОВНО. `kind` — открытая строка
    /// (`Core/Models/TaskEvent.swift`), сравниваем как есть.
    private static func eventText(_ event: ApiTaskEvent) -> String {
        switch event.kind {
        case "claimed": "взял задачу в работу"
        case "resumed_after_blocked": "вернулся к работе после блокировки"
        case "returned_to_work": "вернул задачу на доработку"
        case "submitted_review": "сдал задачу на проверку"
        case "blocked": "заблокировал задачу — нужны действия владельца"
        case "unclaimed": "снял задачу с агента"
        case "accepted": "принял задачу"
        case "reopened": "вернул задачу в работу"
        case "renamed": "переименовал задачу"
        case "priority_changed": "сменил приоритет"
        case "due_date_set": "поставил срок"
        case "due_date_cleared": "убрал срок"
        case "assigned": "назначил исполнителем"
        case "unassigned": "снял исполнителя"
        case "moved_to_project": "перенёс задачу в проект"
        case "removed_from_project": "убрал задачу из проекта"
        case "subtask_added": "добавил шаг"
        case "subtask_completed": "выполнил шаг"
        case "subtask_uncompleted": "снял отметку с шага"
        case "subtask_renamed": "переименовал шаг"
        case "subtask_deleted": "удалил шаг"
        case "subtask_submitted_review": "сдал шаг на проверку"
        case "subtask_returned": "вернул шаг на доработку"
        case "description_changed": "изменил описание"
        case "labels_changed": "изменил метки"
        case "created": "создал задачу"
        case "subtasks_added": "добавил шаги"
        default: event.kind
        }
    }
}

extension AgentOwnerActionKind: Identifiable {
    var id: Self { self }
}
