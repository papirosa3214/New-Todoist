import Foundation

// ⚠️ Обходной путь вокруг РЕАЛЬНОГО расхождения между `Core` и живым
// сервером — проверено чтением `server/src/routes/attachments.ts` (31.08.2026):
//
// - `APIClient.uploadAttachment(kind:fileName:data:mime:)` (Core) шлёт
//   `POST /attachments?kind=...&name=...` — такого маршрута на сервере
//   **нет вообще** (в файле зарегистрированы только `POST
//   /tasks/:taskId/attachments`, `GET /attachments/:id`,
//   `DELETE /attachments/:id`). Вызов улетит 404.
// - `spec/API.md` §5.10 та же ошибка — документирует несуществующий путь.
// - Правильный путь ТРЕБУЕТ `taskId` в URL и оборачивает ответ в
//   `{ attachment: {...} }`, а не отдаёт `ApiAttachment` напрямую — ещё одно
//   расхождение с сигнатурой `uploadRaw` в Core-методе.
//
// Это не «недостающий метод», а метод Core, зовущий несуществующий route —
// использовать его в своих экранах нельзя. Обходной вариант — здесь, через
// уже публичный низкоуровневый `uploadRaw`, с ПРАВИЛЬНЫМ путём и обёрткой
// ответа. Сказано в отчёте оркестратору — `uploadAttachment`/`APIClient+
// Attachments.swift` нуждаются в правке в `Core`, я её сам не делаю
// (чужая папка).
extension APIClient {
    private struct TaskAttachmentEnvelope: Decodable { let attachment: ApiAttachment }

    /// `kind`: `"task"` — файл самой задачи (не в ленту), `"comment"` —
    /// повиснет «ничьим», пока его не подберёт `createComment(attachmentIds:)`.
    func uploadTaskAttachment(taskId: String, kind: String, fileName: String, data: Data, mime: String) async throws -> ApiAttachment {
        let response: TaskAttachmentEnvelope = try await uploadRaw(
            path: "/tasks/\(taskId)/attachments",
            query: [
                URLQueryItem(name: "kind", value: kind),
                URLQueryItem(name: "name", value: fileName),
            ],
            data: data,
            mime: mime
        )
        return response.attachment
    }
}

/// Отображение вложения в списке (§19.3 `AttachmentsField`: иконка по типу,
/// имя, размер, крестик убрать) — общее для формы и карточки задачи.
enum TaskAttachmentDisplay {
    /// SF Symbols по MIME: картинка/скрепка — как того просит спека
    /// («иконка (картинка/скрепка — по типу)»).
    static func icon(mime: String?) -> String {
        guard let mime, mime.hasPrefix("image/") else { return "paperclip" }
        return "photo"
    }

    /// «12,3 КБ» / «1,4 МБ» — коротко, byte-count формат iOS.
    static func sizeText(_ bytes: Int?) -> String? {
        guard let bytes else { return nil }
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// Клиентская проверка перед отправкой (§19.3, без похода на сервер).
    static func rejectionReason(fileName: String, mime: String, size: Int) -> String? {
        let maxSize = 15 * 1024 * 1024
        if size > maxSize { return "«\(fileName)» больше 15 МБ — столько сервер не принимает" }
        let allowed = mime.hasPrefix("image/")
            || mime == "application/pdf"
            || mime == "text/plain"
            || mime == "text/markdown"
            || mime == "application/msword"
            || mime.hasPrefix("application/vnd.openxmlformats-officedocument.")
            || mime.hasPrefix("application/vnd.oasis.opendocument.")
        if !allowed { return "«\(fileName)» — такие файлы не принимаем" }
        return nil
    }
}
