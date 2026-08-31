import Foundation

/// Локальные выборы экрана Интеграций (какие календари показывать, какой
/// список Apple Напоминаний использовать) — в вебе это `localStorage`
/// (`apple_calendar_ids`/`google_calendar_ids`/`apple_reminders_list_id`),
/// здесь `UserDefaults` со своими ключами (не общими с вебом — то же решение,
/// что у `TemplateStore`/`AppleRemindersSync`, каждая платформа хранит своё).
enum IntegrationsLocalPrefs {
    private static func idArray(_ key: String) -> [String] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([String].self, from: data)) ?? []
    }

    private static func setIdArray(_ key: String, _ ids: [String]) {
        guard let data = try? JSONEncoder().encode(ids) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    // MARK: Apple-календари, отображаемые в расписании

    static func appleCalendarIds() -> [String] { idArray("taskflow_native_apple_calendar_ids") }
    static func setAppleCalendarIds(_ ids: [String]) { setIdArray("taskflow_native_apple_calendar_ids", ids) }

    // MARK: Google-календари, отображаемые в расписании

    static func googleCalendarIds() -> [String] { idArray("taskflow_native_google_calendar_ids") }
    static func setGoogleCalendarIds(_ ids: [String]) { setIdArray("taskflow_native_google_calendar_ids", ids) }

    // MARK: Выбранный список Apple Напоминаний для синхронизации

    static func reminderListId() -> String? { UserDefaults.standard.string(forKey: "taskflow_native_apple_reminders_list_id") }
    static func setReminderListId(_ id: String) { UserDefaults.standard.set(id, forKey: "taskflow_native_apple_reminders_list_id") }
}
