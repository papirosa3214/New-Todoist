import SwiftUI

// ═══════════ NoteEditorScreen — редактор заметки (spec/SCREENS-2.md §2) ═══════════
//
// Имя и параметр — контракт `INTEGRATION.md` буквально: `NoteEditorScreen(noteID:)`.
//
// Архитектура тела: документ соседа (`NoteDocument.swift`) — плоский массив
// `[NoteBlock]`, поэтому редактор — это СПИСОК блоков, у каждого свой
// `UITextView` (`NoteBlockTextView.swift`), а не один текстовый холст на
// весь документ. Из этого решения вытекают все упрощения ниже (названы по
// месту): выделение для меню AI не переходит границы блока, «пересечь Enter
// два блока одним нажатием» невозможно и т.п. — компромисс в пользу того,
// что формат хранения (JSON блоков-с-прогонами) остаётся честным зеркалом
// TipTap-документа веба, без придумывания промежуточного формата.
struct NoteEditorScreen: View {
    let noteID: String

    @State private var viewModel: NoteEditorViewModel
    @State private var controllerStore = NoteBlockControllerStore()
    @Environment(\.dismiss) private var dismiss

    @State private var focusedBlockID: UUID?
    @State private var focusedController: NoteBlockTextController?
    @State private var activeMarks: Set<InlineMark> = []

    @State private var isAIMenuOpen = false
    @State private var isMoreMenuOpen = false
    @State private var showMovePicker = false
    @State private var showDeleteConfirm = false
    @State private var showLinkPrompt = false
    @State private var linkPromptText = ""
    @State private var shareURL: URL?
    @State private var showShareSheet = false

    init(noteID: String) {
        self.noteID = noteID
        self._viewModel = State(initialValue: NoteEditorViewModel(noteID: noteID))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            content
        }
        .background(Color.tfBackground)
        .overlay(alignment: .bottomTrailing) {
            if focusedBlockID != nil && !viewModel.aiBusy { micKeyboardBar }
        }
        // Нативная сворачивающаяся шапка.
        .navigationTitle(viewModel.document.derivedTitle.isEmpty ? "Заметка" : viewModel.document.derivedTitle)
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        .onDisappear { viewModel.flushOnExit() }
        .onChange(of: viewModel.pendingFocus) { _, pending in
            guard let pending else { return }
            // Строка ещё не успела появиться в SwiftUI-дереве на этот же
            // тик (вставка/удаление блока только что попала в `document`) —
            // небольшая отсрочка вместо гонки с `onAppear` новой строки.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
                controllerStore.controller(for: pending.blockID).focus(cursorAt: pending.position)
                viewModel.pendingFocus = nil
            }
        }
        .alert("Адрес ссылки", isPresented: $showLinkPrompt) {
            TextField("https://", text: $linkPromptText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            Button("Отмена", role: .cancel) {}
            Button("Применить") { applyLinkFromPrompt() }
        }
        .alert("Удалить заметку\(deleteTitleSuffix)?", isPresented: $showDeleteConfirm) {
            Button("Отмена", role: .cancel) {}
            Button("Удалить", role: .destructive) { Task { await performDelete() } }
        } message: {
            Text("Действие нельзя отменить.")
        }
        .sheet(isPresented: $showMovePicker) {
            FolderPickerSheet(folders: viewModel.folders, title: "Переместить в папку") { folderID in
                Task { await viewModel.moveToFolder(folderID) }
            }
        }
        .sheet(isPresented: $showShareSheet) {
            if let shareURL { NoteShareSheet(items: [shareURL]) }
        }
        .tfBottomSheet(isPresented: $viewModel.showExtractedTasksSheet, title: "Задачи из текста") {
            NoteExtractedTasksSheetContent(tasks: viewModel.extractedTasks) {
                viewModel.showExtractedTasksSheet = false
            }
        }
    }

    // MARK: - Тело

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading && viewModel.document.blocks.count <= 1 && viewModel.document.isEffectivelyEmpty {
            TFLoading(.block)
            Spacer()
        } else {
            TFErrorBanner(viewModel.loadErrorMessage)
                .padding(.horizontal, TFSpacing.screenHorizontal)
            toolbar
            TFErrorBanner(viewModel.aiErrorMessage, variant: .block)
                .padding(.horizontal, TFSpacing.screenHorizontal)
                .padding(.top, TFSpacing.xs)
            TFErrorBanner(viewModel.actionErrorMessage)
                .padding(.horizontal, TFSpacing.screenHorizontal)
            editorBody
            Text(viewModel.statusLabel)
                .tfText(.caption)
                .foregroundStyle(Color.tfDim)
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: 16)
                .padding(.horizontal, TFSpacing.screenHorizontal + 4)
                .padding(.top, TFSpacing.xs)
        }
    }

    private var editorBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(viewModel.document.blocks) { block in
                    NoteBlockRow(
                        block: block,
                        orderedIndex: orderedIndex(for: block),
                        showPlaceholder: viewModel.document.isEffectivelyEmpty && block.id == viewModel.document.blocks.first?.id,
                        controller: controllerStore.controller(for: block.id),
                        onChange: { id, runs in viewModel.updateRuns(blockID: id, runs: runs) },
                        onFocus: { id, ctrl in
                            focusedBlockID = id
                            focusedController = ctrl
                            activeMarks = ctrl.activeMarks
                        },
                        onBlur: { id in
                            if focusedBlockID == id {
                                focusedBlockID = nil
                                focusedController = nil
                                activeMarks = []
                            }
                        },
                        onMarksChange: { id, marks in if focusedBlockID == id { activeMarks = marks } },
                        onSplit: { id, offset in viewModel.handleSplit(blockID: id, atUTF16Offset: offset) },
                        onBackspaceAtStart: { id in viewModel.handleBackspaceAtStart(blockID: id) },
                        onToggleChecked: { viewModel.toggleTaskChecked(blockID: block.id) }
                    )
                    .padding(.horizontal, TFSpacing.screenHorizontal)
                }
            }
            .padding(.vertical, TFSpacing.sm)
            .padding(.bottom, TFSpacing.xl * 2)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    /// Порядковый номер для нумерованного списка — считает соседей того же
    /// уровня НАЗАД от текущего блока до первого «не такого же» соседа.
    private func orderedIndex(for block: NoteBlock) -> Int? {
        guard case .orderedItem = block.kind,
              let idx = viewModel.document.blocks.firstIndex(where: { $0.id == block.id })
        else { return nil }
        var count = 1
        var i = idx - 1
        while i >= 0 {
            let b = viewModel.document.blocks[i]
            guard case .orderedItem = b.kind, b.level == block.level else { break }
            count += 1
            i -= 1
        }
        return count
    }

    // MARK: - Шапка (compact: назад слева, sparkles+dots справа, заголовок
    // по центру — `TFScreenHeader.compact` этот набор поддерживает, НО
    // подсветку активного sparkles на открытом меню он не даёт (`actions`
    // там только иконки без состояния) — своя шапка той же геометрии,
    // тот же разрыв уже назван соседом в `NotesScreen.swift`.

    private var header: some View {
        ZStack {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.tfText)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
                .buttonStyle(TFTapScaleStyle())

                Spacer()

                Button { isAIMenuOpen = true } label: {
                    Image(systemName: "sparkles")
                        .font(.system(size: 18))
                        .foregroundStyle(isAIMenuOpen ? Color.tfRed : Color.tfText)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                        .background(isAIMenuOpen ? Color.tfRed.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: TFRadius.md))
                }
                .buttonStyle(TFTapScaleStyle())
                .disabled(viewModel.aiBusy)
                .opacity(viewModel.aiBusy ? 0.3 : 1)
                .popover(isPresented: $isAIMenuOpen, arrowEdge: .top) { aiMenu }
                    .presentationCompactAdaptation(.popover)

                Button { isMoreMenuOpen = true } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 18))
                        .foregroundStyle(Color.tfText)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
                .buttonStyle(TFTapScaleStyle())
                .popover(isPresented: $isMoreMenuOpen, arrowEdge: .top) { moreMenu }
                    .presentationCompactAdaptation(.popover)
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)

            Text(headerTitle)
                .tfText(.title)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
                .allowsHitTesting(false)
        }
        .frame(height: 48)
        // Тот же общий фон шапок, см. комментарий в TaskFormScreen.
        // Штатный фон навбара — вызывающий код добавляет
        // .toolbarBackground(.ultraThinMaterial, for: .navigationBar) +
        // .toolbarBackgroundVisibility(.automatic, for: .navigationBar).
        // (FrostedGlass удалён — см. коммит 9 в native-app.)
        // Свой `.background(Color.tfCard)`: safeAreaInset, не навбар —
        // штатный toolbarBackground не доходит, а раньше был FrostedGlass
        // (Claude_Bot приёмка 02.09.2026).
        .background(.ultraThinMaterial)
    }

    /// «заголовком автоматически становится первый непустой блок… или
    /// «Новая заметка» пока не начали печатать» (spec).
    private var headerTitle: String {
        let title = viewModel.document.derivedTitle
        return title.isEmpty ? "Новая заметка" : title
    }

    private var deleteTitleSuffix: String {
        let title = viewModel.document.derivedTitle
        return title.isEmpty ? "" : " «\(title)»"
    }

    private var aiMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            menuItem(icon: "pencil.line", title: "Продолжить мысль") {
                isAIMenuOpen = false
                Task { await runAssist(.continueThought) }
            }
            menuItem(icon: "scissors", title: "Сократить текст") {
                isAIMenuOpen = false
                Task { await runAssist(.shorten) }
            }
            menuItem(icon: "list.bullet.indent", title: "Развить в шаги") {
                isAIMenuOpen = false
                Task { await runAssist(.expand) }
            }
            menuItem(icon: "checklist", title: "Собрать задачи из текста") {
                isAIMenuOpen = false
                let selection = focusedController?.selectedText()
                Task { await viewModel.runExtractTasks(selectedText: selection) }
            }
        }
        .padding(.vertical, TFSpacing.xs)
        .frame(width: 260)
    }

    private var moreMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            menuItem(icon: "folder", title: "Переместить в папку") {
                isMoreMenuOpen = false
                showMovePicker = true
            }
            menuItem(icon: "square.and.arrow.up", title: "Выгрузить в Markdown") {
                isMoreMenuOpen = false
                Task { await exportMarkdown() }
            }
            menuItem(icon: "trash", title: "Удалить заметку", destructive: true) {
                isMoreMenuOpen = false
                showDeleteConfirm = true
            }
        }
        .padding(.vertical, TFSpacing.xs)
        .frame(width: 260)
    }

    private func menuItem(icon: String, title: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: TFSpacing.md) {
                Image(systemName: icon).frame(width: 20)
                Text(title).tfText(.body)
                Spacer()
            }
            .foregroundStyle(destructive ? Color.tfCoral : Color.tfText)
            .padding(.horizontal, TFSpacing.lg)
            .padding(.vertical, TFSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }

    // MARK: - Меню AI / «Ещё» — действия

    /// Есть выделение — правим прямо в textView этого блока (замена на
    /// месте); нет — весь документ (см. `NoteEditorViewModel.runAssist`).
    private func runAssist(_ action: JournalAssistAction) async {
        let hasSelection = focusedController?.hasSelection ?? false
        let selection = hasSelection ? focusedController?.selectedText() : nil
        guard let result = await viewModel.runAssist(action, selectedText: selection),
              !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }

        if hasSelection, let id = focusedBlockID, let ctrl = focusedController {
            ctrl.insertPlainParagraph(result)
            viewModel.updateRuns(blockID: id, runs: ctrl.currentRuns())
        } else {
            viewModel.applyAssistResultToWholeDocument(result, action: action)
        }
    }

    private func exportMarkdown() async {
        if let url = await viewModel.exportToMarkdownFile() {
            shareURL = url
            showShareSheet = true
        }
    }

    private func performDelete() async {
        if await viewModel.deleteNote() { dismiss() }
    }

    // MARK: - Тулбар форматирования (spec §2.1)

    private var toolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                toolbarButton("bold", active: activeMarks.contains(.bold)) { toggleMark(.bold) }
                toolbarButton("italic", active: activeMarks.contains(.italic)) { toggleMark(.italic) }
                toolbarButton("underline", active: activeMarks.contains(.underline)) { toggleMark(.underline) }
                toolbarButton("strikethrough", active: activeMarks.contains(.strike)) { toggleMark(.strike) }
                toolbarButton("highlighter", active: activeMarks.contains(.highlight)) { toggleMark(.highlight) }
                toolbarButton("curlybraces", active: activeMarks.contains(.code)) { toggleMark(.code) }
                toolbarButton("link", active: activeMarks.contains(.link)) { handleLinkTap() }

                divider

                headingButton(1)
                headingButton(2)
                headingButton(3)

                divider

                toolbarButton("list.bullet", active: isBlockKind { if case .bulletItem = $0 { true } else { false } }) {
                    viewModel.toggleList(.bullet, blockID: focusedBlockID)
                }
                toolbarButton("list.number", active: isBlockKind { if case .orderedItem = $0 { true } else { false } }) {
                    viewModel.toggleList(.ordered, blockID: focusedBlockID)
                }
                toolbarButton("checklist", active: isBlockKind { if case .taskItem = $0 { true } else { false } }) {
                    viewModel.toggleList(.task, blockID: focusedBlockID)
                }

                divider

                toolbarButton("quote.opening", active: isBlockKind { $0 == .blockquote }) {
                    viewModel.toggleQuote(blockID: focusedBlockID)
                }
                toolbarButton("chevron.left.forwardslash.chevron.right", active: isBlockKind { if case .codeBlock = $0 { true } else { false } }) {
                    viewModel.toggleCodeBlock(blockID: focusedBlockID)
                }
                toolbarButton("minus", active: false) {
                    viewModel.insertHorizontalRule(afterBlockID: focusedBlockID)
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.vertical, TFSpacing.sm)
        }
        .background(Color.tfBackground)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.tfStroke).frame(height: TFBorder.width)
        }
        .disabled(viewModel.aiBusy || focusedBlockID == nil)
        .opacity((viewModel.aiBusy || focusedBlockID == nil) ? 0.4 : 1)
    }

    private var divider: some View {
        Rectangle().fill(Color.tfStroke).frame(width: TFBorder.width, height: 20).padding(.horizontal, TFSpacing.xs)
    }

    private func toolbarButton(_ icon: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(active ? Color.tfRed : Color.tfSub)
                .frame(width: 36, height: 36)
                .background(active ? Color.tfRed.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: TFRadius.md))
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private func headingButton(_ level: Int) -> some View {
        let active = isBlockKind { if case .heading(let l) = $0 { l == level } else { false } }
        return Button { viewModel.toggleHeading(level, blockID: focusedBlockID) } label: {
            Text("H\(level)")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(active ? Color.tfRed : Color.tfSub)
                .frame(width: 36, height: 36)
                .background(active ? Color.tfRed.opacity(0.15) : .clear, in: RoundedRectangle(cornerRadius: TFRadius.md))
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private func isBlockKind(_ predicate: (BlockKind) -> Bool) -> Bool {
        guard let idx = viewModel.document.blocks.firstIndex(where: { $0.id == focusedBlockID }) else { return false }
        return predicate(viewModel.document.blocks[idx].kind)
    }

    private func toggleMark(_ mark: InlineMark) {
        guard let id = focusedBlockID, let ctrl = focusedController else { return }
        switch mark {
        case .bold: ctrl.toggleBold()
        case .italic: ctrl.toggleItalic()
        case .underline: ctrl.toggleUnderline()
        case .strike: ctrl.toggleStrike()
        case .highlight: ctrl.toggleHighlight()
        case .code: ctrl.toggleCode()
        case .link: return // ссылка — свой обработчик (нужен URL), см. handleLinkTap
        }
        activeMarks = ctrl.activeMarks
        viewModel.updateRuns(blockID: id, runs: ctrl.currentRuns())
    }

    /// «Снимаем ссылку, если курсор уже внутри неё; иначе… спрашиваем URL»
    /// (spec §2.1, п.7 «Ссылка»).
    private func handleLinkTap() {
        guard let id = focusedBlockID, let ctrl = focusedController else { return }
        if let href = ctrl.currentLinkHref, !href.isEmpty {
            ctrl.removeLink()
            activeMarks = ctrl.activeMarks
            viewModel.updateRuns(blockID: id, runs: ctrl.currentRuns())
        } else {
            guard ctrl.hasSelection else { return } // «применяет ссылку к выделенному тексту» — без выделения нечего помечать
            linkPromptText = "https://"
            showLinkPrompt = true
        }
    }

    private func applyLinkFromPrompt() {
        guard let id = focusedBlockID, let ctrl = focusedController else { return }
        let trimmed = linkPromptText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed != "https://" else { return }
        ctrl.applyLink(href: trimmed)
        activeMarks = ctrl.activeMarks
        viewModel.updateRuns(blockID: id, runs: ctrl.currentRuns())
    }

    // MARK: - Микрофон (spec §0.7) — только видимость по фокусу поля, как
    // и в `TaskFormScreen`/`ChatComposer`: в проекте нет живого ASR-провода
    // на native (см. их комментарии), само распознавание не подключаю.

    private var micKeyboardBar: some View {
        Button {} label: {
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
}

// MARK: - Строка блока

/// Один блок документа — декорация слева (маркер/номер/чекбокс/полоса
/// цитаты) + сам текстовый движок (`NoteBlockTextView`). Разделитель
/// (`horizontalRule`) — не текстовый блок вовсе, просто линия.
private struct NoteBlockRow: View {
    let block: NoteBlock
    let orderedIndex: Int?
    let showPlaceholder: Bool
    let controller: NoteBlockTextController

    let onChange: (UUID, [RichRun]) -> Void
    let onFocus: (UUID, NoteBlockTextController) -> Void
    let onBlur: (UUID) -> Void
    let onMarksChange: (UUID, Set<InlineMark>) -> Void
    let onSplit: (UUID, Int) -> Void
    let onBackspaceAtStart: (UUID) -> Void
    let onToggleChecked: () -> Void

    var body: some View {
        if case .horizontalRule = block.kind {
            Rectangle()
                .fill(Color.tfStroke)
                .frame(height: TFBorder.width)
                .padding(.vertical, TFSpacing.md)
        } else {
            HStack(alignment: .top, spacing: TFSpacing.sm) {
                leading
                ZStack(alignment: .topLeading) {
                    if showPlaceholder {
                        Text("Пишите здесь что угодно…")
                            .tfText(.body)
                            .foregroundStyle(Color.tfDim)
                            .allowsHitTesting(false)
                    }
                    NoteBlockTextView(
                        blockID: block.id, runs: block.runs, blockKind: block.kind, controller: controller,
                        onChange: onChange, onFocus: onFocus, onBlur: onBlur, onMarksChange: onMarksChange,
                        onSplit: onSplit, onBackspaceAtStart: onBackspaceAtStart
                    )
                }
            }
            .padding(.leading, CGFloat(block.level) * 18 + quoteBarInset)
            .overlay(alignment: .leading) {
                if case .blockquote = block.kind {
                    Rectangle().fill(Color.tfStroke).frame(width: 3)
                }
            }
            .padding(.vertical, block.kind.isListItem ? 2 : 4)
            .background {
                if case .codeBlock = block.kind {
                    RoundedRectangle(cornerRadius: TFRadius.md).fill(Color.tfCard2)
                        .padding(.vertical, 1)
                }
            }
        }
    }

    @ViewBuilder
    private var leading: some View {
        switch block.kind {
        case .bulletItem:
            Circle().fill(Color.tfSub).frame(width: 5, height: 5).padding(.top, 9)
        case .orderedItem:
            Text("\(orderedIndex ?? 1).")
                .tfText(.body)
                .foregroundStyle(Color.tfSub)
                .frame(minWidth: 20, alignment: .trailing)
        case .taskItem(let checked):
            TFCheckbox(isChecked: checked, action: onToggleChecked)
        default:
            EmptyView()
        }
    }

    private var quoteBarInset: CGFloat {
        if case .blockquote = block.kind { return TFSpacing.sm }
        return 0
    }
}

/// Обёртка `UIActivityViewController` для «Выгрузить в Markdown» — своя
/// копия: у соседа в `NotesScreen.swift` тот же тип объявлен `private`,
/// наружу недоступен.
private struct NoteShareSheet: UIViewControllerRepresentable {
    let items: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
