import Foundation
import Observation

// Вью-модель редактора заметки — spec/SCREENS-2.md §2. Своя `APIClient()`
// (не из окружения) — тот же паттерн, что у `NotesViewModel` по соседству.
@MainActor
@Observable
final class NoteEditorViewModel {
    private let apiClient = APIClient()
    let noteID: String

    var document = NoteDocument.empty
    var folders: [ApiJournalFolder] = []
    var isLoading = false
    var loadErrorMessage: String?
    var saveState: SaveState = .idle
    /// Куда программно поставить курсор после структурной правки (Enter/
    /// Backspace/разделитель) — читает и сбрасывает экран (см. `NoteEditorScreen`).
    var pendingFocus: PendingFocus?

    // Меню AI (sparkles) — spec §2 «Меню AI».
    var aiBusy = false
    var aiLabel = "ИИ думает…"
    var aiErrorMessage: String?
    var extractedTasks: [ExtractedNoteTask] = []
    var showExtractedTasksSheet = false

    // Меню «Ещё» / удаление / перемещение / экспорт.
    var actionErrorMessage: String?

    enum SaveState { case idle, saving, saved, error }
    struct PendingFocus: Equatable { let blockID: UUID; let position: NoteCursorPosition }

    private var saveGeneration = 0
    private var saveTask: Task<Void, Never>?

    init(noteID: String) {
        self.noteID = noteID
    }

    var statusLabel: String {
        switch saveState {
        case .idle: ""
        case .saving: "Сохранение…"
        case .saved: "Сохранено"
        case .error: "Не удалось сохранить"
        }
    }

    // MARK: - Загрузка

    func load() async {
        isLoading = true
        defer { isLoading = false }
        async let foldersTask = apiClient.journalFolders()
        do {
            let note = try await apiClient.note(id: noteID)
            document = NoteDocument.decode(fromJSONString: note.content?.stringValue)
            loadErrorMessage = nil
        } catch {
            loadErrorMessage = "Не удалось загрузить заметку"
        }
        folders = (try? await foldersTask) ?? []
    }

    // MARK: - Автосохранение (debounce 800мс, spec §2 «Автосохранение»)

    private func scheduleSave() {
        saveState = .saving
        saveGeneration += 1
        let myGeneration = saveGeneration
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 800_000_000)
            guard let self, !Task.isCancelled, myGeneration == self.saveGeneration else { return }
            await self.flush()
        }
    }

    private func flush() async {
        let fields: [String: JSONValue] = ["title": .string(document.derivedTitle), "content": .string(document.encodeToJSONString())]
        do {
            _ = try await apiClient.patchNote(id: noteID, fields: fields)
            saveState = .saved
        } catch {
            saveState = .error
        }
    }

    /// Принудительный немедленный сброс при уходе с экрана — без ожидания
    /// debounce (spec: «иначе последние нажатия клавиш теряются»). Не ждёт
    /// ответа сервера (экран к этому моменту уже закрывается), как и веб.
    func flushOnExit() {
        guard saveTask != nil else { return }
        saveTask?.cancel()
        saveTask = nil
        let fields: [String: JSONValue] = ["title": .string(document.derivedTitle), "content": .string(document.encodeToJSONString())]
        let client = apiClient
        let id = noteID
        Task.detached {
            _ = try? await client.patchNote(id: id, fields: fields)
        }
    }

    // MARK: - Операции над блоками

    private func index(of blockID: UUID?) -> Int? {
        guard let blockID else { return nil }
        return document.blocks.firstIndex { $0.id == blockID }
    }

    /// Правка текста блока — приходит и от печати (делегат UITextView), и
    /// от тулбар-переключателей марок (после программной мутации textStorage).
    func updateRuns(blockID: UUID, runs: [RichRun]) {
        guard let idx = index(of: blockID) else { return }
        document.blocks[idx].runs = runs
        scheduleSave()
    }

    func toggleHeading(_ level: Int, blockID: UUID?) {
        guard let idx = index(of: blockID) else { return }
        if case .heading(let current) = document.blocks[idx].kind, current == level {
            document.blocks[idx].kind = .paragraph
        } else {
            document.blocks[idx].kind = .heading(level: level)
        }
        scheduleSave()
    }

    enum ListToggle { case bullet, ordered, task }

    func toggleList(_ kind: ListToggle, blockID: UUID?) {
        guard let idx = index(of: blockID) else { return }
        let current = document.blocks[idx].kind
        let isSame: Bool
        switch (kind, current) {
        case (.bullet, .bulletItem), (.ordered, .orderedItem), (.task, .taskItem): isSame = true
        default: isSame = false
        }
        if isSame {
            document.blocks[idx].kind = .paragraph
            document.blocks[idx].level = 0
        } else {
            switch kind {
            case .bullet: document.blocks[idx].kind = .bulletItem
            case .ordered: document.blocks[idx].kind = .orderedItem
            case .task: document.blocks[idx].kind = .taskItem(checked: false)
            }
        }
        scheduleSave()
    }

    func toggleQuote(blockID: UUID?) {
        guard let idx = index(of: blockID) else { return }
        document.blocks[idx].kind = (document.blocks[idx].kind == .blockquote) ? .paragraph : .blockquote
        scheduleSave()
    }

    /// Переключение блока кода — текст переносится как ЕДИНЫЙ прогон без
    /// марок в обе стороны (модель `NoteBlock` соседа хранит codeBlock так
    /// же — см. комментарий в `NoteDocument.swift`), инлайн-форматирование
    /// параграфа при входе в код теряется (веб-тулбар тоже не сохраняет
    /// его при переключении — источник ограничения общий, не наше решение).
    func toggleCodeBlock(blockID: UUID?) {
        guard let idx = index(of: blockID) else { return }
        let block = document.blocks[idx]
        if case .codeBlock = block.kind {
            document.blocks[idx].kind = .paragraph
        } else {
            document.blocks[idx].kind = .codeBlock(language: nil)
        }
        document.blocks[idx].runs = [RichRun(text: block.plainText)]
        scheduleSave()
    }

    func insertHorizontalRule(afterBlockID: UUID?) {
        guard let idx = index(of: afterBlockID) else { return }
        let hr = NoteBlock(kind: .horizontalRule)
        let paragraph = NoteBlock(kind: .paragraph)
        document.blocks.insert(contentsOf: [hr, paragraph], at: idx + 1)
        pendingFocus = PendingFocus(blockID: paragraph.id, position: .start)
        scheduleSave()
    }

    func toggleTaskChecked(blockID: UUID) {
        guard let idx = index(of: blockID), case .taskItem(let checked) = document.blocks[idx].kind else { return }
        document.blocks[idx].kind = .taskItem(checked: !checked)
        scheduleSave()
    }

    /// Enter внутри блока — раскладка зависит от типа (см. комментарий у
    /// `NoteBlockTextView.Coordinator.shouldChangeTextIn`, блок кода туда не
    /// доходит вовсе, перенос там литеральный).
    func handleSplit(blockID: UUID, atUTF16Offset offset: Int) {
        guard let idx = index(of: blockID) else { return }
        let block = document.blocks[idx]
        let (before, after) = NoteRichText.splitRuns(block.runs, atUTF16Offset: offset)

        switch block.kind {
        case .bulletItem, .orderedItem, .taskItem:
            let beforeEmpty = before.allSatisfy { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            if beforeEmpty && after.isEmpty {
                // Enter на пустом пункте списка — конвенция редакторов
                // списков: выходим из списка вместо создания пустого пункта.
                document.blocks[idx].kind = .paragraph
                document.blocks[idx].level = 0
                pendingFocus = PendingFocus(blockID: block.id, position: .start)
                scheduleSave()
                return
            }
            document.blocks[idx].runs = before
            var newKind = block.kind
            if case .taskItem = newKind { newKind = .taskItem(checked: false) }
            let newBlock = NoteBlock(kind: newKind, level: block.level, runs: after)
            document.blocks.insert(newBlock, at: idx + 1)
            pendingFocus = PendingFocus(blockID: newBlock.id, position: .start)

        case .blockquote:
            document.blocks[idx].runs = before
            let newBlock = NoteBlock(kind: .blockquote, runs: after)
            document.blocks.insert(newBlock, at: idx + 1)
            pendingFocus = PendingFocus(blockID: newBlock.id, position: .start)

        default:
            // Параграф и заголовок — Enter в заголовке продолжает обычным
            // параграфом, а не повторным заголовком (упрощение против
            // точной раскладки клавиш StarterKit, названо в отчёте).
            // horizontalRule сюда не попадает — у него нет текстового поля.
            document.blocks[idx].runs = before
            let newBlock = NoteBlock(kind: .paragraph, runs: after)
            document.blocks.insert(newBlock, at: idx + 1)
            pendingFocus = PendingFocus(blockID: newBlock.id, position: .start)
        }
        scheduleSave()
    }

    /// Backspace на пустом выделении в самом начале блока.
    func handleBackspaceAtStart(blockID: UUID) {
        guard let idx = index(of: blockID) else { return }
        let block = document.blocks[idx]

        if !isPlainParagraph(block.kind) {
            // Не-параграф — сперва разжаловать в параграф (второй Backspace
            // уже сольёт его с предыдущим блоком). Стандартная конвенция
            // WYSIWYG-редакторов (Notion/Bear и т.п.).
            document.blocks[idx].kind = .paragraph
            document.blocks[idx].level = 0
            scheduleSave()
            return
        }

        guard idx > 0 else { return } // первый блок документа — сливать не с чем
        let prevIdx = idx - 1

        if case .horizontalRule = document.blocks[prevIdx].kind {
            // У разделителя нет текстового поля — Backspace в блоке сразу
            // после него удаляет саму линию, а не «сливается» с ней.
            document.blocks.remove(at: prevIdx)
            pendingFocus = PendingFocus(blockID: block.id, position: .start)
            scheduleSave()
            return
        }

        let boundary = document.blocks[prevIdx].runs.reduce(0) { $0 + ($1.text as NSString).length }
        document.blocks[prevIdx].runs += block.runs
        let prevID = document.blocks[prevIdx].id
        document.blocks.remove(at: idx)
        pendingFocus = PendingFocus(blockID: prevID, position: .offset(boundary))
        scheduleSave()
    }

    private func isPlainParagraph(_ kind: BlockKind) -> Bool {
        if case .paragraph = kind { return true }
        return false
    }

    /// Весь текст документа — используется меню AI, когда в фокусном блоке
    /// нет выделения (spec §2 «Меню AI»: «применяется ко всему документу
    /// целиком, если нет выделения»).
    var wholeDocumentText: String {
        document.blocks.map(\.plainText).joined(separator: "\n")
    }

    // MARK: - Меню ИИ (sparkles)

    /// ⚠️ Упрощение против веба: там выделение — единый диапазон ProseMirror
    /// через границы блоков; здесь блок = отдельный `UITextView`, поэтому
    /// «выделение» — это выделение ВНУТРИ фокусного блока, не через весь
    /// документ. Без выделения — берём документ целиком, как и веб.
    func runAssist(_ action: JournalAssistAction, selectedText: String?) async -> String? {
        let text = selectedText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? selectedText!
            : wholeDocumentText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        aiErrorMessage = nil
        aiLabel = switch action {
        case .continueThought: "Продолжаю мысль…"
        case .shorten: "Сокращаю текст…"
        case .expand: "Развиваю в шаги…"
        }
        aiBusy = true
        defer { aiBusy = false }
        do {
            return try await apiClient.journalAssist(text: text, action: action)
        } catch {
            aiErrorMessage = "Не удалось выполнить действие AI"
            return nil
        }
    }

    /// Без выделения «Продолжить мысль»/«Сократить»/«Развить» применяются
    /// ко всему документу — зеркалит веб (`insertContentAt` на весь
    /// диапазон документа). С выделением — правку внутри одного блока
    /// делает сам экран через `NoteBlockTextController` (там же, где текст
    /// и был выделен), сюда такой случай не доходит.
    func applyAssistResultToWholeDocument(_ text: String, action: JournalAssistAction) {
        let newBlocks = Self.blocksFromAIText(text)
        guard !newBlocks.isEmpty else { return }
        switch action {
        case .continueThought:
            document.blocks.append(contentsOf: newBlocks)
        case .shorten, .expand:
            document.blocks = newBlocks
        }
        scheduleSave()
    }

    /// Разбирает plain-text ответ ИИ в блоки — зеркалит `resultToHtml` веба
    /// (`src/screens/NoteEditorScreen.tsx`): строки «- пункт» собираются в
    /// маркированный список, иначе каждая строка — свой параграф.
    private static func blocksFromAIText(_ text: String) -> [NoteBlock] {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return [] }
        if lines.allSatisfy({ $0.hasPrefix("- ") }) {
            return lines.map { NoteBlock(kind: .bulletItem, runs: [RichRun(text: String($0.dropFirst(2)))]) }
        }
        return lines.map { NoteBlock(kind: .paragraph, runs: [RichRun(text: $0)]) }
    }

    func runExtractTasks(selectedText: String?) async {
        let text = selectedText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? selectedText!
            : wholeDocumentText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        aiErrorMessage = nil
        aiLabel = "Собираю задачи…"
        aiBusy = true
        defer { aiBusy = false }
        do {
            let tasks = try await apiClient.extractTasksFromNote(text: text)
            extractedTasks = tasks
            if tasks.isEmpty {
                aiErrorMessage = "AI не нашёл в тексте конкретных задач"
            } else {
                showExtractedTasksSheet = true
            }
        } catch {
            aiErrorMessage = "Не удалось извлечь задачи"
        }
    }

    // MARK: - Меню «Ещё»

    func deleteNote() async -> Bool {
        do {
            try await apiClient.deleteNote(id: noteID)
            return true
        } catch {
            actionErrorMessage = "Не удалось выполнить действие"
            return false
        }
    }

    func moveToFolder(_ folderID: Int?) async {
        do {
            _ = try await apiClient.patchNote(id: noteID, fields: ["folder_id": folderID.map { JSONValue.number(Double($0)) } ?? .null])
        } catch {
            actionErrorMessage = "Не удалось выполнить действие"
        }
    }

    /// Экспорт в Markdown — сервер сам конвертирует TipTap JSON → md
    /// (`GET /notes/:id?format=markdown`), клиенту не нужен свой конвертер.
    func exportToMarkdownFile() async -> URL? {
        do {
            let full = try await apiClient.note(id: noteID, format: "markdown")
            let markdown = full.content?.stringValue ?? ""
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeFileName(document.derivedTitle))
            try markdown.write(to: url, atomically: true, encoding: .utf8)
            return url
        } catch {
            actionErrorMessage = "Не удалось выгрузить"
            return nil
        }
    }

    private func safeFileName(_ title: String, fallback: String = "Заметка") -> String {
        let base = (title.isEmpty ? fallback : title).replacingOccurrences(of: "[/\\\\?%*:|\"<>]", with: "-", options: .regularExpression)
        return "\(String(base.prefix(80))).md"
    }
}
