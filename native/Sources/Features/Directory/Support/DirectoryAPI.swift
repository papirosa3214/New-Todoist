import Foundation

// Довесок к `APIClient` для экранов раздела «Справочники» (Directory) — СВОЙ
// файл, а не правка `Core/Networking/APIClient+*.swift` (те чужие, правит
// только каркасный исполнитель). Тот же приём, что `TodayViewModel` уже
// применил для своего `APIClient()` — второй экземпляр безопасен (клиент
// `Sendable`, без состояния, токен читает из Keychain на каждый запрос).
//
// Три вещи здесь — не «добавление функциональности», а ИСПРАВЛЕНИЕ реальных
// расхождений между Core/spec/API.md и живым сервером (проверено чтением
// `server/src/routes/*.ts` 31.08.2026, только чтение):
//
// 1. Поиск. `spec/API.md` §5.6 и `Core/Networking/APIClient+Search.swift`
//    описывают `/search` как «список задач». Живой `server/src/routes/search.ts`
//    возвращает `{ tasks, projects, labels }` — ТРИ группы, и живой веб
//    (`src/screens/SearchScreen.tsx`) их так и показывает. Спека и Core
//    здесь просто устарели/неполны — в отчёте оркестратору.
//
// 2. Уведомления. Core `markNotificationRead` шлёт `PATCH /notifications/:id`
//    с телом `{read:true}` — живой сервер (`server/src/routes/notifications.ts`)
//    ждёт `PATCH /notifications/:id/read` БЕЗ тела. Так же нет в Core метода
//    «прочитать все» — сервер его отдаёт (`POST /notifications/read-all`),
//    веб `NotificationsScreen.tsx` его вызывает. Core здесь просто ошибается
//    путём — в отчёте оркестратору, звонок с реальными данными делать
//    осторожно (граница задачи: живой сервер — только чтение).
//
// 3. `GET /notes` (список заметок с title/preview) и `GET /projects/:id/docs`
//    (сводка документации проекта) — есть на сервере и в spec/API.md §5.9,
//    но не обёрнуты в Core вовсе (`ApiNote` не несёт `title`/`preview`).
public extension APIClient {

    // MARK: - Поиск (3 группы) — spec/SCREENS-2.md §11, живой search.ts

    struct DirectorySearchResult: Decodable, Sendable {
        public let tasks: [ApiTask]
        public let projects: [ApiProject]
        public let labels: [ApiLabel]
    }

    func directorySearch(_ query: String) async throws -> DirectorySearchResult {
        try await request(.get, "/search", query: [URLQueryItem(name: "q", value: query)])
    }

    // MARK: - Уведомления — пути, которые реально принимает сервер

    /// `PATCH /notifications/:id/read`, без тела — сервер молча игнорирует
    /// присланное тело (маршрут его не читает), поэтому пустой JSON тут не нужен.
    func directoryMarkNotificationRead(id: String) async throws {
        let _: APIOkResponse = try await request(.patch, "/notifications/\(id)/read")
    }

    /// `POST /notifications/read-all` — единственный массовый эндпоинт уведомлений.
    func directoryMarkAllNotificationsRead() async throws {
        let _: APIOkResponse = try await request(.post, "/notifications/read-all")
    }

    // MARK: - Заметки: список с превью (для секции «Документация» проекта)

    struct DirectoryNoteSummary: Decodable, Identifiable, Sendable, Hashable {
        public let id: String
        public let title: String
        public let folderId: Int?
        public let preview: String?
        public let createdAt: String?
        public let updatedAt: String?

        enum CodingKeys: String, CodingKey {
            case id, title
            case folderId = "folder_id"
            case preview
            case createdAt = "created_at"
            case updatedAt = "updated_at"
        }
    }

    private struct DirectoryNotesResponse: Decodable { let notes: [DirectoryNoteSummary] }

    func directoryNotes() async throws -> [DirectoryNoteSummary] {
        let response: DirectoryNotesResponse = try await request(.get, "/notes")
        return response.notes
    }

    // MARK: - Документация проекта одним запросом — spec/API.md §5.9,
    // `server/src/routes/notes.ts` (`GET /projects/:id/docs`). Русские ключи
    // «папка»/«подсказка»/«как читать» — буквально из ответа сервера.

    struct DirectoryProjectDocs: Decodable, Sendable {
        public struct ProjectRef: Decodable, Sendable { public let id: String; public let name: String }
        public struct FolderRef: Decodable, Sendable { public let id: Int; public let name: String }
        public struct NoteRef: Decodable, Sendable, Identifiable {
            public let id: String
            public let title: String
            public let preview: String?
            public let updatedAt: String?
            enum CodingKeys: String, CodingKey {
                case id, title, preview
                case updatedAt = "updated_at"
            }
        }

        public let project: ProjectRef
        public let folder: FolderRef?
        public let notes: [NoteRef]
        public let подсказка: String?

        enum CodingKeys: String, CodingKey {
            case project, folder, notes, подсказка
        }
    }

    func directoryProjectDocs(projectId: String) async throws -> DirectoryProjectDocs {
        try await request(.get, "/projects/\(projectId)/docs")
    }
}
