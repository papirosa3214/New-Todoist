// TaskFlowAppIntents.swift
// Нативные системные App Intents и App Shortcuts для iOS 16+.
//
// Позволяет:
// 1. Запускать диктовку задачи из Action Button, Control Center и Экрана блокировки с родной иконкой приложения (не Safari).
// 2. Вызывать голосом через Siri («Надиктовать задачу в TaskFlow»).

import AppIntents
import Foundation
import UIKit

@available(iOS 16.0, *)
public struct RecordTaskIntent: AppIntent {
  public static var title: LocalizedStringResource = "Надиктовать задачу"
  public static var description = IntentDescription("Открывает создание задачи и сразу запускает запись голоса")
  public static var openAppWhenRun: Bool = true

  public init() {}

  @MainActor
  public func perform() async throws -> some IntentResult {
    if let url = URL(string: "taskflow://dictate") {
      await UIApplication.shared.open(url)
    }
    return .result()
  }
}

@available(iOS 16.0, *)
public struct NewTaskIntent: AppIntent {
  public static var title: LocalizedStringResource = "Новая задача"
  public static var description = IntentDescription("Открывает форму создания новой задачи в TaskFlow")
  public static var openAppWhenRun: Bool = true

  public init() {}

  @MainActor
  public func perform() async throws -> some IntentResult {
    if let url = URL(string: "taskflow://new-task") {
      await UIApplication.shared.open(url)
    }
    return .result()
  }
}

@available(iOS 16.0, *)
public struct TaskFlowShortcuts: AppShortcutsProvider {
  public static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: RecordTaskIntent(),
      phrases: [
        "Надиктовать задачу в \(.applicationName)",
        "Записать задачу в \(.applicationName)",
        "Быстрая запись в \(.applicationName)",
      ],
      shortTitle: "Диктовка задачи",
      systemImageName: "mic.fill"
    )
    AppShortcut(
      intent: NewTaskIntent(),
      phrases: [
        "Новая задача в \(.applicationName)",
        "Создать задачу в \(.applicationName)",
      ],
      shortTitle: "Новая задача",
      systemImageName: "plus.circle.fill"
    )
  }
}
