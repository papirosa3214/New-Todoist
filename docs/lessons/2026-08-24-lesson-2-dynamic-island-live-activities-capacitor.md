# Урок 2: Интеграция Dynamic Island и Live Activities (ActivityKit) в гибридном приложении Capacitor (iOS / SwiftUI)

Подробное руководство по созданию живого динамического острова (Dynamic Island) и баннера экрана блокировки для отслеживания задач в реальном времени.

---

## 🏗️ Архитектура связки Capacitor ↔ iOS ActivityKit

1. **ActivityKit Extension (`TaskFlowWidgets.appex`)** — нативный Swift-виджет, рисующий SwiftUI-интерфейс в Dynamic Island.
2. **Swift Data Model (`TaskActivityAttributes`)** — статическая и динамическая структура данных (заголовок, проект, шаги, активный шаг, спиннер).
3. **Capacitor Bridge Plugin (`LiveActivityPlugin.swift`)** — мост, позволяющий вызывать `start`, `update`, `stop` прямо из TypeScript/React.
4. **React Hook (`useLiveActivitySync`)** — автоматическая синхронизация активной задачи с Dynamic Island.

---

## 💻 1. Определение структуры данных (Swift)

Создаётся файл `ios/App/TaskFlowWidgets/TaskActivityAttributes.swift`:

```swift
import ActivityKit
import Foundation

public struct TaskActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public var title: String            // Название задачи
        public var projectName: String      // Название проекта
        public var projectColor: String     // Цвет проекта (HEX)
        public var activeSubtask: String?   // Текущий выполняемый шаг
        public var isWorking: Bool          // Активен ли спиннер
        public var completedSubtasks: Int   // Количество готовых шагов
        public var totalSubtasks: Int       // Всего шагов
        public var agentName: String?       // Имя исполнителя (Claude, Antigravity)
        public var statusLabel: String      // "В работе", "На проверке"
        
        public init(
            title: String,
            projectName: String = "",
            projectColor: String = "#007AFF",
            activeSubtask: String? = nil,
            isWorking: Bool = false,
            completedSubtasks: Int = 0,
            totalSubtasks: Int = 0,
            agentName: String? = nil,
            statusLabel: String = "В работе"
        ) {
            self.title = title
            self.projectName = projectName
            self.projectColor = projectColor
            self.activeSubtask = activeSubtask
            self.isWorking = isWorking
            self.completedSubtasks = completedSubtasks
            self.totalSubtasks = totalSubtasks
            self.agentName = agentName
            self.statusLabel = statusLabel
        }
    }
    
    public var taskId: String
    public init(taskId: String) {
        self.taskId = taskId
    }
}
```

---

## 💻 2. SwiftUI виджет Dynamic Island

Файл `ios/App/TaskFlowWidgets/TaskActivityWidget.swift`:

```swift
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct TaskFlowWidgetBundle: WidgetBundle {
    var body: some Widget {
        TaskActivityWidget()
    }
}

struct TaskActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TaskActivityAttributes.self) { context in
            // ── Виджет на экране блокировки (Lock Screen Banner) ──
            LockScreenActivityView(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.85))
        } dynamicIsland: { context in
            DynamicIsland {
                // ── Развёрнутый остров (Expanded Island при долгом нажатии) ──
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color(hex: context.state.projectColor))
                            .frame(width: 8, height: 8)
                        Text(context.state.projectName)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.totalSubtasks > 0 {
                        Text("\(context.state.completedSubtasks)/\(context.state.totalSubtasks)")
                            .font(.system(size: 11, weight: .bold, design: .rounded))
                            .foregroundColor(.blue)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(context.state.title)
                            .font(.system(size: 14, weight: .bold))
                            .lineLimit(1)
                        
                        if let subtask = context.state.activeSubtask {
                            HStack(spacing: 5) {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .rotationEffect(.degrees(context.state.isWorking ? 360 : 0))
                                    .animation(context.state.isWorking ? .linear(duration: 2).repeatForever(autoreverses: false) : .default, value: context.state.isWorking)
                                Text(subtask)
                                    .font(.system(size: 12))
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                }
            } compactLeading: {
                // ── Компактный вид: Левая часть (иконка проекта/статуса) ──
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(Color(hex: context.state.projectColor))
                }
            } compactTrailing: {
                // ── Компактный вид: Правая часть (прогресс) ──
                Text("\(context.state.completedSubtasks)/\(context.state.totalSubtasks)")
                    .font(.system(size: 11, weight: .bold, design: .rounded))
                    .foregroundColor(.blue)
            } minimal: {
                // ── Минимальный вид (когда заняты оба острова) ──
                Image(systemName: "checklist")
                    .foregroundColor(.blue)
            }
        }
    }
}
```

---

## 💻 3. Нативный Capacitor Плагин-мост

Файл `ios/App/App/LiveActivityPlugin.swift`:

```swift
import Foundation
import Capacitor
import ActivityKit

@objc(LiveActivityPlugin)
public class LiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LiveActivityPlugin"
    public let jsName = "LiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopActivity", returnType: CAPPluginReturnPromise)
    ]
    
    private var currentActivity: Activity<TaskActivityAttributes>?

    @objc func startActivity(_ call: CAPPluginCall) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities отключены в настройках iOS")
            return
        }
        
        let taskId = call.getString("taskId") ?? UUID().uuidString
        let title = call.getString("title") ?? "Задача"
        let projectName = call.getString("projectName") ?? ""
        let projectColor = call.getString("projectColor") ?? "#007AFF"
        let activeSubtask = call.getString("activeSubtask")
        let isWorking = call.getBool("isWorking") ?? false
        let completed = call.getInt("completedSubtasks") ?? 0
        let total = call.getInt("totalSubtasks") ?? 0

        let attributes = TaskActivityAttributes(taskId: taskId)
        let initialContent = TaskActivityAttributes.ContentState(
            title: title,
            projectName: projectName,
            projectColor: projectColor,
            activeSubtask: activeSubtask,
            isWorking: isWorking,
            completedSubtasks: completed,
            totalSubtasks: total
        )

        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: .init(state: initialContent, staleDate: nil)
            )
            self.currentActivity = activity
            call.resolve(["id": activity.id])
        } catch {
            call.reject("Ошибка запуска Live Activity: \(error.localizedDescription)")
        }
    }

    @objc func updateActivity(_ call: CAPPluginCall) {
        guard let activity = currentActivity else {
            call.reject("Нет активного Dynamic Island")
            return
        }
        
        let title = call.getString("title") ?? activity.content.state.title
        let projectName = call.getString("projectName") ?? activity.content.state.projectName
        let projectColor = call.getString("projectColor") ?? activity.content.state.projectColor
        let activeSubtask = call.getString("activeSubtask")
        let isWorking = call.getBool("isWorking") ?? false
        let completed = call.getInt("completedSubtasks") ?? activity.content.state.completedSubtasks
        let total = call.getInt("totalSubtasks") ?? activity.content.state.totalSubtasks

        let updatedContent = TaskActivityAttributes.ContentState(
            title: title,
            projectName: projectName,
            projectColor: projectColor,
            activeSubtask: activeSubtask,
            isWorking: isWorking,
            completedSubtasks: completed,
            totalSubtasks: total
        )

        Task {
            await activity.update(.init(state: updatedContent, staleDate: nil))
            call.resolve(["updated": true])
        }
    }

    @objc func stopActivity(_ call: CAPPluginCall) {
        guard let activity = currentActivity else {
            call.resolve(["stopped": false])
            return
        }
        
        Task {
            await activity.end(nil, dismissalPolicy: .immediate)
            self.currentActivity = nil
            call.resolve(["stopped": true])
        }
    }
}
```

---

## 💻 4. Использование в React / TypeScript

Файл `src/lib/liveActivity.ts`:

```typescript
import { registerPlugin } from "@capacitor/core";

interface LiveActivityPlugin {
  startActivity(options: {
    taskId: string;
    title: string;
    projectName?: string;
    projectColor?: string;
    activeSubtask?: string;
    isWorking?: boolean;
    completedSubtasks?: number;
    totalSubtasks?: number;
  }): Promise<{ id: string }>;
  
  updateActivity(options: {
    title?: string;
    projectName?: string;
    projectColor?: string;
    activeSubtask?: string;
    isWorking?: boolean;
    completedSubtasks?: number;
    totalSubtasks?: number;
  }): Promise<{ updated: boolean }>;
  
  stopActivity(): Promise<{ stopped: boolean }>;
}

export const LiveActivity = registerPlugin<LiveActivityPlugin>("LiveActivity");
```

---

## ⚙️ 5. Настройка Xcode Project (`project.pbxproj`)
1. Добавить `NSSupportsLiveActivities = YES` в `Info.plist` основного приложения.
2. Создать Target **Widget Extension** (`TaskFlowWidgets`).
3. Включить **Automatic Code Signing** с вашим Apple Team ID.
