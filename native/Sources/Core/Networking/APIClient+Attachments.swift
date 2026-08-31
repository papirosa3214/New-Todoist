import Foundation

/// Вложения и аватарки — spec/API.md §5.10. Единый паттерн для ВСЕХ загрузок
/// в проекте: тело = сырые байты файла, `Content-Type` = MIME, имя — в query
/// `?name=<urlencoded>` (никакого multipart).
public extension APIClient {

    /// Лимит 15 МБ, белый список MIME на сервере (изображения, PDF,
    /// text/plain, text/markdown, MS Office, OpenDocument).
    func uploadAttachment(kind: String, fileName: String, data: Data, mime: String) async throws -> ApiAttachment {
        try await uploadRaw(
            path: "/attachments",
            query: [
                URLQueryItem(name: "kind", value: kind),
                URLQueryItem(name: "name", value: fileName),
            ],
            data: data,
            mime: mime
        )
    }

    /// Требует `Authorization` — НЕ годится прямо в `AsyncImage(url:)`.
    func downloadAttachment(id: String) async throws -> Data {
        try await downloadRaw(path: "/attachments/\(id)")
    }

    func deleteAttachment(id: String) async throws {
        let _: APIOkResponse = try await request(.delete, "/attachments/\(id)")
    }

    struct AvatarUploadResponse: Decodable, Sendable { public let avatarUrl: String
        enum CodingKeys: String, CodingKey { case avatarUrl = "avatar_url" }
    }

    /// `variant`: `"working"`/`"blocked"`, `nil` — основная аватарка.
    func uploadAvatar(data: Data, mime: String, variant: String? = nil) async throws -> AvatarUploadResponse {
        var query: [URLQueryItem] = []
        if let variant { query.append(URLQueryItem(name: "variant", value: variant)) }
        return try await uploadRaw(path: "/avatars", query: query, data: data, mime: mime)
    }

    func deleteAvatar(variant: String? = nil) async throws {
        var query: [URLQueryItem] = []
        if let variant { query.append(URLQueryItem(name: "variant", value: variant)) }
        let _: APIOkResponse = try await request(.delete, "/avatars", query: query)
    }
}
