// TaskActivityWidget.swift
// SwiftUI реализация Dynamic Island и Live Activity на экране блокировки.

import ActivityKit
import SwiftUI
import UIKit
import WidgetKit

@available(iOS 16.1, *)
// Цвета островка — те же, что в приложении (src/index.css, DESIGN.md §2).
// Раньше здесь стояли системные синий и оранжевый «на глаз»: в приложении
// «в работе» бирюзовый, «на проверке» синий, а островок красил их синим и
// оранжевым — один и тот же статус выглядел двумя разными вещами.
enum TFColor {
  static let teal = Color(hex: "#35B8A3")   // в работе
  static let blue = Color(hex: "#4A9FD8")   // на проверке
  static let orange = Color(hex: "#FF9A14") // заблокирована
  static let green = Color(hex: "#15937E")  // выполнена
  static let dim = Color(hex: "#A6A6A6")
}

/// Один цвет на состояние — им красится и текст ярлыка, и полоса прогресса,
/// и счётчик шагов, чтобы карточка читалась одним взглядом.
@available(iOS 16.1, *)
func tfAccent(for status: String) -> Color {
  switch status {
  case "review": return TFColor.blue
  case "blocked": return TFColor.orange
  case "completed": return TFColor.green
  default: return TFColor.teal
  }
}

/// Картинка участника, а если её в расширении нет — буква на цветном кружке,
/// как было раньше. Файлы лежат в ассетах самого расширения: сети у Live
/// Activity нет, скачать нечего и негде.
@available(iOS 16.1, *)
struct AssigneeBadge: View {
  let slug: String?
  let initials: String
  let color: String
  let size: CGFloat

  private var hasImage: Bool {
    guard let slug, !slug.isEmpty else { return false }
    return UIImage(named: "avatar-\(slug)") != nil
  }

  var body: some View {
    if hasImage, let slug {
      Image("avatar-\(slug)")
        .resizable()
        .scaledToFit()
        .frame(width: size, height: size)
    } else {
      Circle()
        .fill(Color(hex: color))
        .frame(width: size, height: size)
        .overlay(
          Text(initials)
            .font(.system(size: size * 0.5, weight: .bold))
            .foregroundColor(.white)
        )
    }
  }
}

/// Аватарка в кольце прогресса — для свёрнутого островка и минимального
/// кружка. Когда в работе несколько задач, система показывает две карточки:
/// одну у выреза камеры, вторую отдельным кружком справа. В этом кружке
/// помещается ровно один значок, и он должен отвечать сразу на два вопроса:
/// чья это задача и далеко ли до конца. Цифры туда не влезают, кольцо — влезает.
@available(iOS 16.1, *)
struct AssigneeProgressBadge: View {
  let slug: String?
  let initials: String
  let color: String
  let progress: Double
  let accent: Color
  /// Диаметр самой картинки, кольцо рисуется вокруг неё.
  let size: CGFloat

  // Кольцо выводится из размера картинки, а не подбирается на глаз: толщина —
  // восьмая часть диаметра, зазор между картинкой и кольцом — половина
  // толщины. При size = 14 это 1.75 и 0.88, внешний габарит 19.25 pt: влезает
  // и в компактную зону островка, и в минимальный кружок.
  private var stroke: CGFloat { size / 8 }
  private var outer: CGFloat { size + stroke * 3 }

  var body: some View {
    ZStack {
      Circle()
        .stroke(Color.white.opacity(0.18), lineWidth: stroke)
      Circle()
        // Минимум 0.02 — чтобы в самом начале работы кольцо не пропадало
        // вовсе: точка на месте старта читается как «взялись», пустота — как
        // «сломалось».
        .trim(from: 0, to: max(0.02, min(1.0, progress)))
        .stroke(accent, style: StrokeStyle(lineWidth: stroke, lineCap: .round))
        .rotationEffect(.degrees(-90))
      AssigneeBadge(slug: slug, initials: initials, color: color, size: size)
    }
    .frame(width: outer, height: outer)
  }
}

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
        //
        // Верх обходит вырез камеры и делится пополам — длинному тексту там
        // не место, но и пустым его оставлять нельзя: пустой блок системе не
        // схлопнуть, он всё равно держит высоту, и весь остальной контент
        // уезжает вниз с огромным провалом (так и вышло с первой попытки —
        // Максим 24.08.2026: «зачем ты вниз спустил так сильно»). Поэтому по
        // бокам от выреза стоит то, что и должно быть коротким: слева
        // картинка участника, справа счёт шагов.
        DynamicIslandExpandedRegion(.leading) {
          AssigneeBadge(
            slug: context.state.assigneeSlug,
            initials: context.state.assigneeInitials,
            color: context.state.assigneeColor,
            size: 34
          )
          .padding(.leading, 6)
        }

        DynamicIslandExpandedRegion(.trailing) {
          Group {
            if context.state.totalSubtasks > 0 {
              Text("\(context.state.doneSubtasks)/\(context.state.totalSubtasks)")
            } else {
              Text("\(Int(context.state.progress * 100))%")
            }
          }
          .font(.system(size: 17, weight: .bold, design: .rounded))
          .foregroundColor(tfAccent(for: context.state.status))
          .padding(.trailing, 8)
        }

        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 4) {
            // Название — во всю ширину, под вырезом. Две строки: третья уже
            // распирает карточку по высоте, а обрезка по многоточию читается
            // не хуже.
            Text(context.state.taskTitle)
              .font(.system(size: 15, weight: .bold))
              .foregroundColor(.white)
              .lineLimit(2)
              .fixedSize(horizontal: false, vertical: true)
              .frame(maxWidth: .infinity, alignment: .leading)

            // Текущий шаг
            if let sub = context.state.currentSubtask, !sub.isEmpty {
              HStack(spacing: 5) {
                Image(systemName: "arrow.triangle.2.circlepath")
                  .font(.system(size: 10, weight: .bold))
                  .foregroundColor(tfAccent(for: context.state.status))
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
                      colors: [
                        tfAccent(for: context.state.status),
                        tfAccent(for: context.state.status).opacity(0.65),
                      ],
                      startPoint: .leading,
                      endPoint: .trailing
                    )
                  )
                  .frame(width: max(6, geo.size.width * CGFloat(context.state.progress)), height: 6)
              }
            }
            .frame(height: 6)

            // Нижняя строка: проект и статус слева, время справа. Счёт шагов
            // сюда не дублируем — он крупно стоит наверху, у выреза.
            HStack(spacing: 6) {
              Text(context.state.statusLabel)
                .font(.system(size: 10, weight: .semibold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(statusBackgroundColor(for: context.state.status))
                .foregroundColor(statusTextColor(for: context.state.status))
                .cornerRadius(6)

              if let proj = context.state.projectName, !proj.isEmpty {
                Text(proj)
                  .font(.system(size: 10, weight: .medium))
                  .foregroundColor(Color(hex: context.state.projectColor ?? "#A6A6A6"))
                  .lineLimit(1)
              }

              Spacer()

              // Бегущее время работы — единственная честная «живость» в
              // островке: система сама тикает этим текстом каждую секунду,
              // без анимаций и без обновлений с сервера. Раньше здесь висело
              // «N мин назад», которое замирало намертво, стоило свернуть
              // приложение.
              Text(
                timerInterval: context.state.startedAt...context.state.startedAt.addingTimeInterval(24 * 3600),
                countsDown: false
              )
              .font(.system(size: 11, design: .rounded))
              .monospacedDigit()
              .foregroundColor(.gray)
              .frame(maxWidth: 46, alignment: .trailing)
            }
          }
          .padding(.horizontal, 8)
          .padding(.top, 2)
        }
      } compactLeading: {
        // 2. КОМПАКТНЫЙ ВИД СЛЕВА
        AssigneeProgressBadge(
          slug: context.state.assigneeSlug,
          initials: context.state.assigneeInitials,
          color: context.state.assigneeColor,
          progress: context.state.progress,
          accent: tfAccent(for: context.state.status),
          size: 14
        )
      } compactTrailing: {
        // 3. КОМПАКТНЫЙ ВИД СПРАВА
        if context.state.totalSubtasks > 0 {
          Text("\(context.state.doneSubtasks)/\(context.state.totalSubtasks)")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundColor(tfAccent(for: context.state.status))
        } else {
          Text("\(Int(context.state.progress * 100))%")
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundColor(tfAccent(for: context.state.status))
        }
      } minimal: {
        // 4. МИНИМАЛЬНЫЙ ВИД
        //
        // Сюда система отправляет вторую задачу, когда в работе их несколько.
        // Раньше здесь был просто цветной кружок: две задачи одного агента
        // выглядели одинаково, и понять, что за работа идёт справа, было
        // нельзя — только разворачивать. Теперь тот же значок, что и в
        // компактном виде: чья задача и сколько пройдено.
        AssigneeProgressBadge(
          slug: context.state.assigneeSlug,
          initials: context.state.assigneeInitials,
          color: context.state.assigneeColor,
          progress: context.state.progress,
          accent: tfAccent(for: context.state.status),
          size: 14
        )
      }
      .widgetURL(URL(string: "taskflow://task/\(context.attributes.taskId)"))
    }
  }

  private func statusBackgroundColor(for status: String) -> Color {
    tfAccent(for: status).opacity(0.18)
  }

  private func statusTextColor(for status: String) -> Color {
    tfAccent(for: status)
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
          AssigneeBadge(
            slug: state.assigneeSlug,
            initials: state.assigneeInitials,
            color: state.assigneeColor,
            size: 16
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
            .foregroundColor(tfAccent(for: state.status))
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
                  colors: [
                    tfAccent(for: state.status),
                    tfAccent(for: state.status).opacity(0.65),
                  ],
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
            .foregroundColor(tfAccent(for: state.status))
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
