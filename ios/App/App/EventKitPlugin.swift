// EventKitPlugin — нативная интеграция с Apple Календарём и Apple Напоминаниями через EventKit.
//
// Позволяет:
// 1. Читать и создавать события в системном Apple Календаре.
// 2. Читать, создавать, завершать и удалять напоминания в Apple Напоминаниях.
// 3. Поддерживает iOS 17+ (full access) и более ранние версии iOS.

import Capacitor
import EventKit
import Foundation

@objc(EventKitPlugin)
public class EventKitPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "EventKitPlugin"
  public let jsName = "EventKit"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "requestCalendarAccess", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "requestRemindersAccess", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getCalendarStatus", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getRemindersStatus", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getCalendars", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getEvents", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "createEvent", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "deleteEvent", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getReminderLists", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getReminders", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "createReminder", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "completeReminder", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "deleteReminder", returnType: CAPPluginReturnPromise),
  ]

  private let eventStore = EKEventStore()

  private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()

  private let fallbackIsoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
  }()

  private func parseDate(_ str: String?) -> Date? {
    guard let str = str, !str.isEmpty else { return nil }
    if let d = isoFormatter.date(from: str) { return d }
    if let d = fallbackIsoFormatter.date(from: str) { return d }
    let simpleFormatter = DateFormatter()
    simpleFormatter.dateFormat = "yyyy-MM-dd"
    simpleFormatter.timeZone = TimeZone.current
    return simpleFormatter.date(from: str)
  }

  private func hexColor(from cgColor: CGColor?) -> String {
    guard let cgColor = cgColor, let components = cgColor.components, components.count >= 3 else {
      return "#3B82F6"
    }
    let r = Float(components[0])
    let g = Float(components[1])
    let b = Float(components[2])
    return String(format: "#%02lX%02lX%02lX", lroundf(r * 255), lroundf(g * 255), lroundf(b * 255))
  }

  // ═══════════ Права доступа (Permissions) ═══════════

  @objc func getCalendarStatus(_ call: CAPPluginCall) {
    let status = EKEventStore.authorizationStatus(for: .event)
    call.resolve([
      "status": statusToString(status),
      "granted": status == .authorized || (status.rawValue == 3 /* fullAccess */)
    ])
  }

  @objc func getRemindersStatus(_ call: CAPPluginCall) {
    let status = EKEventStore.authorizationStatus(for: .reminder)
    call.resolve([
      "status": statusToString(status),
      "granted": status == .authorized || (status.rawValue == 3 /* fullAccess */)
    ])
  }

  @objc func requestCalendarAccess(_ call: CAPPluginCall) {
    if #available(iOS 17.0, *) {
      eventStore.requestFullAccessToEvents { granted, error in
        DispatchQueue.main.async {
          if let error = error {
            call.reject(error.localizedDescription)
          } else {
            call.resolve(["granted": granted])
          }
        }
      }
    } else {
      eventStore.requestAccess(to: .event) { granted, error in
        DispatchQueue.main.async {
          if let error = error {
            call.reject(error.localizedDescription)
          } else {
            call.resolve(["granted": granted])
          }
        }
      }
    }
  }

  @objc func requestRemindersAccess(_ call: CAPPluginCall) {
    if #available(iOS 17.0, *) {
      eventStore.requestFullAccessToReminders { granted, error in
        DispatchQueue.main.async {
          if let error = error {
            call.reject(error.localizedDescription)
          } else {
            call.resolve(["granted": granted])
          }
        }
      }
    } else {
      eventStore.requestAccess(to: .reminder) { granted, error in
        DispatchQueue.main.async {
          if let error = error {
            call.reject(error.localizedDescription)
          } else {
            call.resolve(["granted": granted])
          }
        }
      }
    }
  }

  private func statusToString(_ status: EKAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    default:
      if status.rawValue == 3 { return "authorized" } // fullAccess on iOS 17
      if status.rawValue == 4 { return "writeOnly" }
      return "unknown"
    }
  }

  // ═══════════ Apple Calendar (События) ═══════════

  @objc func getCalendars(_ call: CAPPluginCall) {
    let calendars = eventStore.calendars(for: .event)
    let defaultCal = eventStore.defaultCalendarForNewEvents
    let result = calendars.map { cal in
      [
        "id": cal.calendarIdentifier,
        "title": cal.title,
        "color": hexColor(from: cal.cgColor),
        "isDefault": cal.calendarIdentifier == defaultCal?.calendarIdentifier,
        "allowsContentModifications": cal.allowsContentModifications
      ]
    }
    call.resolve(["calendars": result])
  }

  @objc func getEvents(_ call: CAPPluginCall) {
    guard let startStr = call.getString("startDate"), let startDate = parseDate(startStr),
          let endStr = call.getString("endDate"), let endDate = parseDate(endStr) else {
      call.reject("Требуются startDate и endDate в формате ISO8601")
      return
    }

    var calendarsToSearch: [EKCalendar]? = nil
    if let calIds = call.getArray("calendarIds") as? [String], !calIds.isEmpty {
      calendarsToSearch = eventStore.calendars(for: .event).filter { calIds.contains($0.calendarIdentifier) }
    }

    let predicate = eventStore.predicateForEvents(withStart: startDate, end: endDate, calendars: calendarsToSearch)
    let events = eventStore.events(matching: predicate)

    let list = events.map { ev in
      [
        "id": ev.eventIdentifier ?? "",
        "calendarId": ev.calendar?.calendarIdentifier ?? "",
        "calendarTitle": ev.calendar?.title ?? "",
        "calendarColor": self.hexColor(from: ev.calendar?.cgColor),
        "title": ev.title ?? "",
        "startDate": self.fallbackIsoFormatter.string(from: ev.startDate),
        "endDate": self.fallbackIsoFormatter.string(from: ev.endDate),
        "allDay": ev.isAllDay,
        "notes": ev.notes ?? "",
        "location": ev.location ?? "",
        "url": ev.url?.absoluteString ?? ""
      ]
    }
    call.resolve(["events": list])
  }

  @objc func createEvent(_ call: CAPPluginCall) {
    guard let title = call.getString("title"), !title.isEmpty,
          let startStr = call.getString("startDate"), let startDate = parseDate(startStr),
          let endStr = call.getString("endDate"), let endDate = parseDate(endStr) else {
      call.reject("Параметры title, startDate, endDate обязательны")
      return
    }

    let event = EKEvent(eventStore: eventStore)
    event.title = title
    event.startDate = startDate
    event.endDate = endDate
    event.isAllDay = call.getBool("allDay") ?? false
    event.notes = call.getString("notes")
    event.location = call.getString("location")

    if let calId = call.getString("calendarId") {
      event.calendar = eventStore.calendars(for: .event).first { $0.calendarIdentifier == calId }
    }
    if event.calendar == nil {
      event.calendar = eventStore.defaultCalendarForNewEvents
    }

    do {
      try eventStore.save(event, span: .thisEvent)
      call.resolve(["id": event.eventIdentifier ?? ""])
    } catch {
      call.reject("Ошибка сохранения события: \(error.localizedDescription)")
    }
  }

  @objc func deleteEvent(_ call: CAPPluginCall) {
    guard let id = call.getString("id"), let event = eventStore.event(withIdentifier: id) else {
      call.reject("Событие не найдено")
      return
    }
    do {
      try eventStore.remove(event, span: .thisEvent)
      call.resolve(["success": true])
    } catch {
      call.reject("Ошибка удаления события: \(error.localizedDescription)")
    }
  }

  // ═══════════ Apple Reminders (Напоминания) ═══════════

  @objc func getReminderLists(_ call: CAPPluginCall) {
    let calendars = eventStore.calendars(for: .reminder)
    let defaultList = eventStore.defaultCalendarForNewReminders()
    let result = calendars.map { cal in
      [
        "id": cal.calendarIdentifier,
        "title": cal.title,
        "color": hexColor(from: cal.cgColor),
        "isDefault": cal.calendarIdentifier == defaultList?.calendarIdentifier
      ]
    }
    call.resolve(["lists": result])
  }

  @objc func getReminders(_ call: CAPPluginCall) {
    var cals: [EKCalendar]? = nil
    if let listId = call.getString("listId") {
      cals = eventStore.calendars(for: .reminder).filter { $0.calendarIdentifier == listId }
    }
    let predicate = eventStore.predicateForReminders(in: cals)

    eventStore.fetchReminders(matching: predicate) { [weak self] (reminders: [EKReminder]?) in
      DispatchQueue.main.async {
        guard let self = self else { return }
        let items = (reminders ?? []).map { rem -> [String: Any] in
          var dueStr: String? = nil
          if let dueComponents = rem.dueDateComponents,
             let dueDate = Calendar.current.date(from: dueComponents) {
            dueStr = self.fallbackIsoFormatter.string(from: dueDate)
          }
          var createdStr: String? = nil
          if let cd = rem.creationDate {
            createdStr = self.fallbackIsoFormatter.string(from: cd)
          }

          return [
            "id": rem.calendarItemIdentifier,
            "listId": rem.calendar?.calendarIdentifier ?? "",
            "listTitle": rem.calendar?.title ?? "",
            "title": rem.title ?? "",
            "notes": rem.notes ?? "",
            "isCompleted": rem.isCompleted,
            "dueDate": dueStr as Any,
            "priority": rem.priority,
            "createdAt": createdStr as Any
          ]
        }
        call.resolve(["reminders": items])
      }
    }
  }

  @objc func createReminder(_ call: CAPPluginCall) {
    guard let title = call.getString("title"), !title.isEmpty else {
      call.reject("Заголовок напоминания (title) обязателен")
      return
    }

    let reminder = EKReminder(eventStore: eventStore)
    reminder.title = title
    reminder.notes = call.getString("notes")
    reminder.priority = call.getInt("priority") ?? 0

    if let dueStr = call.getString("dueDate"), let dueDate = parseDate(dueStr) {
      reminder.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: dueDate)
    }

    if let listId = call.getString("listId") {
      reminder.calendar = eventStore.calendars(for: .reminder).first { $0.calendarIdentifier == listId }
    }
    if reminder.calendar == nil {
      reminder.calendar = eventStore.defaultCalendarForNewReminders()
    }

    do {
      try eventStore.save(reminder, commit: true)
      call.resolve(["id": reminder.calendarItemIdentifier])
    } catch {
      call.reject("Ошибка сохранения напоминания: \(error.localizedDescription)")
    }
  }

  @objc func completeReminder(_ call: CAPPluginCall) {
    guard let id = call.getString("id") else {
      call.reject("Параметр id обязателен")
      return
    }
    guard let item = eventStore.calendarItem(withIdentifier: id) as? EKReminder else {
      call.reject("Напоминание с id \(id) не найдено")
      return
    }

    let isCompleted = call.getBool("isCompleted") ?? true
    item.isCompleted = isCompleted
    if isCompleted {
      item.completionDate = Date()
    } else {
      item.completionDate = nil
    }

    do {
      try eventStore.save(item, commit: true)
      call.resolve(["success": true])
    } catch {
      call.reject("Ошибка обновления статуса напоминания: \(error.localizedDescription)")
    }
  }

  @objc func deleteReminder(_ call: CAPPluginCall) {
    guard let id = call.getString("id") else {
      call.reject("Параметр id обязателен")
      return
    }
    guard let item = eventStore.calendarItem(withIdentifier: id) as? EKReminder else {
      call.reject("Напоминание с id \(id) не найдено")
      return
    }
    do {
      try eventStore.remove(item, commit: true)
      call.resolve(["success": true])
    } catch {
      call.reject("Ошибка удаления напоминания: \(error.localizedDescription)")
    }
  }
}
