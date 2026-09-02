import EventKit
import Foundation

/// Обёртка над `EventKit` — веб ходит за Apple Календарём/Напоминаниями
/// через Capacitor-плагин `EventKit` (`src/lib/appleIntegrations.ts`), но
/// это НАТИВНОЕ приложение: свой мост не нужен, `EventKit` доступен
/// напрямую, тот же фреймворк, только без прослойки.
///
/// ⚠️ Гэп для каркасного исполнителя (не мой файл — `project.yml`): запрос
/// доступа (`requestAccess` ниже) без строк `NSCalendarsFullAccessUsageDescription`/
/// `NSRemindersFullAccessUsageDescription` в Info.plist уронит приложение —
/// это системное поведение EventKit, не баг. Чтение `authorizationStatus`
/// безопасно и без них, поэтому запрос ниже сначала проверяет наличие ключа
/// и вместо краша возвращает честное «недоступно», но кнопка реально
/// заработает только после того, как эти два ключа появятся в
/// `project.yml` → `targets.TaskFlow.info.properties`.
enum AppleEventKitAccess {
    static let store = EKEventStore()

    // MARK: - Статус (безопасен без Info.plist)

    static func calendarGranted() -> Bool { granted(EKEventStore.authorizationStatus(for: .event)) }
    static func remindersGranted() -> Bool { granted(EKEventStore.authorizationStatus(for: .reminder)) }

    /// `.authorized` (легаси до iOS 17) сюда не входит намеренно —
    /// `deploymentTarget` проекта 18.0 (`project.yml`), на этой версии
    /// система возвращает только `.fullAccess`/`.writeOnly`/`.notDetermined`/
    /// `.denied`/`.restricted`, а `.authorized` только тянет предупреждение
    /// компилятора о депрекейте без практической пользы.
    private static func granted(_ status: EKAuthorizationStatus) -> Bool {
        status == .fullAccess
    }

    // MARK: - Запрос доступа

    static func requestCalendarAccess() async -> Bool {
        guard hasUsageDescription("NSCalendarsFullAccessUsageDescription") else { return false }
        return await withCheckedContinuation { continuation in
            store.requestFullAccessToEvents { granted, _ in continuation.resume(returning: granted) }
        }
    }

    static func requestRemindersAccess() async -> Bool {
        guard hasUsageDescription("NSRemindersFullAccessUsageDescription") else { return false }
        return await withCheckedContinuation { continuation in
            store.requestFullAccessToReminders { granted, _ in continuation.resume(returning: granted) }
        }
    }

    private static func hasUsageDescription(_ key: String) -> Bool {
        Bundle.main.object(forInfoDictionaryKey: key) != nil
    }

    // MARK: - Списки

    static func calendars() -> [EKCalendar] { store.calendars(for: .event) }
    static func reminderLists() -> [EKCalendar] { store.calendars(for: .reminder) }

    // MARK: - Напоминания (для двусторонней синхронизации ниже)

    static func fetchReminders(in list: EKCalendar?) async -> [EKReminder] {
        await withCheckedContinuation { continuation in
            let predicate = store.predicateForReminders(in: list.map { [$0] })
            _ = store.fetchReminders(matching: predicate) { reminders in
                continuation.resume(returning: reminders ?? [])
            }
        }
    }

    @discardableResult
    static func createReminder(title: String, notes: String?, dueDate: Date?, priority: Int, list: EKCalendar?) -> String? {
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.notes = notes
        reminder.priority = priority
        reminder.calendar = list ?? store.defaultCalendarForNewReminders()
        if let dueDate {
            reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: dueDate)
        }
        do {
            try store.save(reminder, commit: true)
            return reminder.calendarItemIdentifier
        } catch {
            return nil
        }
    }

    static func setCompleted(reminderIdentifier: String, isCompleted: Bool) {
        guard let reminder = store.calendarItem(withIdentifier: reminderIdentifier) as? EKReminder else { return }
        reminder.isCompleted = isCompleted
        try? store.save(reminder, commit: true)
    }
}

/// Двусторонняя синхронизация TaskFlow ↔ Apple Напоминания — порт
/// `AppleIntegrations.syncAllReminders` (`src/lib/appleIntegrations.ts`),
/// алгоритм 1:1: импорт новых/завершённых напоминаний из Apple, экспорт
/// незавершённых задач TaskFlow, которых ещё нет в Apple. Карта
/// «reminder id ↔ task id» — тот же `UserDefaults`-приём, что и веб
/// (localStorage), ключ свой, между вебом и нативом не общий.
enum AppleRemindersSync {
    private static let mapKey = "taskflow_native_apple_reminders_map"

    private static func map() -> [String: String] {
        guard let data = UserDefaults.standard.data(forKey: mapKey) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    private static func setMap(_ map: [String: String]) {
        guard let data = try? JSONEncoder().encode(map) else { return }
        UserDefaults.standard.set(data, forKey: mapKey)
    }

    struct Result { let imported: Int; let exported: Int; let updated: Int }

    static func syncAll(
        tasks: [ApiTask],
        list: EKCalendar?,
        taskStore: TaskStore,
        defaultProjectId: String?
    ) async -> Result {
        var map = map()
        var imported = 0, exported = 0, updated = 0

        let reminders = await fetchReminders(in: list)

        // 1. Импорт из Apple: новые напоминания → задачи TaskFlow; уже
        // связанные и завершённые в Apple — статус задачи переводим в completed.
        for reminder in reminders {
            let reminderId = reminder.calendarItemIdentifier
            let mappedTaskId = map[reminderId]
            let existingTask = mappedTaskId.flatMap { id in tasks.first { $0.id == id } }

            if existingTask == nil {
                var dueDate: String?
                var startTime: String?
                if let components = reminder.dueDateComponents, let date = Calendar.current.date(from: components) {
                    dueDate = DateFormats.calendarDateString(date)
                    if components.hour != nil || components.minute != nil {
                        let hour = components.hour ?? 0
                        let minute = components.minute ?? 0
                        if !(hour == 0 && minute == 0) {
                            startTime = String(format: "%02d:%02d", hour, minute)
                        }
                    }
                }
                let payload = APIClient.NewTaskRequest(
                    title: reminder.title ?? "Без названия",
                    description: reminder.notes,
                    dueDate: dueDate,
                    startTime: startTime,
                    projectId: defaultProjectId,
                    priority: reminder.priority == 0 ? nil : reminder.priority
                )
                if let created = await taskStore.create(payload) {
                    map[created.id] = reminderId
                    map[reminderId] = created.id
                    imported += 1
                }
            } else if let existingTask, reminder.isCompleted, existingTask.status != .completed {
                // `apply` — no-op, как и во всех остальных вызовах `patch` в
                // проекте (`ApiTask` целиком `let`-поля, точечная мутация
                // локальной копии физически невозможна — см. TodayScreen.swift
                // и др., тот же приём).
                let ok = await taskStore.patch(taskId: existingTask.id, fields: ["status": .string("completed")]) { _ in }
                if ok { updated += 1 }
            }
        }

        // 2. Экспорт из TaskFlow: незавершённые задачи, которых ещё нет в Apple.
        for task in tasks where task.status != .completed && map[task.id] == nil {
            let dueDate = task.dueDate.flatMap(DateFormats.calendarDate)
            if let reminderId = createReminder(title: task.title, notes: task.description, dueDate: dueDate, priority: task.priority, list: list) {
                map[task.id] = reminderId
                map[reminderId] = task.id
                exported += 1
            }
        }

        setMap(map)
        return Result(imported: imported, exported: exported, updated: updated)
    }

    private static func fetchReminders(in list: EKCalendar?) async -> [EKReminder] {
        await AppleEventKitAccess.fetchReminders(in: list)
    }

    private static func createReminder(title: String, notes: String?, dueDate: Date?, priority: Int, list: EKCalendar?) -> String? {
        AppleEventKitAccess.createReminder(title: title, notes: notes, dueDate: dueDate, priority: priority, list: list)
    }
}
