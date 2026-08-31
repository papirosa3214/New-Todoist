import Foundation

/// Поиск — spec/API.md §5.6. Использует ОБЩИЕ правила видимости
/// (`seesEveryTask()`/`visibleScope()`), НЕ «только свои задачи», как
/// написано в устаревшем `AGENT-API.md` (spec §9 п.4).
public extension APIClient {
    func search(_ query: String) async throws -> [ApiTask] {
        try await request(.get, "/search", query: [URLQueryItem(name: "q", value: query)])
    }
}
