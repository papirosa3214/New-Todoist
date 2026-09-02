import Foundation

/// Заметки и дневник — spec/API.md §5.9. ⚠️ Не проверено исчерпывающе, принимает
/// ли `POST`/`PATCH` markdown симметрично тому, как отдаёт `GET ?format=markdown`
/// (spec §10) — здесь заложена только TipTap JSON-форма записи как основная,
/// задокументированная спекой; экрану «Заметки» (Волна 2) стоит перепроверить
/// на живом сервере перед тем, как полагаться на приём markdown при записи.
public extension APIClient {

    /// `format: "markdown"` — сервер отдаёт готовую markdown-строку вместо
    /// сырого TipTap JSON (`note.content.stringValue`).
    func note(id: String, format: String? = nil) async throws -> ApiNote {
        var query: [URLQueryItem] = []
        if let format { query.append(URLQueryItem(name: "format", value: format)) }
        return try await request(.get, "/notes/\(id)", query: query)
    }

    func createNote(folderId: Int? = nil, content: JSONValue) async throws -> ApiNote {
        var body: [String: JSONValue] = ["content": content]
        if let folderId { body["folder_id"] = .number(Double(folderId)) }
        return try await request(.post, "/notes", body: body)
    }

    func patchNote(id: String, fields: [String: JSONValue]) async throws -> ApiNote {
        try await request(.patch, "/notes/\(id)", body: fields)
    }

    func journalFolders() async throws -> [ApiJournalFolder] {
        try await request(.get, "/journal/folders")
    }

    func createJournalFolder(name: String, parentId: Int? = nil) async throws -> ApiJournalFolder {
        var body: [String: JSONValue] = ["name": .string(name)]
        if let parentId { body["parent_id"] = .number(Double(parentId)) }
        return try await request(.post, "/journal/folders", body: body)
    }

    /// Сервер проверяет цикл (нельзя сделать папку потомком самой себя) — 400.
    func patchJournalFolder(id: Int, fields: [String: JSONValue]) async throws -> ApiJournalFolder {
        try await request(.patch, "/journal/folders/\(id)", body: fields)
    }

    func deleteJournalFolder(id: Int) async throws {
        let _: APIOkResponse = try await request(.delete, "/journal/folders/\(id)")
    }
}
