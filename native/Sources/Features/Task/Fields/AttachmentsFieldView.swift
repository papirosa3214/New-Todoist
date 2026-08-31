import SwiftUI
import UniformTypeIdentifiers

// `AttachmentsField` — spec/SCREENS-2.md §19.3. Два режима: если у формы уже
// есть id задачи (`TaskDetailScreen`, `TaskFormScreen` в правке) — файл
// грузится сразу при выборе; если задачи ещё нет (создание) — копится
// локально и заливается ПОСЛЕ успешного создания (`flushPending`, см.
// `TaskAttachmentUpload.swift` — обходной путь вокруг реального разрыва
// Core/сервера).
struct PendingAttachment: Identifiable {
    let id = UUID()
    var fileName: String
    var mime: String
    var data: Data
}

@MainActor
@Observable
final class TaskAttachmentsController {
    var uploaded: [ApiAttachment]
    var pending: [PendingAttachment] = []
    var isUploading = false
    var errorMessage: String?

    private let apiClient: APIClient
    private let taskId: String?

    init(apiClient: APIClient, taskId: String?, existing: [ApiAttachment] = []) {
        self.apiClient = apiClient
        self.taskId = taskId
        self.uploaded = existing
    }

    func add(url: URL) async {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            let fileName = url.lastPathComponent
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if let reason = TaskAttachmentDisplay.rejectionReason(fileName: fileName, mime: mime, size: data.count) {
                errorMessage = reason
                return
            }
            if let taskId {
                isUploading = true
                defer { isUploading = false }
                let attachment = try await apiClient.uploadTaskAttachment(
                    taskId: taskId, kind: "task", fileName: fileName, data: data, mime: mime
                )
                uploaded.append(attachment)
            } else {
                pending.append(PendingAttachment(fileName: fileName, mime: mime, data: data))
            }
        } catch {
            errorMessage = "Не удалось приложить файл"
        }
    }

    func removeUploaded(_ attachment: ApiAttachment) async {
        let snapshot = uploaded
        uploaded.removeAll { $0.id == attachment.id }
        do {
            try await apiClient.deleteAttachment(id: attachment.id)
        } catch {
            uploaded = snapshot
            errorMessage = "Не удалось приложить файл"
        }
    }

    func removePending(_ item: PendingAttachment) {
        pending.removeAll { $0.id == item.id }
    }

    /// Вызывается формой ПОСЛЕ того, как задача создана и id стал известен.
    func flushPending(taskId: String) async {
        for item in pending {
            if let attachment = try? await apiClient.uploadTaskAttachment(
                taskId: taskId, kind: "task", fileName: item.fileName, data: item.data, mime: item.mime
            ) {
                uploaded.append(attachment)
            }
        }
        pending.removeAll()
    }
}

struct AttachmentsFieldView: View {
    @Bindable var controller: TaskAttachmentsController
    @State private var isPickerPresented = false

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            Text("Файлы").tfText(.title).foregroundStyle(Color.tfText)

            ForEach(controller.uploaded) { attachment in
                row(icon: TaskAttachmentDisplay.icon(mime: attachment.mime), name: attachment.fileName,
                    size: TaskAttachmentDisplay.sizeText(attachment.size)) {
                    Task { await controller.removeUploaded(attachment) }
                }
            }
            ForEach(controller.pending) { item in
                row(icon: TaskAttachmentDisplay.icon(mime: item.mime), name: item.fileName,
                    size: TaskAttachmentDisplay.sizeText(item.data.count)) {
                    controller.removePending(item)
                }
            }

            TFErrorBanner(controller.errorMessage, variant: .inline)

            Button {
                isPickerPresented = true
            } label: {
                HStack(spacing: TFField.iconTextGap) {
                    Image(systemName: "paperclip")
                        .font(.system(size: TFIconSize.sm))
                        .foregroundStyle(Color.tfDim)
                    Text(controller.isUploading ? "Загружаю…" : "Прикрепить файл")
                        .tfText(.body)
                        .foregroundStyle(Color.tfText)
                    Spacer()
                }
                .padding(.horizontal, TFField.cardInsetH)
                .frame(height: TFField.height)
                .background(Color.tfCard)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }
            .buttonStyle(TFTapRowStyle())
            .disabled(controller.isUploading)
        }
        .fileImporter(isPresented: $isPickerPresented, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result {
                Task { await controller.add(url: url) }
            }
        }
    }

    private func row(icon: String, name: String, size: String?, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: TFField.iconTextGap) {
            Image(systemName: icon)
                .font(.system(size: TFIconSize.sm))
                .foregroundStyle(Color.tfDim)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).tfText(.body).foregroundStyle(Color.tfText).lineLimit(1)
                if let size {
                    Text(size).tfText(.action).foregroundStyle(Color.tfSub)
                }
            }
            Spacer()
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.tfDim)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
            }
            .buttonStyle(TFTapScaleStyle())
        }
        .padding(.horizontal, TFField.cardInsetH)
        .frame(minHeight: TFField.height)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }
}
