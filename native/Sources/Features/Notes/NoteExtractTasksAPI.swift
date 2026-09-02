import Foundation

// «Собрать задачи из текста» (spec/SCREENS-2.md §2 «Меню AI») — отдельный
// AI-эндпоинт, сосед завёл в `NotesAPI.swift` только `journalAssist` для
// трёх других пунктов меню; этот довожу здесь же, чужой файл не трогаю.
// Маршрут подтверждён чтением `server/src/routes/ai.ts` (`POST
// /api/ai/extract-tasks`, тело `{ text }`, ответ `{ tasks: [...] }`).
struct ExtractedNoteTask: Decodable {
    let title: String
    let description: String?
    let priority: Int
    let dueDate: String?

    enum CodingKeys: String, CodingKey {
        case title, description, priority
        case dueDate = "due_date"
    }
}

private struct ExtractTasksResponse: Decodable { let tasks: [ExtractedNoteTask] }

extension APIClient {
    func extractTasksFromNote(text: String) async throws -> [ExtractedNoteTask] {
        let body: [String: JSONValue] = ["text": .string(text)]
        let response: ExtractTasksResponse = try await request(.post, "/ai/extract-tasks", body: body)
        return response.tasks
    }
}
