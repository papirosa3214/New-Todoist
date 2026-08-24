// TaskActivityAttributes.swift
// Модель данных для Dynamic Island и Live Activities (ActivityKit).

import ActivityKit
import Foundation

@available(iOS 16.1, *)
public struct TaskActivityAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var status: String              // "in_progress", "review", "blocked", "completed"
    public var statusLabel: String         // "В работе", "На проверке", "Заблокирована"
    public var currentSubtask: String?     // Текущая подзадача
    public var totalSubtasks: Int          // Всего подзадач
    public var doneSubtasks: Int           // Выполнено подзадач
    public var progress: Double            // 0.0 ... 1.0
    public var assigneeName: String        // "Hermes", "Claude", "Максим"
    public var assigneeInitials: String    // "H", "C", "М"
    public var assigneeColor: String       // Hex color: "#4CAF50"
    public var taskTitle: String           // Название задачи
    public var projectName: String?        // Проект
    public var projectColor: String?       // Hex color: "#E44235"
    public var updatedAt: Date

    public init(
      status: String = "in_progress",
      statusLabel: String = "В работе",
      currentSubtask: String? = nil,
      totalSubtasks: Int = 0,
      doneSubtasks: Int = 0,
      progress: Double = 0.0,
      assigneeName: String = "Агент",
      assigneeInitials: String = "А",
      assigneeColor: String = "#3A82F6",
      taskTitle: String = "Задача",
      projectName: String? = nil,
      projectColor: String? = nil,
      updatedAt: Date = Date()
    ) {
      self.status = status
      self.statusLabel = statusLabel
      self.currentSubtask = currentSubtask
      self.totalSubtasks = totalSubtasks
      self.doneSubtasks = doneSubtasks
      self.progress = progress
      self.assigneeName = assigneeName
      self.assigneeInitials = assigneeInitials
      self.assigneeColor = assigneeColor
      self.taskTitle = taskTitle
      self.projectName = projectName
      self.projectColor = projectColor
      self.updatedAt = updatedAt
    }
  }

  public var taskId: String

  public init(taskId: String) {
    self.taskId = taskId
  }
}
