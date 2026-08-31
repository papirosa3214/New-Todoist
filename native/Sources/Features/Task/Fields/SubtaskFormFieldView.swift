import SwiftUI

// Подзадачи формы — spec/SCREENS-1.md §3.7/§5.5. Два режима:
// - **create** — простой локальный массив строк (`SubtaskDraft`), крестик
//   удаления, без сохранения на сервер до отправки формы целиком (спека
//   явно не описывает drag-reorder для этого режима — только для правки).
// - **edit** — перетаскиваемые `SubtaskRow` (`ApiSubtask` с сервера):
//   галочка отражает `done` (переключение здесь недоступно — только на
//   карточке задачи), тап по названию — инлайн-переименование, крестик —
//   удаление. Перетаскивание — вся строка целиком, БЕЗ грип-хендла:
//   `.draggable`/`.dropDestination` по `id`, держим/ведём саму строку.
struct SubtaskDraft: Identifiable, Equatable {
    let id = UUID()
    var title: String
}

/// Режим **create** — локальный массив, без сети.
struct SubtaskDraftListView: View {
    @Binding var drafts: [SubtaskDraft]
    @State private var newTitle = ""

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            sectionHeader
            ForEach(drafts) { draft in
                draftRow(draft)
            }
            addRow
        }
    }

    private var sectionHeader: some View {
        HStack {
            Text("Подзадачи").tfText(.title).foregroundStyle(Color.tfText)
        }
    }

    private func draftRow(_ draft: SubtaskDraft) -> some View {
        HStack(spacing: TFField.iconTextGap) {
            Text(draft.title).tfText(.body).foregroundStyle(Color.tfText)
            Spacer()
            Button {
                drafts.removeAll { $0.id == draft.id }
            } label: {
                Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Color.tfDim)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
            }
            .buttonStyle(TFTapScaleStyle())
        }
        .padding(.horizontal, TFField.cardInsetH)
        .frame(minHeight: TFField.height)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private var addRow: some View {
        AddSubtaskRow(text: $newTitle) {
            let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            drafts.append(SubtaskDraft(title: trimmed))
            newTitle = ""
        }
    }
}

/// Режим **edit** — строки с сервера, перетаскивание/переименование/удаление.
struct SubtaskEditListView: View {
    let subtasks: [ApiSubtask]
    var onReorder: ([ApiSubtask]) -> Void
    var onRename: (ApiSubtask, String) -> Void
    var onDelete: (ApiSubtask) -> Void
    var onAdd: (String) -> Void

    @State private var newTitle = ""
    @State private var renamingId: String?
    @State private var renameText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Подзадачи").tfText(.title).foregroundStyle(Color.tfText)
            ForEach(subtasks) { subtask in
                row(subtask)
                    .draggable(subtask.id)
                    .dropDestination(for: String.self) { droppedIds, _ in
                        handleDrop(draggedId: droppedIds.first, ontoId: subtask.id)
                    }
            }
            AddSubtaskRow(text: $newTitle) {
                let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                onAdd(trimmed)
                newTitle = ""
            }
        }
    }

    private func handleDrop(draggedId: String?, ontoId: String) -> Bool {
        guard let draggedId, draggedId != ontoId,
              let fromIndex = subtasks.firstIndex(where: { $0.id == draggedId }),
              let toIndexRaw = subtasks.firstIndex(where: { $0.id == ontoId }) else { return false }
        var reordered = subtasks
        let item = reordered.remove(at: fromIndex)
        // После удаления элемента индексы после fromIndex сдвигаются на 1 —
        // если цель была дальше по списку, её текущая позиция в укороченном
        // массиве на 1 меньше исходной.
        let insertIndex = toIndexRaw > fromIndex ? toIndexRaw - 1 : toIndexRaw
        reordered.insert(item, at: insertIndex)
        onReorder(reordered)
        return true
    }

    private func row(_ subtask: ApiSubtask) -> some View {
        HStack(spacing: TFField.iconTextGap) {
            TFCheckbox(isChecked: subtask.done) // тап здесь не переключает — см. заголовок файла
                .allowsHitTesting(false)

            if renamingId == subtask.id {
                TextField("", text: $renameText)
                    .tfText(.body)
                    .foregroundStyle(Color.tfText)
                    .onSubmit { commitRename(subtask) }
            } else {
                Text(subtask.title)
                    .tfText(.body)
                    .foregroundStyle(subtask.done ? Color.tfSub : Color.tfText)
                    .strikethrough(subtask.done)
                    .onTapGesture {
                        renamingId = subtask.id
                        renameText = subtask.title
                    }
            }
            Spacer()
            Button {
                onDelete(subtask)
            } label: {
                Image(systemName: "xmark").font(.system(size: 14)).foregroundStyle(Color.tfDim)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
            }
            .buttonStyle(TFTapScaleStyle())
        }
        .padding(.horizontal, TFField.cardInsetH)
        .frame(minHeight: TFField.height)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private func commitRename(_ subtask: ApiSubtask) {
        let trimmed = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renamingId = nil
        guard !trimmed.isEmpty, trimmed != subtask.title else { return }
        onRename(subtask, trimmed)
    }
}

/// `AddSubtaskRow` — spec §3.7: плейсхолдер «Добавить подзадачу...», галочка
/// справа появляется только когда в поле есть текст, Enter добавляет и чистит поле.
struct AddSubtaskRow: View {
    @Binding var text: String
    var onSubmit: () -> Void

    var body: some View {
        HStack(spacing: TFField.iconTextGap) {
            TextField("", text: $text, prompt: Text("Добавить подзадачу...").foregroundStyle(Color.tfDim))
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .onSubmit(onSubmit)
            if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                Button(action: onSubmit) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.tfRed)
                        .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                }
                .buttonStyle(TFTapScaleStyle())
            }
        }
        .padding(.horizontal, TFField.cardInsetH)
        .frame(minHeight: TFField.height)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }
}
