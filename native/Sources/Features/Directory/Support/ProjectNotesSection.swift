import SwiftUI

// «Документация» — spec/SCREENS-2.md §8.1, дубль `src/components/ProjectNotes.tsx`
// (чужая папка `src/components/`, не Directory — своя копия, тот же приём
// дублирования, что у всего этого раздела). Источник данных — ОДИН запрос
// `directoryProjectDocs` (`DirectoryAPI.swift`, сервер уже разворачивает
// поддерево папок сам), плюс отдельно список ВСЕХ папок Дневника — он нужен
// только для пикера «Выбрать папку», которого одного запроса не даёт.
//
// Свой `APIClient()` — тот же безопасный приём, что весь остальной проект
// (второй экземпляр без состояния, см. `DirectoryAPI.swift`).
struct ProjectNotesSection: View {
    let project: ApiProject
    /// ProjectTasksScreen передаёт колбэк, который обновляет `notesFolderId`
    /// локально (свежий `ApiProject` из `patchProject`) — сама секция стор
    /// проектов не трогает, только сообщает наверх, что изменилось.
    let onProjectPatched: (ApiProject) -> Void

    @State private var docs: APIClient.DirectoryProjectDocs?
    @State private var allFolders: [ApiJournalFolder] = []
    @State private var isLoading = true
    @State private var busy = false
    @State private var pickerOpen = false
    @State private var detachConfirm = false
    @State private var pendingNoteID: String?
    @State private var errorMessage: String?

    private let apiClient = APIClient()

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            HStack {
                Text("Документация")
                    .tfText(.title)
                    .foregroundStyle(Color.tfSub)
                Spacer()
                if docs?.folder != nil {
                    TFIconButton("plus") { Task { await addNote() } }
                }
            }

            if isLoading {
                TFLoading()
            } else if let folder = docs?.folder {
                folderSection(folder)
            } else {
                emptySection
            }

            TFErrorBanner(errorMessage, variant: .block)
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .padding(.top, TFSpacing.xl)
        .task { await load() }
        .navigationDestination(item: $pendingNoteID) { id in routeDestination(.noteEditor(noteID: id)) }
        .confirmationDialog("Открепить папку?", isPresented: $detachConfirm, titleVisibility: .visible) {
            Button("Открепить", role: .destructive) { Task { await detach() } }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Сама папка и заметки внутри останутся на месте — в Дневнике. Здесь просто пропадёт эта секция.")
        }
        .confirmationDialog("Выбрать папку", isPresented: $pickerOpen, titleVisibility: .visible) {
            ForEach(allFolders) { folder in
                Button(folder.name) { Task { await attach(folder.id) } }
            }
            Button("Отмена", role: .cancel) {}
        }
    }

    // MARK: - Папка привязана

    private func folderSection(_ folder: APIClient.DirectoryProjectDocs.FolderRef) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.xs) {
            NavigationLink(value: AppRoute.notes) {
                HStack(spacing: TFSpacing.sm) {
                    Image(systemName: "folder")
                        .tfText(.title)
                        .foregroundStyle(Color.tfSub)
                    Text(folder.name)
                        .tfText(.body)
                        .foregroundStyle(Color.tfText)
                        .lineLimit(1)
                    Spacer()
                    Text("\(docs?.notes.count ?? 0)")
                        .tfText(.caption)
                        .foregroundStyle(Color.tfDim)
                    Image(systemName: "chevron.right")
                        .tfText(.action)
                        .foregroundStyle(Color.tfDim)
                }
                .frame(minHeight: 42)
            }
            .buttonStyle(TFTapRowStyle())

            if let notes = docs?.notes, notes.isEmpty {
                Text("В папке пока нет заметок")
                    .tfText(.action)
                    .foregroundStyle(Color.tfDim)
            } else {
                ForEach(docs?.notes ?? []) { note in
                    Button { pendingNoteID = note.id } label: {
                        HStack(spacing: TFSpacing.sm) {
                            Image(systemName: "doc.text")
                                .tfText(.input)
                                .foregroundStyle(Color.tfDim)
                            Text(note.title.isEmpty ? "Без названия" : note.title)
                                .tfText(.body)
                                .foregroundStyle(Color.tfText)
                                .lineLimit(1)
                            Spacer()
                        }
                        .padding(.leading, TFSpacing.lg)
                        .frame(minHeight: 42)
                    }
                    .buttonStyle(TFTapRowStyle())
                }
            }

            Button("Открепить папку") { detachConfirm = true }
                .buttonStyle(TFTapRowStyle())
                .tfText(.action)
                .foregroundStyle(Color.tfDim)
                .padding(.top, TFSpacing.xs)
        }
    }

    // MARK: - Папка не привязана

    private var emptySection: some View {
        TFCard {
            VStack(alignment: .leading, spacing: TFSpacing.md) {
                Text("Прикрепите папку заметок — вся документация по проекту будет здесь же, рядом с задачами. Папка живёт в Дневнике, так что заметки можно перетаскивать и открывать оттуда.")
                    .tfText(.action)
                    .foregroundStyle(Color.tfSub)
                HStack(spacing: TFSpacing.sm) {
                    Button {
                        Task { await createAndAttach() }
                    } label: {
                        HStack(spacing: TFSpacing.sm) {
                            Image(systemName: "folder.badge.plus").font(.system(size: 16))
                            Text(busy ? "Создаём…" : "Создать «\(project.name)»")
                        }
                        .tfText(.action)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.tfText)
                        .padding(.horizontal, TFSpacing.lg)
                        .frame(height: 40)
                        .background(Color.tfCard2)
                        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                    }
                    .buttonStyle(TFTapScaleStyle())
                    .disabled(busy)

                    if !allFolders.isEmpty {
                        Button {
                            pickerOpen = true
                        } label: {
                            HStack(spacing: TFSpacing.sm) {
                                Image(systemName: "folder").font(.system(size: 16))
                                Text("Выбрать папку")
                            }
                            .tfText(.action)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.tfText)
                            .padding(.horizontal, TFSpacing.lg)
                            .frame(height: 40)
                            .background(Color.tfCard2)
                            .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                        }
                        .buttonStyle(TFTapScaleStyle())
                    }
                }
            }
        }
    }

    // MARK: - Действия

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        async let docsResult = apiClient.directoryProjectDocs(projectId: project.id)
        async let foldersResult = apiClient.journalFolders()
        do {
            docs = try await docsResult
            allFolders = (try? await foldersResult) ?? []
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось загрузить документацию"
        }
    }

    private func createAndAttach() async {
        busy = true
        defer { busy = false }
        do {
            let folder = try await apiClient.createJournalFolder(name: project.name)
            let updated = try await apiClient.patchProject(id: project.id, fields: ["notes_folder_id": .number(Double(folder.id))])
            onProjectPatched(updated)
            await load()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось создать папку"
        }
    }

    private func attach(_ folderId: Int) async {
        do {
            let updated = try await apiClient.patchProject(id: project.id, fields: ["notes_folder_id": .number(Double(folderId))])
            onProjectPatched(updated)
            await load()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось привязать папку"
        }
    }

    private func detach() async {
        do {
            let updated = try await apiClient.patchProject(id: project.id, fields: ["notes_folder_id": JSONValue.null])
            onProjectPatched(updated)
            await load()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось открепить папку"
        }
    }

    private func addNote() async {
        guard let folderId = docs?.folder?.id else { return }
        do {
            let note = try await apiClient.createNote(folderId: folderId, content: .string(""))
            await load()
            pendingNoteID = note.id
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Не удалось создать заметку"
        }
    }
}
