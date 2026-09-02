import SwiftUI

// «Задачи метки» — spec/SCREENS-2.md §10, `/labels/:id`. Сверено построчно
// с живым `src/screens/LabelTasksScreen.tsx` 31.08.2026 — этот экран НЕ
// переиспользует общий `TaskRow` (в отличие от `ProjectTasksScreen`), у него
// СВОЙ локальный ряд: без свайпа вообще, зато с настоящей точкой-переключателем
// статуса слева (spec §10 «dot-toggle» — эта деталь единственный раз реально
// существует именно тут, файловый комментарий в `TaskRow.tsx` про
// аналогичную кнопку там устарел, см. `DirectoryTaskRow.swift`).
struct LabelTasksScreen: View {
    let labelID: String

    @Environment(LabelStore.self) private var labelStore
    @Environment(TaskStore.self) private var taskStore

    @State private var pendingTaskID: String?

    private var label: ApiLabel? {
        labelStore.labels.first { $0.id == labelID }
    }

    private var tasks: [ApiTask] {
        taskStore.tasks.filter { $0.status == .active && $0.labels.contains { $0.id == labelID } }
    }

    private var notFound: Bool {
        !labelStore.isLoading && labelStore.errorMessage == nil && label == nil
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TFErrorBanner(labelStore.errorMessage, variant: .inline)
                TFErrorBanner(taskStore.errorMessage, variant: .inline)
                if labelStore.isLoading || taskStore.isLoading { TFLoading(.block) }

                if notFound {
                    notFoundView
                } else if label != nil {
                    if tasks.isEmpty {
                        Text("Этой меткой пока не помечена ни одна задача")
                            .tfText(.action)
                            .foregroundStyle(Color.tfDim)
                            .padding(.horizontal, TFSpacing.lg)
                            .padding(.top, TFSpacing.sm)
                    } else {
                        ForEach(tasks) { task in
                            taskRow(task)
                            TFDivider(dimmed: true)
                        }
                    }
                }
            }
            .padding(.top, TFSpacing.sm)
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Своя шапка уже несёт заголовок и кнопку «назад» — системный навбар
        // поверх неё давал ВТОРУЮ стрелку и лишнюю полосу.
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) {
            DirectoryCompactHeader(
                title: label?.name ?? "Метка",
                accessory: label.map { l in
                    { AnyView(
                        Image(systemName: "tag")
                            .tfText(.row)
                            .foregroundStyle(Color(hex: l.color ?? "#A6A6A6"))
                    ) }
                }
            )
        }
        .task {
            if labelStore.labels.isEmpty { await labelStore.load() }
            if taskStore.tasks.isEmpty { await taskStore.load() }
        }
        .navigationDestination(item: $pendingTaskID) { id in routeDestination(.taskDetail(taskID: id)) }
    }

    // MARK: - Строка задачи: точка-переключатель + контент, БЕЗ свайпа (spec §10)

    private func taskRow(_ task: ApiTask) -> some View {
        let isDone = task.status == .completed
        let priorityColor = TaskPriority(rawValue: task.priority)?.color ?? Color(hex: "#4A9FD8")

        return HStack(alignment: .top, spacing: TFSpacing.md) {
            Button {
                Task {
                    // `apply` — пустышка, как у ВСЕХ остальных вызовов `taskStore.patch`
                    // в проекте (поля `ApiTask` — `let`, точечно не мутируются;
                    // обновление приходит из ответа сервера). Этот экран и так уже
                    // фильтрует список по `status == .active` — после патча задача
                    // просто пропадёт из `tasks` на следующей перерисовке, как и в вебе.
                    await taskStore.patch(taskId: task.id, fields: ["status": .string(isDone ? "active" : "completed")]) { _ in }
                }
            } label: {
                Circle()
                    .strokeBorder(priorityColor, lineWidth: 2)
                    .frame(width: 18, height: 18)
                    .overlay {
                        if isDone {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(priorityColor)
                        }
                    }
            }
            .buttonStyle(TFTapScaleStyle())
            .padding(.top, 2)

            Button { pendingTaskID = task.id } label: {
                HStack(alignment: .top, spacing: TFSpacing.md) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.title)
                            .tfText(.body)
                            .foregroundStyle(isDone ? Color.tfSub : Color.tfText)
                            .strikethrough(isDone)
                            .lineLimit(1)

                        if let description = task.description, !description.isEmpty {
                            // Веб буквально всегда дописывает «…» после первых 50
                            // символов, даже если описание короче — не улучшаю,
                            // воспроизвожу как есть (ARCHITECTURE.md правило 3).
                            Text("\(description.prefix(50))…")
                                .tfText(.caption)
                                .foregroundStyle(Color.tfSub)
                                .lineLimit(1)
                        }

                        HStack(spacing: TFSpacing.xs) {
                            ForEach(task.labels, id: \.id) { l in
                                TFLabelPill(l.name, color: Color(hex: l.color ?? "#A6A6A6"))
                            }
                            if let due = task.dueDate {
                                HStack(spacing: 3) {
                                    Image(systemName: "calendar").font(.system(size: 10))
                                    Text(DirectoryDate.dueShort(due))
                                }
                                .tfText(.caption)
                                .foregroundStyle(Color.tfSub)
                                .padding(.horizontal, TFSpacing.sm)
                                .padding(.vertical, 2)
                                .background(Color.tfCard)
                                .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
                            }
                            if !task.subtasks.isEmpty {
                                let done = task.subtasks.count { $0.done }
                                TFPill("\(done)/\(task.subtasks.count)", color: .tfSub, solidBackground: .tfCard)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    if let initials = task.assigneeInitials, task.assigneeId != nil {
                        TFAvatar(size: .md, initials: initials, tint: Color(hex: task.assigneeColor ?? "#A6A6A6"))
                    }
                }
            }
            .buttonStyle(TFTapRowStyle())
        }
        .padding(.vertical, TFSpacing.md)
        .padding(.horizontal, TFSpacing.lg)
    }

    private var notFoundView: some View {
        VStack(spacing: TFSpacing.md) {
            Text("Метка не найдена — возможно, она удалена.")
                .tfText(.action)
                .foregroundStyle(Color.tfSub)
            NavigationLink(value: AppRoute.labels) {
                Text("К списку меток")
                    .tfText(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(Color.tfText)
                    .padding(.horizontal, TFSpacing.lg)
                    .frame(height: 44)
                    .background(Color.tfCard)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }
            .buttonStyle(TFTapScaleStyle())
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, TFSpacing.xl)
    }
}
