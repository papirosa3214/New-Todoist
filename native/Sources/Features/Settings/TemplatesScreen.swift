import SwiftUI

/// `/settings/templates` — spec/SCREENS-2.md §15 + веб-исходник
/// `src/screens/TemplatesScreen.tsx`/`src/lib/templates.ts` (спека не даёт
/// геометрию формы и карточек, веб-код — единственный источник для них,
/// правило ARCHITECTURE.md п.3: "вид берётся из spec, а не из головы" не
/// запрещает читать код там, где спека не описывает уровень детали).
///
/// ⚠️ Личные шаблоны — ЦЕЛИКОМ локальные (спека прямо это оговаривает,
/// `TemplateStore` ниже — порт веб-хранилища на `UserDefaults`, ключ и
/// формат JSON свои, синка с сервером и с веб-версией нет и не будет.
struct TemplatesScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(TaskStore.self) private var taskStore

    @State private var userTemplates: [TaskTemplate] = TemplateStore.userTemplates()
    @State private var isFormOpen = false
    @State private var editingTemplateID: String?

    // Поля формы — как в веб `showCreate`.
    @State private var formTitle = ""
    @State private var formDescription = ""
    @State private var formPriority: TaskPriority = .low // веб-дефолт priority=4
    @State private var formSubtasksText = ""
    @State private var formCategory = "Общее"
    @State private var formError: String?

    @State private var successMessage: String?
    @State private var applyError: String?
    @State private var isApplying = false

    var body: some View {
        VStack(spacing: 0) {
            TFScreenHeader("Шаблоны задач", variant: .compact, leading: { AnyView(backButton) })
            ScrollView {
                VStack(alignment: .leading, spacing: TFSpacing.lg) {
                    TFErrorBanner(applyError, variant: .block)
                    if let successMessage {
                        successBanner(successMessage)
                    }
                    if isFormOpen {
                        formCard
                    }
                    userTemplatesSection
                    builtinTemplatesSection
                }
                .padding(.horizontal, TFSpacing.screenHorizontal)
                .padding(.top, TFSpacing.sm)
                .padding(.bottom, TFSpacing.xl * 2)
            }
        }
        .background(Color.tfBackground)
    }

    // MARK: - Шапка (та же схема, что у Интеграций — compact + свой chevron,
    // TFScreenHeader.compact без leading тап-зону не рисует вовсе).

    private var backButton: some View {
        Button(action: { dismiss() }) {
            Image(systemName: "chevron.left")
                .font(.system(size: 18))
                .foregroundStyle(Color.tfText)
                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private func successBanner(_ text: String) -> some View {
        HStack(spacing: TFSpacing.sm) {
            Image(systemName: "checkmark")
                .font(.system(size: 16))
                .foregroundStyle(Color.tfTeal)
            Text(text).tfText(.action).foregroundStyle(Color.tfTeal)
        }
        .padding(TFSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.tfCard)
        .overlay(RoundedRectangle(cornerRadius: TFRadius.xl).strokeBorder(Color.tfTeal.opacity(0.3), lineWidth: TFBorder.width))
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    // MARK: - Форма создания/правки — веб рисует её ВСТРОЕННОЙ карточкой в
    // потоке (не шторкой): `showCreate && <form className="bg-card ...">`.

    private var formCard: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            HStack {
                Text(editingTemplateID != nil ? "Редактировать шаблон" : "Новый шаблон")
                    .tfText(.body).fontWeight(.semibold).foregroundStyle(Color.tfText)
                Spacer()
                Button(action: closeForm) {
                    Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Color.tfSub)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
                .buttonStyle(TFTapScaleStyle())
            }

            labeledField("Название шаблона") {
                TFTextField("например: 🚀 Онбординг проекта", text: $formTitle)
            }
            labeledField("Описание (опционально)") {
                placeholderEditor("Краткое описание назначения шаблона...", text: $formDescription, minHeight: 52)
            }
            labeledField("Приоритет") {
                HStack(spacing: TFSpacing.sm) {
                    ForEach(TaskPriority.allCases, id: \.rawValue) { option in
                        priorityChip(option)
                    }
                }
            }
            labeledField("Подзадачи (каждая с новой строки)") {
                placeholderEditor("Собрать требования\nОписать схему базы данных\nНаписать тесты", text: $formSubtasksText, minHeight: 84)
            }

            TFErrorBanner(formError)

            HStack(spacing: TFSpacing.md) {
                TFButton("Отмена", variant: .secondary) { closeForm() }
                TFButton("Сохранить", variant: .primary, isEnabled: !formTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    saveForm()
                }
            }
        }
        .padding(TFSpacing.lg)
        .background(Color.tfCard)
        .overlay(RoundedRectangle(cornerRadius: TFRadius.xl).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width))
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    private func labeledField<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.xs) {
            Text(label).tfText(.caption).foregroundStyle(Color.tfSub)
            content()
        }
    }

    /// `TextEditor` не даёт плейсхолдер сам — тот же приём, что у большинства
    /// SwiftUI-форм: пустой текст поверх пустого поля, скрывается при вводе.
    private func placeholderEditor(_ placeholder: String, text: Binding<String>, minHeight: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .tfText(.body)
                    .foregroundStyle(Color.tfDim)
                    .padding(.horizontal, TFSpacing.lg - 4)
                    .padding(.vertical, TFSpacing.sm + 2)
                    .allowsHitTesting(false)
            }
            TextEditor(text: text)
                .tfText(.body)
                .foregroundStyle(Color.tfText)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, TFSpacing.sm)
                .frame(minHeight: minHeight)
        }
        .background(Color.tfCard2)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private func priorityChip(_ option: TaskPriority) -> some View {
        let isSelected = formPriority == option
        return Button {
            formPriority = option
        } label: {
            HStack(spacing: TFSpacing.xs) {
                Circle().fill(option.color).frame(width: 10, height: 10)
                Text(option.label).tfText(.caption).fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TFSpacing.sm)
            .foregroundStyle(isSelected ? Color.tfText : Color.tfSub)
            .background(isSelected ? Color.tfCard2 : Color.tfCard2.opacity(0.5))
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: TFRadius.lg).strokeBorder(Color.white.opacity(0.3), lineWidth: TFBorder.width)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
        .buttonStyle(TFTapScaleStyle())
    }

    // MARK: - Секции списков

    @ViewBuilder
    private var userTemplatesSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            SettingsCapsLabel("Мои шаблоны (\(userTemplates.count))") {
                AnyView(
                    Group {
                        if !isFormOpen {
                            Button("+ Добавить") { openCreateForm() }
                                .buttonStyle(TFTapFadeStyle())
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Color.tfRed)
                        }
                    }
                )
            }

            if userTemplates.isEmpty {
                TFCard {
                    Text("У вас пока нет сохранённых шаблонов. Нажмите «+ Добавить» или сохраните любую существующую задачу как шаблон из её карточки.")
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                }
            } else {
                VStack(spacing: TFSpacing.sm) {
                    ForEach(userTemplates) { template in
                        TemplateCardView(
                            template: template,
                            isApplying: isApplying,
                            onEdit: { openEditForm(template) },
                            onDelete: { deleteTemplate(template) },
                            onApply: { Task { await apply(template) } }
                        )
                    }
                }
            }
        }
    }

    private var builtinTemplatesSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            SettingsCapsLabel("Готовые образцы (\(TemplateStore.builtinTemplates.count))")
            VStack(spacing: TFSpacing.sm) {
                ForEach(TemplateStore.builtinTemplates) { template in
                    TemplateCardView(
                        template: template,
                        isApplying: isApplying,
                        onEdit: nil,
                        onDelete: nil,
                        onApply: { Task { await apply(template) } }
                    )
                }
            }
        }
    }

    // MARK: - Действия

    private func openCreateForm() {
        editingTemplateID = nil
        formTitle = ""; formDescription = ""; formPriority = .low; formSubtasksText = ""; formCategory = "Общее"
        formError = nil
        isFormOpen = true
    }

    private func openEditForm(_ template: TaskTemplate) {
        editingTemplateID = template.id
        formTitle = template.title
        formDescription = template.description ?? ""
        formPriority = template.priority.flatMap(TaskPriority.init(rawValue:)) ?? .low
        formSubtasksText = (template.subtasks ?? []).joined(separator: "\n")
        formCategory = template.category ?? "Общее"
        formError = nil
        isFormOpen = true
    }

    private func closeForm() { isFormOpen = false }

    private func saveForm() {
        let trimmedTitle = formTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            formError = "Укажите название шаблона"
            return
        }
        let subtasks = formSubtasksText
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let description = formDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let category = formCategory.trimmingCharacters(in: .whitespaces)

        if let editingTemplateID {
            TemplateStore.update(
                id: editingTemplateID,
                title: trimmedTitle,
                description: description.isEmpty ? nil : description,
                priority: formPriority.rawValue,
                subtasks: subtasks,
                category: category.isEmpty ? "Общее" : category
            )
            showSuccess("Шаблон обновлён")
        } else {
            TemplateStore.save(
                title: trimmedTitle,
                description: description.isEmpty ? nil : description,
                priority: formPriority.rawValue,
                subtasks: subtasks,
                category: category.isEmpty ? "Общее" : category
            )
            showSuccess("Новый шаблон успешно сохранён")
        }
        isFormOpen = false
        userTemplates = TemplateStore.userTemplates()
    }

    private func deleteTemplate(_ template: TaskTemplate) {
        TemplateStore.delete(id: template.id)
        userTemplates = TemplateStore.userTemplates()
        showSuccess("Шаблон удалён")
    }

    private func showSuccess(_ text: String) {
        successMessage = text
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if successMessage == text { successMessage = nil }
        }
    }

    /// Создание задачи из шаблона — веб после успеха переходит на карточку
    /// задачи (`navigate`), но у фиче-экранов нет программного push в общий
    /// `NavigationPath` (та же граница, что у `TaskFormScreen` — он тоже
    /// после сохранения просто закрывается, не открывает карточку). Здесь
    /// поэтому — баннер успеха вместо перехода, честный гэп, отмечен в отчёте.
    private func apply(_ template: TaskTemplate) async {
        applyError = nil
        isApplying = true
        defer { isApplying = false }
        let strippedTitle = template.title.trimmingLeadingEmoji()
        let payload = APIClient.NewTaskRequest(
            title: strippedTitle,
            description: template.description,
            priority: template.priority,
            subtasks: template.subtasks?.isEmpty == false ? template.subtasks : nil
        )
        if await taskStore.create(payload) != nil {
            showSuccess("Задача создана из шаблона «\(template.title)»")
        } else {
            applyError = "Не удалось создать задачу из шаблона"
        }
    }
}

// MARK: - Карточка шаблона (личного или встроенного) — spec §15 "Карточка шаблона"/"Карточка встроенного образца".

private struct TemplateCardView: View {
    let template: TaskTemplate
    let isApplying: Bool
    let onEdit: (() -> Void)?
    let onDelete: (() -> Void)?
    let onApply: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            HStack(alignment: .top, spacing: TFSpacing.sm) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(template.title).tfText(.body).fontWeight(.semibold).foregroundStyle(Color.tfText)
                    if let description = template.description, !description.isEmpty {
                        Text(description).tfText(.action).foregroundStyle(Color.tfSub).lineLimit(2)
                    }
                }
                Spacer()
                if let onEdit, let onDelete {
                    HStack(spacing: TFSpacing.xs) {
                        Button(action: onEdit) {
                            Image(systemName: "pencil").font(.system(size: 14)).foregroundStyle(Color.tfDim)
                                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                        }.buttonStyle(TFTapScaleStyle())
                        Button(action: onDelete) {
                            Image(systemName: "trash").font(.system(size: 14)).foregroundStyle(Color.tfDim)
                                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                        }.buttonStyle(TFTapScaleStyle())
                    }
                } else if let category = template.category {
                    TFPill(category.uppercased(), color: .tfDim, backgroundOpacity: 1, solidBackground: Color.tfCard2)
                }
            }

            if let subtasks = template.subtasks, !subtasks.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Подзадач: \(subtasks.count)").tfText(.caption).fontWeight(.semibold).foregroundStyle(Color.tfSub)
                    ForEach(subtasks.prefix(3), id: \.self) { line in
                        Text("• \(line)").tfText(.caption).foregroundStyle(Color.tfDim).lineLimit(1)
                    }
                    if subtasks.count > 3 {
                        Text("и ещё \(subtasks.count - 3)…").tfText(.caption).italic().foregroundStyle(Color.tfDim)
                    }
                }
                .padding(TFSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.tfCard2.opacity(0.6))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
            }

            Button(action: onApply) {
                HStack(spacing: TFSpacing.xs) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .semibold))
                    Text("Создать задачу по шаблону").tfText(.caption).fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 36)
                .foregroundStyle(Color.tfRed)
                .background(Color.tfRed.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
            }
            .buttonStyle(TFTapRowStyle())
            .disabled(isApplying)
            .opacity(isApplying ? 0.5 : 1)
        }
        .padding(TFSpacing.md)
        .background(Color.tfCard)
        .overlay(RoundedRectangle(cornerRadius: TFRadius.xl).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width))
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }
}

private extension String {
    /// Убирает эмодзи/не-буквенный префикс в начале названия — 1:1 веб-regex
    /// `/^[^\wа-яёА-ЯЁ0-9]+\s*/` (эмодзи заголовка шаблона в задаче не нужны).
    func trimmingLeadingEmoji() -> String {
        var result = Substring(self)
        while let first = result.first, !(first.isLetter || first.isNumber) {
            result.removeFirst()
        }
        return result.trimmingCharacters(in: .whitespaces)
    }
}
