import SwiftUI

// Компактное создание задачи — задача от 31.08.2026 «переделать создание задачи»:
// владелец прислал два референса (TickTick тёмная тема, Todoist светлая),
// числа сняты пипеткой/сканированием пикселей из `IMG_8598.PNG`
// (`~/.claude/skills/pixel-copy-from-screenshot/measure.py` + точечные
// Python-сканы строки чипов, см. отчёт — числа не подобраны на глаз):
//
// - высота ряда одинакова у круглых кнопок И у чипов-капсул: 108px = 36pt
//   (совпало и для «+», и для микрофона, и для «Входящие» — не отдельные
//   константы, один токен);
// - отступ ряда чипов от края экрана: 72px = 24pt (то же число, что дано
//   в задаче для кнопки «+») — использую `TFSpacing.xl` (=24), готовый токен;
// - зазор МЕЖДУ элементами ряда: 24px = 8pt на каждом стыке — `TFSpacing.sm`;
// - внутренний паддинг чипа (край капсулы → иконка, иконка → текст): ~12pt
//   и ~8pt — `TFSpacing.md`/`TFSpacing.sm`, тоже готовые токены;
// - высота всей панели TickTick-образца (без поля «Описание», которое есть
//   у нас) — 384px = 128pt, использована как ориентир для стартовой высоты
//   детента шторки, а не как жёсткая константа (наш контент выше на высоту
//   поля описания).
//
// Цвета — ТОЛЬКО из `Color+Palette.swift` (правило проекта: hex-литералы
// заводятся исключительно там, а файл у меня read-only). Ближайшие токены
// к замеренным hex — дельты явно перечислены в отчёте:
// - фон панели замерен #202020, беру `Color.tfCard` (#242424 тёмная тема);
// - обводка кнопки «+»/чипов замерена #3F3F3F, беру `Color.tfStroke`
//   (белый 9% альфа — визуально тот же subtle-серый контур на тёмном фоне);
// - красная кнопка голоса замерена #C04D4C (по краю, полупрозрачный сэмпл),
//   беру `Color.tfRed` — единственный акцент приложения (спека
//   `Color+Palette.swift`: «как заливку под белый текст НЕ использовать» —
//   тут кружок с белой иконкой поверх, тот же случай, что и `TFTabBar`
//   create-button, который уже красится `tfRed`).
struct QuickAddTaskView: View {
    @Bindable var viewModel: TaskFormViewModel
    /// Успешно сохранили — хост (`TaskFormScreen`) закрывает панель и сам экран.
    var onSaved: () -> Void
    /// «Развернуть» — хост переключается на полную форму С ТОЙ ЖЕ вью-моделью.
    var onExpand: () -> Void

    @Environment(TaskStore.self) private var taskStore
    @Environment(ProjectStore.self) private var projectStore
    @Environment(LabelStore.self) private var labelStore
    @FocusState private var isTitleFocused: Bool
    @State private var activePicker: QuickAddPicker?
    /// Высота шторки, снятая с РЕАЛЬНОГО контента (см. `QuickAddHeightKey`
    /// ниже) — не константа: 128pt из задания снято с образца TickTick БЕЗ
    /// поля «Описание», у нас оно есть, плюс шрифт может масштабироваться
    /// (Dynamic Type) — детент должен следовать за содержимым, а не за
    /// одним измеренным числом.
    @State private var contentHeight: CGFloat = 160
    /// Тост «голос не подключён» — реакция на тап по заглушке микрофона
    /// (см. `trailingActionButton`), не пустая кнопка без отклика.
    @State private var toastMessage: TaskToastMessage?

    /// Имя с префиксом `QuickAdd` — не `Picker`, чтобы не затенять
    /// одноимённый системный `SwiftUI.Picker` в этом файле.
    private enum QuickAddPicker: Identifiable { case project, due, priority, labels, attachments
        var id: Self { self }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            titleField
            descriptionField
            chipRow
        }
        .padding(.top, TFSpacing.md)
        .padding(.bottom, TFSpacing.lg)
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .background {
            GeometryReader { geo in
                Color.clear.preference(key: QuickAddHeightKey.self, value: geo.size.height)
            }
        }
        .onPreferenceChange(QuickAddHeightKey.self) { contentHeight = $0 }
        .background(Color.tfCard)
        .clipShape(.rect(topLeadingRadius: TFRadius.sheet, topTrailingRadius: TFRadius.sheet))
        .presentationDetents([.height(contentHeight)])
        .presentationDragIndicator(.hidden)
        .presentationBackground(Color.tfCard)
        .taskToast($toastMessage)
        .task {
            // Своя вью-модель может прийти уже с id (правка через
            // «развернуть» и назад технически не бывает — taskID==nil тут
            // всегда, но `loadIfNeeded`/`loadAgents` дёшевы и идемпотентны,
            // тот же вызов, что и у полной формы — не дублирую логику).
            await viewModel.loadAgents()
            isTitleFocused = true
        }
        .sheet(item: $activePicker) { picker in
            pickerSheet(picker)
        }
    }

    // MARK: - Поле названия + сохранение

    private var titleField: some View {
        HStack(spacing: TFSpacing.sm) {
            TextField("", text: $viewModel.title, prompt: Text("Название задачи").foregroundStyle(Color.tfDim), axis: .vertical)
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .lineLimit(1...3)
                .focused($isTitleFocused)
                .submitLabel(.done)
                .onSubmit { save() }
        }
    }

    private var descriptionField: some View {
        TextField("", text: $viewModel.taskDescription, prompt: Text("Описание").foregroundStyle(Color.tfDim), axis: .vertical)
            .tfText(.body)
            .foregroundStyle(Color.tfSub)
            .lineLimit(1...2)
    }

    // MARK: - Ряд быстрых кнопок

    private var chipRow: some View {
        HStack(spacing: TFSpacing.sm) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TFSpacing.sm) {
                    projectChip
                    dueChip
                    priorityChip
                    labelsChip
                    attachmentsChip
                }
            }
            Spacer(minLength: 0)
            trailingActionButton
        }
        .frame(height: QuickAddMetrics.rowHeight)
    }

    private var projectChip: some View {
        let name = projectStore.projects.first { $0.id == viewModel.projectId }?.name ?? "Проект"
        return QuickAddChip(icon: "number", text: name, isActive: viewModel.projectId != nil) {
            activePicker = .project
        }
    }

    private var dueChip: some View {
        let text = viewModel.dueDate.map { TaskDateText.dueLabel($0) } ?? "Срок"
        return QuickAddChip(icon: "calendar", text: text, isActive: viewModel.dueDate != nil) {
            activePicker = .due
        }
    }

    private var priorityChip: some View {
        // P4 «Низкий» — дефолт вью-модели, визуально не отличать от «не задано»
        // (спека приоритета не знает состояния «пусто», см. `PriorityFieldView`).
        QuickAddChip(icon: "flag", text: viewModel.priority.label, isActive: viewModel.priority != .low) {
            activePicker = .priority
        }
    }

    private var labelsChip: some View {
        let count = viewModel.selectedLabelIds.count
        let text = count == 0 ? "Метки" : (count == 1
            ? (labelStore.labels.first { viewModel.selectedLabelIds.contains($0.id) }?.name ?? "Метки")
            : "Метки: \(count)")
        return QuickAddChip(icon: "tag", text: text, isActive: count > 0) {
            activePicker = .labels
        }
    }

    private var attachmentsChip: some View {
        let count = viewModel.attachments.uploaded.count + viewModel.attachments.pending.count
        let text = count == 0 ? "Вложение" : "Файлы: \(count)"
        return QuickAddChip(icon: "paperclip", text: text, isActive: count > 0) {
            activePicker = .attachments
        }
    }

    /// Справа — микрофон (заглушка, см. header-комментарий проекта про
    /// отсутствие живого ASR-провода), меняется на «Сохранить», как только
    /// есть что сохранять — второй заявленный в задаче способ сохранения
    /// («по кнопке») рядом с Return на клавиатуре.
    private var trailingActionButton: some View {
        Button {
            if viewModel.isSaveEnabled {
                save()
            } else {
                // Пустое название — тут не «Сохранить», а голос. Задание
                // просит «понятную заглушку», не мёртвую кнопку без реакции —
                // тост тем же компонентом, что уже есть у экранов задачи.
                toastMessage = TaskToastMessage("Голосовой ввод пока не подключён")
            }
        } label: {
            ZStack {
                Circle()
                    .fill(viewModel.isSaveEnabled ? Color.tfRed : Color.tfCard2)
                    .frame(width: QuickAddMetrics.rowHeight, height: QuickAddMetrics.rowHeight)
                Image(systemName: viewModel.isSaveEnabled ? "arrow.up" : "mic.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(viewModel.isSaveEnabled ? .white : Color.tfDim)
            }
        }
        .buttonStyle(TFTapScaleStyle())
        .disabled(viewModel.isSaving)
        .accessibilityLabel(viewModel.isSaveEnabled ? "Сохранить" : "Голосовой ввод (не подключён)")
    }

    private func save() {
        guard viewModel.isSaveEnabled else { return }
        Task {
            if await viewModel.save(taskStore: taskStore) {
                onSaved()
            }
        }
    }

    // MARK: - Пикеры чипов — вложенная шторка поверх этой, переиспользует
    // уже готовые аккордеон-поля формы (не дублирую их логику выбора).

    @ViewBuilder
    private func pickerSheet(_ picker: QuickAddPicker) -> some View {
        switch picker {
        case .project:
            pickerCard { ProjectFieldView(projects: projectStore.projects, selectedProjectId: $viewModel.projectId) }
        case .due:
            pickerCard { DueDateFieldView(dueDate: $viewModel.dueDate, startMinutes: $viewModel.startMinutes, durationMin: $viewModel.durationMin) }
        case .priority:
            pickerCard { PriorityFieldView(priority: $viewModel.priority) }
        case .labels:
            pickerCard { LabelsFieldView(allLabels: labelStore.labels, selectedIds: $viewModel.selectedLabelIds) }
        case .attachments:
            ScrollView {
                AttachmentsFieldView(controller: viewModel.attachments)
                    .padding(.horizontal, TFSpacing.screenHorizontal)
                    .padding(.vertical, TFSpacing.lg)
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
            .presentationBackground(Color.tfBackground)
        }
    }

    /// Поля проекта/срока/приоритета/меток свёрнуты в `TFFieldRow`-аккордеон —
    /// в мини-шторке открываю их сразу развёрнутыми, чтобы не тапать дважды.
    private func pickerCard(@ViewBuilder content: () -> some View) -> some View {
        ScrollView {
            TFFieldGroup { content() }
                .padding(.horizontal, TFSpacing.screenHorizontal)
                .padding(.vertical, TFSpacing.lg)
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
        .presentationBackground(Color.tfBackground)
    }
}

/// Чип быстрого ряда — своего компонента такого размера в `DesignSystem` нет
/// (готовые пилюли `TFPill`/`TFLabelPill` мельче, под бейджи строки задачи,
/// не под тап-цель с иконкой в компактной панели). Локально здесь, с
/// пометкой на будущее — при появлении второго места использования стоит
/// перенести в `DesignSystem/Components` (правка вне моей папки, не мой шаг).
private struct QuickAddChip: View {
    let icon: String
    let text: String
    let isActive: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: TFSpacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: TFIconSize.xs))
                Text(text)
                    .tfText(.body)
                    .fontWeight(.medium)
                    .lineLimit(1)
            }
            .foregroundStyle(isActive ? Color.tfRed : Color.tfSub)
            .padding(.horizontal, TFSpacing.md)
            .frame(height: QuickAddMetrics.rowHeight)
            .overlay {
                Capsule().strokeBorder(Color.tfStroke, lineWidth: TFBorder.width)
            }
        }
        .buttonStyle(TFTapScaleStyle())
    }
}

/// Числа компактной панели — измерены по `IMG_8598.PNG` (см. header-комментарий
/// файла), не подобраны на глаз. Локальный enum, не `DesignSystem` (read-only
/// для этой задачи) — кандидат на перенос туда при следующей правке.
enum QuickAddMetrics {
    /// Круглые кнопки («+», микрофон/отправка) И чипы-капсулы — ОДНА высота
    /// (108px = 36pt по обоим измерено идентично).
    static let rowHeight: CGFloat = 36
}

/// Читает фактическую высоту содержимого панели, чтобы `.presentationDetents`
/// повторял её, а не жил по угаданной константе (см. `contentHeight` выше).
private struct QuickAddHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 160
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
