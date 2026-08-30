// LiveActivityPlugin.swift
// Нативный Capacitor-плагин для управления Dynamic Island и Live Activities (ActivityKit).

import ActivityKit
import Capacitor
import Foundation

@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "LiveActivityPlugin"
  public let jsName = "LiveActivity"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "startTaskActivity", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "updateTaskActivity", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "endTaskActivity", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "listActivities", returnType: CAPPluginReturnPromise),
  ]

  @objc func isAvailable(_ call: CAPPluginCall) {
    if #available(iOS 16.1, *) {
      let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
      call.resolve(["available": true, "enabled": enabled])
    } else {
      call.resolve(["available": false, "enabled": false])
    }
  }

  @objc func startTaskActivity(_ call: CAPPluginCall) {
    guard #available(iOS 16.1, *) else {
      call.reject("Live Activities доступны только на iOS 16.1+")
      return
    }

    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      call.reject("Live Activities отключены в системных настройках iOS")
      return
    }

    guard let taskId = call.getString("taskId"), !taskId.isEmpty else {
      call.reject("taskId обязателен")
      return
    }

    let taskTitle = call.getString("taskTitle") ?? "Задача"
    let assigneeName = call.getString("assigneeName") ?? "Агент"
    let assigneeInitials = call.getString("assigneeInitials") ?? String(assigneeName.prefix(1))
    let assigneeColor = call.getString("assigneeColor") ?? "#3A82F6"
    let projectName = call.getString("projectName")
    let projectColor = call.getString("projectColor")
    let totalSubtasks = call.getInt("totalSubtasks") ?? 0
    let doneSubtasks = call.getInt("doneSubtasks") ?? 0
    let currentSubtask = call.getString("currentSubtask")
    let status = call.getString("status") ?? "in_progress"
    let statusLabel = call.getString("statusLabel") ?? "В работе"
    let assigneeSlug = call.getString("assigneeSlug")
    // Точка отсчёта таймера приходит из приложения: это момент, когда агент
    // взял задачу (журнал задачи), а не момент запуска карточки. Иначе счётчик
    // обнулялся бы каждый раз, когда человек открывает приложение заново.
    let startedAt = call.getDouble("startedAtUnix").map { Date(timeIntervalSince1970: $0) } ?? Date()

    let progress: Double
    if totalSubtasks > 0 {
      progress = Double(doneSubtasks) / Double(totalSubtasks)
    } else {
      progress = call.getDouble("progress") ?? 0.0
    }

    let attributes = TaskActivityAttributes(taskId: taskId)
    let initialContentState = TaskActivityAttributes.ContentState(
      status: status,
      statusLabel: statusLabel,
      currentSubtask: currentSubtask,
      totalSubtasks: totalSubtasks,
      doneSubtasks: doneSubtasks,
      progress: progress,
      assigneeName: assigneeName,
      assigneeInitials: assigneeInitials,
      assigneeColor: assigneeColor,
      taskTitle: taskTitle,
      projectName: projectName,
      projectColor: projectColor,
      updatedAt: Date(),
      assigneeSlug: assigneeSlug,
      startedAt: startedAt
    )

    // Завершаем предыдущие активити для этой же задачи, если были
    for existing in Activity<TaskActivityAttributes>.activities where existing.attributes.taskId == taskId {
      Task {
        await existing.end(dismissalPolicy: .immediate)
      }
    }

    do {
      // pushType: .token — единственный способ двигать островок, пока
      // приложение свёрнуто: JS в фоне не выполняется, и обновлять активность
      // изнутри некому. С токеном это делает сервер через APNs
      // (server/src/apns.ts). Без него карточка замирала на данных момента
      // запуска — ровно то, на что жаловался Максим 24.08.2026.
      let activity: Activity<TaskActivityAttributes>
      if #available(iOS 16.2, *) {
        activity = try Activity.request(
          attributes: attributes,
          content: ActivityContent(state: initialContentState, staleDate: Self.staleDate()),
          pushType: .token
        )
      } else {
        activity = try Activity.request(
          attributes: attributes,
          contentState: initialContentState,
          pushType: .token
        )
      }
      observePushToken(activity)
      call.resolve([
        "id": activity.id,
        "taskId": taskId,
        "started": true
      ])
    } catch {
      call.reject("Ошибка запуска Live Activity: \(error.localizedDescription)")
    }
  }

  /// После этого момента iOS считает данные карточки протухшими и рисует её
  /// приглушённо. Пуш с сервера каждый раз отодвигает границу; если сервер
  /// замолчал, человек это видит, а не смотрит на устаревшие цифры как на
  /// свежие.
  @available(iOS 16.2, *)
  private static func staleDate() -> Date {
    Date().addingTimeInterval(15 * 60)
  }

  /// Токен активности выдаётся не сразу и меняется со временем, поэтому его
  /// не вернуть ответом на startTaskActivity — он приходит потоком. Каждое
  /// значение уходит событием в JS, а тот отдаёт его серверу.
  @available(iOS 16.1, *)
  private func observePushToken(_ activity: Activity<TaskActivityAttributes>) {
    Task { [weak self] in
      for await tokenData in activity.pushTokenUpdates {
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        self?.notifyListeners(
          "activityPushToken",
          data: ["taskId": activity.attributes.taskId, "token": hex]
        )
      }
    }
  }

  /// Приложение перезапустили, а активность с прошлого раза жива: её токен
  /// система могла сменить, и без повторной подписки сервер будет слать пуши
  /// в никуда.
  override public func load() {
    guard #available(iOS 16.1, *) else { return }
    for activity in Activity<TaskActivityAttributes>.activities {
      observePushToken(activity)
    }
  }

  @objc func updateTaskActivity(_ call: CAPPluginCall) {
    guard #available(iOS 16.1, *) else {
      call.reject("Live Activities доступны только на iOS 16.1+")
      return
    }

    guard let taskId = call.getString("taskId"), !taskId.isEmpty else {
      call.reject("taskId обязателен")
      return
    }

    let matchingActivities = Activity<TaskActivityAttributes>.activities.filter {
      $0.attributes.taskId == taskId
    }

    guard !matchingActivities.isEmpty else {
      call.resolve(["updated": false, "reason": "No active activity found for task"])
      return
    }

    for activity in matchingActivities {
      var current = activity.contentState

      if let status = call.getString("status") { current.status = status }
      if let statusLabel = call.getString("statusLabel") { current.statusLabel = statusLabel }
      if let currentSubtask = call.getString("currentSubtask") { current.currentSubtask = currentSubtask }
      if let totalSubtasks = call.getInt("totalSubtasks") { current.totalSubtasks = totalSubtasks }
      if let doneSubtasks = call.getInt("doneSubtasks") { current.doneSubtasks = doneSubtasks }
      if let taskTitle = call.getString("taskTitle") { current.taskTitle = taskTitle }
      if let assigneeName = call.getString("assigneeName") { current.assigneeName = assigneeName }
      if let assigneeColor = call.getString("assigneeColor") { current.assigneeColor = assigneeColor }
      if let projectName = call.getString("projectName") { current.projectName = projectName }
      if let projectColor = call.getString("projectColor") { current.projectColor = projectColor }
      if let assigneeSlug = call.getString("assigneeSlug") { current.assigneeSlug = assigneeSlug }
      // startedAt намеренно не трогаем: это точка отсчёта таймера, она задаётся
      // один раз при запуске карточки. Перезапишем — счётчик будет прыгать в
      // ноль на каждом обновлении.

      if current.totalSubtasks > 0 {
        current.progress = Double(current.doneSubtasks) / Double(current.totalSubtasks)
      } else if let progress = call.getDouble("progress") {
        current.progress = progress
      }
      current.updatedAt = Date()

      Task { [current] in
        if #available(iOS 16.2, *) {
          await activity.update(
            ActivityContent(state: current, staleDate: Self.staleDate())
          )
        } else {
          await activity.update(using: current)
        }
      }
    }

    call.resolve(["updated": true, "count": matchingActivities.count])
  }

  @objc func endTaskActivity(_ call: CAPPluginCall) {
    guard #available(iOS 16.1, *) else {
      call.resolve(["ended": false])
      return
    }

    let taskId = call.getString("taskId")
    let activitiesToEnd = Activity<TaskActivityAttributes>.activities.filter {
      taskId == nil || $0.attributes.taskId == taskId
    }

    for activity in activitiesToEnd {
      Task {
        await activity.end(dismissalPolicy: .immediate)
      }
    }

    call.resolve(["ended": true, "count": activitiesToEnd.count])
  }

  @objc func listActivities(_ call: CAPPluginCall) {
    guard #available(iOS 16.1, *) else {
      call.resolve(["activities": []])
      return
    }

    let list = Activity<TaskActivityAttributes>.activities.map { act in
      return [
        "id": act.id,
        "taskId": act.attributes.taskId,
        "taskTitle": act.contentState.taskTitle,
        "status": act.contentState.status,
        "progress": act.contentState.progress,
        "doneSubtasks": act.contentState.doneSubtasks,
        "totalSubtasks": act.contentState.totalSubtasks,
      ]
    }

    call.resolve(["activities": list])
  }
}
