// TaskActivityWidget.swift
// SwiftUI реализация Dynamic Island и Live Activity на экране блокировки.

import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.1, *)
struct TaskActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: TaskActivityAttributes.self) { context in
      // ── Виджет на экране блокировки (Lock Screen Banner) ──
      LockScreenActivityView(state: context.state, taskId: context.attributes.taskId)
        .activityBackgroundTint(Color.black.opacity(0.85))
        .activitySystemActionForegroundColor(Color.white)
    } dynamicIsland: { context in
      // ── Dynamic Island ──
      DynamicIsland {
        // 1. РАЗВЁРНУТЫЙ ВИД (Expanded) при зажатии или тапе на островок
        DynamicIslandExpandedRegion(.leading) {
          VStack(alignment: .leading, spacing: 3) {
            if let proj = context.state.projectName, !proj.isEmpty {
              HStack(spacing: 4) {
                Circle()
                  .fill(Color(hex: context.state.projectColor ?? "#A6A6A6"))
                  .frame(width: 6, height: 6)
                Text(proj)
                  .font(.system(size: 11, weight: .semibold))
                  .foregroundColor(Color(hex: context.state.projectColor ?? "#A6A6A6"))
                  .lineLimit(1)
              }
            }
            Text(context.state.taskTitle)
              .font(.system(size: 14, weight: .bold))
              .foregroundColor(.white)
              .lineLimit(2)
          }
          .padding(.leading, 8)
        }

        DynamicIslandExpandedRegion(.trailing) {
          VStack(alignment: .trailing, spacing: 4) {
            // Аватарка исполнителя
            HStack(spacing: 4) {
              Text(context.state.assigneeName)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(.gray)
                .lineLimit(1)

              Circle()
                .fill(Color(hex: context.state.assigneeColor))
                .frame(width: 20, height: 20)
                .overlay(
                  Text(context.state.assigneeInitials)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.white)
                )
            }

            // Кольцо прогресса
            if context.state.totalSubtasks > 0 {
              Text("\(context.state.doneSubtasks)/\(context.state.totalSubtasks)")
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundColor(.white)
            } else {
              Text("\(Int(context.state.progress * 100))%")
                .font(.system(size: 12, weight: .bold, design: .rounded))
                .foregroundColor(Color(hex: "#007AFF"))
            }
          }
          .padding(.trailing, 8)
        }

        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            // Текущая подзадача
            if let sub = context.state.currentSubtask, !sub.isEmpty {
              HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.2.circlepath")
                  .font(.system(size: 10, weight: .bold))
                  .foregroundColor(Color(hex: "#007AFF"))
                Text(sub)
                  .font(.system(size: 12, weight: .medium))
                  .foregroundColor(.white.opacity(0.9))
                  .lineLimit(1)
              }
            }

            // Шкала прогресса
            GeometryReader { geo in
              ZStack(alignment: .leading) {
                Capsule()
                  .fill(Color.white.opacity(0.15))
                  .frame(height: 6)
                Capsule()
                  .fill(
                    LinearGradient(
                      colors: [Color(hex: "#007AFF"), Color(hex: "#34C759")],
                      startPoint: .leading,
                      endPoint: .trailing
                    )
                  )
                  .frame(width: max(6, geo.size.width * CGFloat(context.state.progress)), height: 6)
              }
            }
            .frame(height: 6)

            // Статус
            HStack {
              Text(context.state.statusLabel)
                .font(.system(size: 10, weight: .semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(statusBackgroundColor(for: context.state.status))
                .foregroundColor(statusTextColor(for: context.state.status))
                .cornerRadius(6)

              Spacer()

              Text(timeAgo(date: context.state.updatedAt))
                .font(.system(size: 10))
                .foregroundColor(.gray)
            }
          }
          .padding(.horizontal, 8)
          .padding(.top, 4)
        }
      } compactLeading: {
        // 2. КОМПАКТНЫЙ ВИД СЛЕВА
        HStack(spacing: 3) {
          Circle()
            .fill(Color(hex: context.state.assigneeColor))
            .frame(width: 14, height: 14)
            .overlay(
              Text(context.state.assigneeInitials)
                .font(.system(size: 8, weight: .bold))
                .foregroundColor(.white)
            )
        }
      } compactTrailing: {
        // 3. КОМПАКТНЫЙ ВИД СПРАВА
        if context.state.totalSubtasks > 0 {
          Text("\(context.state.doneSubtasks)/\(context.state.totalSubtasks)")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundColor(Color(hex: "#007AFF"))
        } else {
          Text("\(Int(context.state.progress * 100))%")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundColor(Color(hex: "#007AFF"))
        }
      } minimal: {
        // 4. МИНИМАЛЬНЫЙ ВИД
        Circle()
          .fill(Color(hex: context.state.assigneeColor))
          .frame(width: 12, height: 12)
      }
      .widgetURL(URL(string: "taskflow://task/\(context.attributes.taskId)"))
    }
  }

  private func statusBackgroundColor(for status: String) -> Color {
    switch status {
    case "in_progress": return Color.blue.opacity(0.2)
    case "review": return Color.orange.opacity(0.2)
    case "blocked": return Color.red.opacity(0.2)
    case "completed": return Color.green.opacity(0.2)
    default: return Color.gray.opacity(0.2)
    }
  }

  private func statusTextColor(for status: String) -> Color {
    switch status {
    case "in_progress": return Color(hex: "#3B82F6")
    case "review": return Color(hex: "#F59E0B")
    case "blocked": return Color(hex: "#EF4444")
    case "completed": return Color(hex: "#10B981")
    default: return Color.gray
    }
  }

  private func timeAgo(date: Date) -> String {
    let seconds = Int(-date.timeIntervalSinceNow)
    if seconds < 60 { return "только что" }
    let mins = seconds / 60
    return "\(mins) мин назад"
  }
}

// ── Баннер на экране блокировки ──
@available(iOS 16.1, *)
struct LockScreenActivityView: View {
  let state: TaskActivityAttributes.ContentState
  let taskId: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      // Верхняя строка: проект + исполнитель + статус
      HStack {
        if let proj = state.projectName, !proj.isEmpty {
          HStack(spacing: 4) {
            Circle()
              .fill(Color(hex: state.projectColor ?? "#A6A6A6"))
              .frame(width: 6, height: 6)
            Text(proj)
              .font(.system(size: 12, weight: .semibold))
              .foregroundColor(Color(hex: state.projectColor ?? "#A6A6A6"))
          }
        }

        Spacer()

        HStack(spacing: 4) {
          Circle()
            .fill(Color(hex: state.assigneeColor))
            .frame(width: 16, height: 16)
            .overlay(
              Text(state.assigneeInitials)
                .font(.system(size: 8, weight: .bold))
                .foregroundColor(.white)
            )
          Text(state.assigneeName)
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.white)
        }
      }

      // Заголовок задачи
      Text(state.taskTitle)
        .font(.system(size: 15, weight: .bold))
        .foregroundColor(.white)
        .lineLimit(2)

      // Текущая подзадача
      if let sub = state.currentSubtask, !sub.isEmpty {
        HStack(spacing: 6) {
          Image(systemName: "arrow.triangle.2.circlepath")
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(Color(hex: "#007AFF"))
          Text(sub)
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(.white.opacity(0.9))
            .lineLimit(1)
        }
      }

      // Прогресс
      VStack(spacing: 4) {
        GeometryReader { geo in
          ZStack(alignment: .leading) {
            Capsule()
              .fill(Color.white.opacity(0.15))
              .frame(height: 6)
            Capsule()
              .fill(
                LinearGradient(
                  colors: [Color(hex: "#007AFF"), Color(hex: "#34C759")],
                  startPoint: .leading,
                  endPoint: .trailing
                )
              )
              .frame(width: max(6, geo.size.width * CGFloat(state.progress)), height: 6)
          }
        }
        .frame(height: 6)

        HStack {
          if state.totalSubtasks > 0 {
            Text("\(state.doneSubtasks) из \(state.totalSubtasks) шагов")
              .font(.system(size: 11, weight: .medium))
              .foregroundColor(.gray)
          }
          Spacer()
          Text("\(Int(state.progress * 100))%")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundColor(Color(hex: "#007AFF"))
        }
      }
    }
    .padding(14)
    .widgetURL(URL(string: "taskflow://task/\(taskId)"))
  }
}

// Вспомогательный инициализатор Color из HEX строки
extension Color {
  init(hex: String) {
    let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var int: UInt64 = 0
    Scanner(string: hex).scanHexInt64(&int)
    let a, r, g, b: UInt64
    switch hex.count {
    case 3: // RGB (12-bit)
      (a, r, g, b) = (255, (int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
    case 6: // RGB (24-bit)
      (a, r, g, b) = (255, int >> 16, int >> 8 & 0xFF, int & 0xFF)
    case 8: // ARGB (32-bit)
      (a, r, g, b) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
    default:
      (a, r, g, b) = (255, 128, 128, 128)
    }
    self.init(
      .sRGB,
      red: Double(r) / 255,
      green: Double(g) / 255,
      blue: Double(b) / 255,
      opacity: Double(a) / 255
    )
  }
}
