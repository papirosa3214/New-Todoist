import Foundation

// ═══════════ Обходные API-довески (Core их не даёт) ═══════════
//
// `Core/Networking/APIClient+Notes.swift` уже покрывает `GET /notes/:id`,
// `POST /notes`, `PATCH /notes/:id` и весь `journal_folders` CRUD — это
// правится только каркасным исполнителем (ARCHITECTURE.md), поэтому
// недостающие вызовы (список заметок, удаление заметки) заведены здесь как
// расширение `APIClient` В СВОЕЙ папке, не трогая чужой файл.
//
// `ApiNote` (Core) не несёт `title`/`preview` — сервер отдаёт их только в
// списке (`GET /notes`), не в полной строке заметки (там `title` тоже
// ЕСТЬ по факту в БД, но структура Core его не объявляет — не наше поле,
// не трогаем чужой Codable). Поэтому для списка — свой лёгкий тип.
struct NoteListItem: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let folderId: Int?
    let preview: String
    let createdAt: String?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, preview
        case folderId = "folder_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

private struct NoteListResponse: Decodable {
    let notes: [NoteListItem]
}

extension APIClient {
    /// `GET /notes` — spec/API.md §5.9: список БЕЗ контента, только превью.
    func notesList() async throws -> [NoteListItem] {
        let response: NoteListResponse = try await request(.get, "/notes")
        return response.notes
    }

    /// `DELETE /notes/:id` — сервер отвечает 204 с пустым телом
    /// (`server/src/routes/notes.ts`), поэтому `requestVoid`, а не
    /// декодирование в `APIOkResponse` (пустое тело уронило бы декодер).
    func deleteNote(id: String) async throws {
        try await requestVoid(.delete, "/notes/\(id)")
    }
}

// MARK: - AI-помощник заметки (spec §2 «Меню AI»)

/// Ответ `/api/ai/journal-assist` и `/api/ai/extract-tasks`
/// (`server/src/routes/ai.ts`) — оба эндпоинта реально существуют и
/// зарегистрированы, в отличие от предположения «клиента для AI в Core
/// нет, не городить»: клиента действительно нет, но маршруты на сервере
/// подтверждены чтением кода, поэтому обвязка заведена здесь же.
struct JournalAssistResponse: Decodable { let result: String }

enum JournalAssistAction: String {
    case continueThought = "continue"
    case shorten
    case expand
}

extension APIClient {
    /// «Продолжить мысль» / «Сократить текст» / «Развить в шаги» — три из
    /// четырёх пунктов меню AI. Провайдер не передаём (сервер сам берёт
    /// дефолт `local`) — выбор провайдера/модели живёт в Настройках,
    /// вне этого экрана.
    func journalAssist(text: String, action: JournalAssistAction) async throws -> String {
        let body: [String: JSONValue] = ["text": .string(text), "action": .string(action.rawValue)]
        let response: JournalAssistResponse = try await request(.post, "/ai/journal-assist", body: body)
        return response.result
    }
}
