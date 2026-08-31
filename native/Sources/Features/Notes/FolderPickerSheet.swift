import SwiftUI

// Общий пикер папки — используется и в «Переместить в папку» списка
// (режим выбора NotesScreen), и в том же пункте меню редактора заметки.
// Не отдельный DesignSystem-компонент: узко специфичен для дерева заметок
// (`journal_folders`), нигде больше не нужен.
struct FolderPickerSheet: View {
    let folders: [ApiJournalFolder]
    let title: String
    let onPick: (Int?) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button {
                    onPick(nil)
                    dismiss()
                } label: {
                    Label("Без папки", systemImage: "tray")
                        .tfText(.body)
                        .foregroundStyle(Color.tfText)
                }
                ForEach(flatFolders, id: \.folder.id) { entry in
                    Button {
                        onPick(entry.folder.id)
                        dismiss()
                    } label: {
                        HStack(spacing: TFSpacing.sm) {
                            Image(systemName: "folder")
                                .foregroundStyle(Color.tfDim)
                            Text(entry.folder.name)
                                .tfText(.body)
                                .foregroundStyle(Color.tfText)
                        }
                        .padding(.leading, CGFloat(entry.depth) * 18)
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Отмена") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var flatFolders: [(folder: ApiJournalFolder, depth: Int)] {
        var out: [(ApiJournalFolder, Int)] = []
        func walk(parentID: Int?, depth: Int) {
            for f in folders.filter({ $0.parentId == parentID }) {
                out.append((f, depth))
                walk(parentID: f.id, depth: depth + 1)
            }
        }
        walk(parentID: nil, depth: 0)
        return out
    }
}
