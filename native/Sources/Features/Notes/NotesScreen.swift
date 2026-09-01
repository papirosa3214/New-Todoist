import SwiftUI

// ═══════════ NotesScreen — «Дневник» (spec/SCREENS-2.md §1) ═══════════
//
// Экран не корневая вкладка (попадает сюда пушем из CreateMenu «Заметка» —
// `RootShellView.createMenuItems`), поэтому нужна стрелка «Назад». Спека
// §0.1 обещает, что её рисует сама `ScreenHeader`, но у `TFScreenHeader`
// леэдинг реализован ТОЛЬКО для `.compact` (см. код компонента) — у
// `.large` слота `leading` нет вовсе. Модифицировать DesignSystem нельзя
// (правило ARCHITECTURE.md), поэтому здесь — свой маленький заголовок
// той же геометрии/шрифта/фона, что и `TFScreenHeader.large`, плюс
// leading-слот. Разрыв назван в отчёте — по-хорошему `TFScreenHeader`
// стоит доращивать каркасному исполнителю.
public struct NotesScreen: View {
    @State private var viewModel = NotesViewModel()
    @Environment(\.dismiss) private var dismiss

    @State private var isKebabMenuOpen = false
    @State private var isSelectionMenuOpen = false
    @State private var showRenameSheet = false
    @State private var renameText = ""
    @State private var showMovePicker = false
    @State private var showDeleteConfirm = false
    @State private var pendingNoteID: String?
    @State private var shareURLs: [URL] = []
    @State private var showShareSheet = false

    public init() {}

    public var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    TFErrorBanner(viewModel.foldersErrorMessage)
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                    TFErrorBanner(viewModel.notesErrorMessage)
                        .padding(.horizontal, TFSpacing.screenHorizontal)
                    TFErrorBanner(viewModel.actionErrorMessage)
                        .padding(.horizontal, TFSpacing.screenHorizontal)

                    if viewModel.isCreatingFolder {
                        createFolderRow
                    }

                    if viewModel.isLoading && !viewModel.hasAnyContent {
                        TFLoading(.block)
                            .frame(maxWidth: .infinity)
                    } else if !viewModel.hasAnyContent && !viewModel.isCreatingFolder {
                        TFEmptyState(
                            icon: "book",
                            text: "Записей пока нет\nЗаметки складываются в папки — перетаскиванием или сразу при создании.",
                            actionTitle: "Создать заметку"
                        ) { Task { await createNoteAndNavigate() } }
                        .padding(.top, TFSpacing.xl)
                    } else {
                        ForEach(viewModel.rows) { row in
                            rowView(row)
                        }
                    }
                }
                .padding(.vertical, TFSpacing.sm)
            }
        }
        .background(Color.tfBackground)
        .navigationBarBackButtonHidden(true)
        // Нативная сворачивающаяся шапка.
        .navigationTitle("Заметки")
        .navigationBarTitleDisplayMode(.large)
        .task { await viewModel.load() }
        // Редактор берём из общей фабрики маршрутов: пока экран не написан,
        // она отдаёт заглушку, и список заметок от этого не ломается.
        .navigationDestination(item: $pendingNoteID) { id in
            routeDestination(.noteEditor(noteID: id))
        }
        .sheet(isPresented: $showMovePicker) {
            FolderPickerSheet(folders: viewModel.folders, title: "Переместить в папку") { folderID in
                Task { await viewModel.moveSelectedNotes(toFolderID: folderID) }
            }
        }
        .alert("Переименовать папку", isPresented: $showRenameSheet) {
            TextField("Название", text: $renameText)
            Button("Отмена", role: .cancel) {}
            Button("Сохранить") { Task { await viewModel.renameSelectedFolder(to: renameText); viewModel.exitSelecting() } }
        }
        .alert("Удалить отмеченное?", isPresented: $showDeleteConfirm) {
            Button("Отмена", role: .cancel) {}
            Button("Удалить", role: .destructive) { Task { await viewModel.deleteSelected() } }
        } message: {
            Text(viewModel.deleteConfirmDescription)
        }
        .sheet(isPresented: $showShareSheet) {
            ShareSheet(items: shareURLs)
        }
    }

    // MARK: - Заголовок (см. комментарий в начале файла)

    private var header: some View {
        VStack(spacing: 0) {
            HStack {
                if viewModel.isSelecting {
                    Button("Отмена") { viewModel.exitSelecting() }
                        .tfText(.body)
                        .foregroundStyle(Color.tfText)
                } else {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(Color.tfText)
                            .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                    }
                    .buttonStyle(TFTapScaleStyle())
                }

                Spacer()

                if viewModel.isSelecting {
                    Button {
                        isSelectionMenuOpen = true
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 18))
                            .foregroundStyle(Color.tfText)
                            .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                    }
                    .buttonStyle(TFTapScaleStyle())
                    .disabled(!viewModel.hasSelection)
                    .opacity(viewModel.hasSelection ? 1 : 0.3)
                    .popover(isPresented: $isSelectionMenuOpen, arrowEdge: .top) { selectionMenu }
                        .presentationCompactAdaptation(.popover)
                } else {
                    Button {
                        isKebabMenuOpen = true
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 18))
                            .foregroundStyle(Color.tfText)
                            .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                    }
                    .buttonStyle(TFTapScaleStyle())
                    .popover(isPresented: $isKebabMenuOpen, arrowEdge: .top) { kebabMenu }
                        .presentationCompactAdaptation(.popover)
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            // 48 и общий фон вместо 56 и `.ultraThinMaterial`: полоса была
            // светлее ленты и выше остальных шапок, а заголовок вдвое крупнее —
            // владелец 01.09.2026 увидел это как «разнобой в цветах и шрифтах».
            .frame(height: 48)
            // Свой `.background(.ultraThinMaterial)`: шапка лежит в safeAreaInset,
            // не в NavigationBar — штатный `toolbarBackground` сюда не
            // доходит, а раньше был FrostedGlass (Claude_Bot приёмка 02.09.2026).
            // Полупрозрачный blur, как в вебе (frosted glass) — НЕ сплошной
            // `.background(Color.tfCard)`, как было в коммите 12.
            .background(.ultraThinMaterial)
        }
        // Штатный фон навбара — вызывающий код добавляет
        // .toolbarBackground(.ultraThinMaterial, for: .navigationBar) +
        // .toolbarBackgroundVisibility(.automatic, for: .navigationBar).
        // (FrostedGlass удалён — см. коммит 9 в native-app.)
        .overlay {
            Text("Дневник")
                .tfText(.title)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
                .allowsHitTesting(false)
        }
    }

    private var kebabMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            popoverItem(icon: "doc.text", title: "Создать заметку") {
                isKebabMenuOpen = false
                Task { await createNoteAndNavigate() }
            }
            popoverItem(icon: "folder", title: "Создать папку") {
                isKebabMenuOpen = false
                viewModel.isCreatingFolder = true
            }
            popoverItem(icon: "checklist", title: "Выбрать элементы") {
                isKebabMenuOpen = false
                viewModel.enterSelecting()
            }
            popoverItem(icon: "square.and.arrow.up", title: "Выгрузить всё в Markdown") {
                isKebabMenuOpen = false
                Task {
                    shareURLs = await viewModel.exportAllToMarkdownFiles()
                    if !shareURLs.isEmpty { showShareSheet = true }
                }
            }
        }
        .padding(.vertical, TFSpacing.xs)
        .frame(width: 260)
    }

    private var selectionMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            popoverItem(icon: "pencil", title: "Переименовать", disabled: !viewModel.canRenameSelection) {
                isSelectionMenuOpen = false
                renameText = ""
                showRenameSheet = true
            }
            popoverItem(icon: "folder", title: "Переместить в папку", disabled: viewModel.selectedNoteIDs.isEmpty) {
                isSelectionMenuOpen = false
                showMovePicker = true
            }
            popoverItem(icon: "square.and.arrow.up", title: "Выгрузить в Markdown") {
                isSelectionMenuOpen = false
                Task {
                    var urls: [URL] = []
                    for id in viewModel.selectedNoteIDs {
                        if let note = viewModel.notes.first(where: { $0.id == id }),
                           let url = await viewModel.exportNoteToMarkdownFile(noteID: id, title: note.title) {
                            urls.append(url)
                        }
                    }
                    shareURLs = urls
                    if !shareURLs.isEmpty { showShareSheet = true }
                }
            }
            popoverItem(icon: "trash", title: "Удалить", destructive: true) {
                isSelectionMenuOpen = false
                showDeleteConfirm = true
            }
        }
        .padding(.vertical, TFSpacing.xs)
        .frame(width: 260)
    }

    private func popoverItem(icon: String, title: String, disabled: Bool = false, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: TFSpacing.md) {
                Image(systemName: icon)
                    .frame(width: 20)
                Text(title)
                    .tfText(.body)
                Spacer()
            }
            .foregroundStyle(destructive ? Color.tfCoral : Color.tfText)
            .padding(.horizontal, TFSpacing.lg)
            .padding(.vertical, TFSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.35 : 1)
    }

    // MARK: - Инлайн-форма «Создать папку»

    private var createFolderRow: some View {
        HStack(spacing: TFSpacing.sm) {
            TFTextField("Название папки", text: $viewModel.newFolderName)
            Button(viewModel.isSavingFolder ? "Создаём…" : "Создать") {
                Task { await viewModel.submitCreateFolder() }
            }
            .tfText(.body)
            .foregroundStyle(Color.tfRed)
            .disabled(viewModel.isSavingFolder || viewModel.newFolderName.trimmingCharacters(in: .whitespaces).isEmpty)
            Button("Отмена") { viewModel.isCreatingFolder = false; viewModel.newFolderName = "" }
                .tfText(.body)
                .foregroundStyle(Color.tfSub)
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .padding(.vertical, TFSpacing.sm)
    }

    // MARK: - Строка дерева

    @ViewBuilder
    private func rowView(_ row: NotesTreeRow) -> some View {
        switch row.kind {
        case .folder(let folder, let noteCount):
            folderRow(row, folder: folder, noteCount: noteCount)
        case .note(let note):
            noteRow(row, note: note)
        }
    }

    private func folderRow(_ row: NotesTreeRow, folder: ApiJournalFolder, noteCount: Int) -> some View {
        Button {
            if viewModel.isSelecting { viewModel.toggleSelected(row) }
            else { viewModel.toggleExpanded(folder.id) }
        } label: {
            HStack(spacing: TFSpacing.sm) {
                indentGuides(row)
                if viewModel.isSelecting {
                    TFCheckbox(isChecked: viewModel.isSelected(row))
                }
                Image(systemName: viewModel.expandedFolderIDs.contains(folder.id) ? "chevron.down" : "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.tfDim)
                    .frame(width: 16)
                Image(systemName: "folder")
                    .foregroundStyle(Color.tfSub)
                Text(folder.name)
                    .tfText(.body)
                    .foregroundStyle(Color.tfText)
                    .lineLimit(1)
                Spacer()
                Text("\(noteCount)")
                    .tfText(.action)
                    .foregroundStyle(Color.tfDim)
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }

    private func noteRow(_ row: NotesTreeRow, note: NoteListItem) -> some View {
        Group {
            if viewModel.isSelecting {
                Button { viewModel.toggleSelected(row) } label: { noteRowContent(row, note: note) }
                    .buttonStyle(TFTapRowStyle())
            } else {
                NavigationLink(value: AppRoute.noteEditor(noteID: note.id)) {
                    noteRowContent(row, note: note)
                }
                .buttonStyle(TFTapRowStyle())
            }
        }
    }

    private func noteRowContent(_ row: NotesTreeRow, note: NoteListItem) -> some View {
        HStack(spacing: TFSpacing.sm) {
            indentGuides(row)
            if viewModel.isSelecting {
                TFCheckbox(isChecked: viewModel.isSelected(row))
            }
            Image(systemName: "doc.text")
                .foregroundStyle(Color.tfDim)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(note.title.isEmpty ? "Без названия" : note.title)
                    .tfText(.body)
                    .foregroundStyle(Color.tfText)
                    .lineLimit(1)
                if !note.preview.isEmpty {
                    Text(note.preview)
                        .tfText(.action)
                        .foregroundStyle(Color.tfSub)
                        .lineLimit(1)
                }
            }
            Spacer()
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// Направляющие линии вложенности — 18px на уровень (spec «INDENT»).
    /// Упрощение против «уголков» файлового менеджера: рисуем сплошную
    /// вертикальную чёрточку на каждом уровне-предке, у которого после
    /// текущей строки ещё есть соседи (иначе — пусто, как и должно быть
    /// у последнего элемента ветки).
    private func indentGuides(_ row: NotesTreeRow) -> some View {
        HStack(spacing: 0) {
            ForEach(0..<row.depth, id: \.self) { level in
                Rectangle()
                    .fill(level < row.ancestorContinues.count && row.ancestorContinues[level] ? Color.tfStroke : Color.clear)
                    .frame(width: 1)
                    .frame(width: 18)
            }
        }
    }

    private func createNoteAndNavigate() async {
        if let id = await viewModel.createNote() {
            pendingNoteID = id
        }
    }
}

/// Обёртка `UIActivityViewController` — «Выгрузить в Markdown» отдаёт
/// системный лист «Поделиться» с уже готовыми файлами (сохранение в
/// Файлы/AirDrop/шаринг — вариант из спеки «серия файлов в Файлы/шеринг»).
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
