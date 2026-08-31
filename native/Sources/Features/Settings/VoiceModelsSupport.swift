import Foundation

/// `GET /ai/status` — `server/src/routes/ai.ts` (спека §16 не даёт форму
/// ответа, ARCHITECTURE.md п.3). Именно этот эндпоинт, НЕ `/server-status`
/// (тот использует сосед в `ServerStatusSection.swift` для блока «Сервер» —
/// два разных экрана исторически ходят за одним и тем же по двум путям,
/// это решение веб-кода, не моё, порчу его подряд).
struct AIStatusResponse: Decodable, Sendable {
    let online: Bool
    let model: String
    let host: String?
    /// Модель из конфига могли удалить с сервера — тогда `online` не значит «работает».
    let installed: Bool?
}

extension APIClient {
    func aiStatus() async throws -> AIStatusResponse {
        try await request(.get, "/ai/status")
    }
}

/// Запись журнала диктовки — порт `DictationLogEntry` (`src/lib/dictationLog.ts`).
struct DictationLogEntry: Codable, Equatable {
    /// ISO-момент — форматируется при выводе, не при записи (как в вебе).
    let at: String
    /// whisper | apple | server — кто распознал.
    let engine: String
    /// Текст от движка без правок.
    let raw: String
    /// Текст после нормализации.
    let normalized: String
}

/// Локальный журнал диктовки — порт `src/lib/dictationLog.ts` на
/// `UserDefaults`. Диагностический инструмент владельца (не мой пайплайн
/// диктовки — этот экран только читает/показывает/чистит журнал; писать в
/// него будет тот же код, что реально распознаёт речь, когда он появится:
/// достаточно вызвать `DictationLog.addEntry(engine:raw:normalized:)`).
enum DictationLog {
    private static let enabledKey = "taskflow_native_dictationLog_enabled"
    private static let entriesKey = "taskflow_native_dictationLog_entries"
    private static let maxEntries = 200

    static func isEnabled() -> Bool { UserDefaults.standard.bool(forKey: enabledKey) }
    static func setEnabled(_ value: Bool) { UserDefaults.standard.set(value, forKey: enabledKey) }

    static func readEntries() -> [DictationLogEntry] {
        guard let data = UserDefaults.standard.data(forKey: entriesKey) else { return [] }
        return (try? JSONDecoder().decode([DictationLogEntry].self, from: data)) ?? []
    }

    /// Дописывает запись, если журнал включён. Новые — сверху, ограничение
    /// на 200 записей — как в вебе.
    static func addEntry(engine: String, raw: String, normalized: String) {
        guard isEnabled() else { return }
        var entries = readEntries()
        entries.insert(DictationLogEntry(at: ISO8601DateFormatter().string(from: Date()), engine: engine, raw: raw, normalized: normalized), at: 0)
        if entries.count > maxEntries { entries.removeLast(entries.count - maxEntries) }
        guard let data = try? JSONEncoder().encode(entries) else { return }
        UserDefaults.standard.set(data, forKey: entriesKey)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: entriesKey)
    }
}

/// Очередь выгрузки аудио диктовок — порт `src/lib/dictationArchive.ts`
/// (там IndexedDB с байтами; здесь только счётчик заявок, реальных байтов
/// пока никто не пишет — см. комментарий в `VoiceModelsScreen.swift`: в
/// нативном приложении пока нет пайплайна записи, который клал бы сюда
/// аудио, поэтому счётчик честно нулевой, а не имитированный). Ключ и
/// контракт (массив ожидающих id) оставлены для будущего автора этого
/// пайплайна — записывать сюда, читать через `pendingCount()`.
enum DictationArchiveQueue {
    private static let key = "taskflow_native_dictation_archive_pending"

    static func pendingCount() -> Int {
        guard let data = UserDefaults.standard.data(forKey: key) else { return 0 }
        let ids = (try? JSONDecoder().decode([String].self, from: data)) ?? []
        return ids.count
    }
}
