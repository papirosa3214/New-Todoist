import Foundation
import Observation

// Вью-модель экрана «Дневник» — spec/SCREENS-2.md §1. Своя `APIClient()`
// (не из окружения) — тот же паттерн, что у `TaskFormViewModel`/
// `TodayViewModel` (Core их не раздаёт через `.environment`).
@MainActor
@Observable
final class NotesViewModel {
    private let apiClient = APIClient()

    var folders: [ApiJournalFolder] = []
    var notes: [NoteListItem] = []
    var expandedFolderIDs: Set<Int> = []

    var isLoading = false
    var foldersErrorMessage: String?
    var notesErrorMessage: String?
    /// Общая ошибка «прочих операций» (перемещение/переименование/удаление) — spec.
    var actionErrorMessage: String?

    // Инлайн-форма «Создать папку» — прямо в списке, без отдельного экрана.
    var isCreatingFolder = false
    var newFolderName = ""
    var isSavingFolder = false

    // Режим выбора.
    var isSelecting = false
    var selectedFolderIDs: Set<Int> = []
    var selectedNoteIDs: Set<String> = []

    var isExporting = false

    var hasAnyContent: Bool { !folders.isEmpty || !notes.isEmpty }
    var hasSelection: Bool { !selectedFolderIDs.isEmpty || !selectedNoteIDs.isEmpty }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        async let foldersTask: Void = loadFolders()
        async let notesTask: Void = loadNotes()
        _ = await (foldersTask, notesTask)
    }

    private func loadFolders() async {
        do {
            folders = try await apiClient.journalFolders()
            foldersErrorMessage = nil
        } catch {
            foldersErrorMessage = "Не удалось загрузить папки"
        }
    }

    private func loadNotes() async {
        do {
            notes = try await apiClient.notesList()
            notesErrorMessage = nil
        } catch {
            notesErrorMessage = "Не удалось загрузить заметки"
        }
    }

    // MARK: - Дерево строк

    func toggleExpanded(_ folderID: Int) {
        if expandedFolderIDs.contains(folderID) {
            expandedFolderIDs.remove(folderID)
        } else {
            expandedFolderIDs.insert(folderID)
        }
    }

    /// Плоский список строк, отражающий развёрнутое дерево — spec: «папки
    /// можно сворачивать/разворачивать тапом по шеврону», отступ 18px на
    /// уровень (`NotesScreen.INDENT`, применяется во вью, не здесь).
    var rows: [NotesTreeRow] {
        buildRows(parentID: nil, depth: 0, ancestorContinues: [])
    }

    private func buildRows(parentID: Int?, depth: Int, ancestorContinues: [Bool]) -> [NotesTreeRow] {
        var out: [NotesTreeRow] = []
        let childFolders = folders.filter { $0.parentId == parentID }
        let childNotes = notes.filter { $0.folderId == parentID }

        for (index, folder) in childFolders.enumerated() {
            let isLast = index == childFolders.count - 1 && childNotes.isEmpty
            out.append(NotesTreeRow(
                rowID: "f:\(folder.id)",
                kind: .folder(folder, noteCount: notesCount(inFolderTree: folder.id)),
                depth: depth,
                ancestorContinues: ancestorContinues,
                isLastChild: isLast
            ))
            if expandedFolderIDs.contains(folder.id) {
                out.append(contentsOf: buildRows(parentID: folder.id, depth: depth + 1, ancestorContinues: ancestorContinues + [!isLast]))
            }
        }
        for (index, note) in childNotes.enumerated() {
            let isLast = index == childNotes.count - 1
            out.append(NotesTreeRow(
                rowID: "n:\(note.id)",
                kind: .note(note),
                depth: depth,
                ancestorContinues: ancestorContinues,
                isLastChild: isLast
            ))
        }
        return out
    }

    /// Счётчик у папки (число справа на скриншоте `notes.png`) — заметки
    /// этой папки и всех вложенных подпапок, рекурсивно.
    private func notesCount(inFolderTree folderID: Int) -> Int {
        var ids: Set<Int> = [folderID]
        var grew = true
        while grew {
            grew = false
            for f in folders where f.parentId != nil && ids.contains(f.parentId!) && !ids.contains(f.id) {
                ids.insert(f.id)
                grew = true
            }
        }
        return notes.count { $0.folderId != nil && ids.contains($0.folderId!) }
    }

    // MARK: - Создание

    /// «Создать заметку» — spec/код сходятся: без формы, сразу
    /// `POST /notes {title:"", content:""}` в корень и переход в редактор
    /// (веб `handleCreateNote(null)`, `NotesScreen.tsx`). ⚠️ Спека отдельно
    /// упоминает FAB с формой создания — в живом коде FAB убран 26.08.2026
    /// («три точки вместо плюсика», см. комментарий в `NotesScreen.tsx»),
    /// создание живёт только в этом меню; следую коду.
    func createNote() async -> String? {
        do {
            let note = try await apiClient.createNote(folderId: nil, content: .string(""))
            notes.insert(NoteListItem(id: note.id, title: "", folderId: nil, preview: "", createdAt: note.createdAt, updatedAt: note.updatedAt), at: 0)
            return note.id
        } catch {
            actionErrorMessage = "Не удалось выполнить действие"
            return nil
        }
    }

    func submitCreateFolder() async {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !isSavingFolder else { return }
        isSavingFolder = true
        defer { isSavingFolder = false }
        do {
            let folder = try await apiClient.createJournalFolder(name: name, parentId: nil)
            folders.append(folder)
            newFolderName = ""
            isCreatingFolder = false
        } catch {
            actionErrorMessage = "Не удалось создать папку"
        }
    }

    // MARK: - Режим выбора

    func enterSelecting() {
        isSelecting = true
        selectedFolderIDs = []
        selectedNoteIDs = []
    }

    func exitSelecting() {
        isSelecting = false
        selectedFolderIDs = []
        selectedNoteIDs = []
    }

    func toggleSelected(_ row: NotesTreeRow) {
        switch row.kind {
        case .folder(let folder, _):
            if selectedFolderIDs.contains(folder.id) { selectedFolderIDs.remove(folder.id) }
            else { selectedFolderIDs.insert(folder.id) }
        case .note(let note):
            if selectedNoteIDs.contains(note.id) { selectedNoteIDs.remove(note.id) }
            else { selectedNoteIDs.insert(note.id) }
        }
    }

    func isSelected(_ row: NotesTreeRow) -> Bool {
        switch row.kind {
        case .folder(let folder, _): selectedFolderIDs.contains(folder.id)
        case .note(let note): selectedNoteIDs.contains(note.id)
        }
    }

    /// «Переименовать» активно, только когда выбрана РОВНО одна папка (spec).
    var canRenameSelection: Bool { selectedFolderIDs.count == 1 && selectedNoteIDs.isEmpty }

    func renameSelectedFolder(to newName: String) async {
        guard let id = selectedFolderIDs.first else { return }
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        do {
            let updated = try await apiClient.patchJournalFolder(id: id, fields: ["name": .string(name)])
            if let idx = folders.firstIndex(where: { $0.id == id }) { folders[idx] = updated }
        } catch {
            actionErrorMessage = "Не удалось выполнить действие"
        }
    }

    /// «Переместить в папку» — только заметки: `folder_id` у `user_notes`
    /// меняется через `PATCH /notes/:id`. Перемещение папок между
    /// родителями вне выбора (спека отдаёт это drag-and-drop; здесь не
    /// реализовано — см. отчёт).
    func moveSelectedNotes(toFolderID folderID: Int?) async {
        for noteID in selectedNoteIDs {
            do {
                _ = try await apiClient.patchNote(id: noteID, fields: ["folder_id": folderID.map { JSONValue.number(Double($0)) } ?? .null])
                if let idx = notes.firstIndex(where: { $0.id == noteID }) {
                    notes[idx] = NoteListItem(id: notes[idx].id, title: notes[idx].title, folderId: folderID, preview: notes[idx].preview, createdAt: notes[idx].createdAt, updatedAt: notes[idx].updatedAt)
                }
            } catch {
                actionErrorMessage = "Не удалось выполнить действие"
            }
        }
        exitSelecting()
    }

    /// Текст подтверждения удаления — «папок: N» и/или «заметок: M», только
    /// непустые части, через запятую (spec буквально).
    var deleteConfirmDescription: String {
        var parts: [String] = []
        if !selectedFolderIDs.isEmpty { parts.append("папок: \(selectedFolderIDs.count)") }
        if !selectedNoteIDs.isEmpty { parts.append("заметок: \(selectedNoteIDs.count)") }
        let list = parts.joined(separator: ", ")
        return "Будет удалено — \(list). Заметки внутри удалённых папок не пропадут: они останутся вне папок. Действие нельзя отменить."
    }

    func deleteSelected() async {
        for folderID in selectedFolderIDs {
            do { try await apiClient.deleteJournalFolder(id: folderID) } catch { /* могла уже уйти каскадом — не рушим остальное удаление */ }
        }
        for noteID in selectedNoteIDs {
            do { try await apiClient.deleteNote(id: noteID) } catch { actionErrorMessage = "Не удалось выполнить действие" }
        }
        exitSelecting()
        await load()
    }

    // MARK: - Экспорт в Markdown

    /// «Выгрузить всё в Markdown» — веб качает файлы по одному с паузой
    /// 150мс (обход блокировки серии скачиваний браузером). На native этот
    /// обход не нужен — родной `ShareLink` умеет отдать сразу МАССИВ
    /// файлов одним системным листом «Поделиться», это и используется
    /// (упрощение в правильную сторону, названо в отчёте).
    func exportAllToMarkdownFiles() async -> [URL] {
        isExporting = true
        defer { isExporting = false }
        var urls: [URL] = []
        for note in notes {
            if let url = await exportNoteToMarkdownFile(noteID: note.id, title: note.title) {
                urls.append(url)
            }
        }
        return urls
    }

    func exportNoteToMarkdownFile(noteID: String, title: String) async -> URL? {
        do {
            let full = try await apiClient.note(id: noteID, format: "markdown")
            let markdown = full.content?.stringValue ?? ""
            let name = safeFileName(title)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
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

/// Строка плоского списка — папка или заметка на своей глубине, с
/// разметкой направляющих линий (spec: «вертикальные линии с уголками на
/// месте последнего элемента ветки»).
struct NotesTreeRow: Identifiable, Equatable {
    enum Kind: Equatable {
        case folder(ApiJournalFolder, noteCount: Int)
        case note(NoteListItem)
    }

    let rowID: String
    let kind: Kind
    let depth: Int
    /// Для каждого уровня-предка — продолжается ли его вертикальная линия
    /// ниже (т.е. у предка есть ещё не показанные соседи после него).
    let ancestorContinues: [Bool]
    /// Эта строка — последняя среди своих соседей (рисуем «уголок», не «палку»).
    let isLastChild: Bool

    var id: String { rowID }
}
