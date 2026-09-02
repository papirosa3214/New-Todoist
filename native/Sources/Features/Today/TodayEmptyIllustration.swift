import SwiftUI

// «Чёткое видение грядущего дня» — иллюстрация trueEmpty (spec §5.1).
// Порт SVG-смайлика из живого TodayScreen.tsx (лицо + 2 «листика» teal +
// 3 кольца green) на простые SwiftUI-фигуры — доносит тот же образ, не
// пиксель-в-пиксель со сплайнами исходного SVG-path.
struct TodayEmptyIllustration: View {
    var body: some View {
        VStack(spacing: TFSpacing.md) {
            ZStack {
                Circle().fill(Color.tfCard2).frame(width: 96, height: 96)
                HStack(spacing: 22) {
                    Circle().fill(.white).frame(width: 8, height: 8)
                    Circle().fill(.white).frame(width: 8, height: 8)
                }
                .offset(y: -8)
                // Улыбка
                UnevenRoundedRectangle(cornerRadii: .init(bottomLeading: 20, bottomTrailing: 20))
                    .trim(from: 0.5, to: 1)
                    .stroke(.white, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .frame(width: 24, height: 12)
                    .offset(y: 12)
                Ellipse().fill(Color.tfTeal).frame(width: 12, height: 6).rotationEffect(.degrees(-20)).offset(x: -32, y: -25)
                Ellipse().fill(Color.tfTeal).frame(width: 12, height: 6).rotationEffect(.degrees(20)).offset(x: 32, y: -25)
                Circle().strokeBorder(Color.tfGreen, lineWidth: 2).frame(width: 36, height: 36).offset(x: -50, y: 50)
                Circle().strokeBorder(Color.tfGreen, lineWidth: 2).frame(width: 28, height: 28).offset(x: 50, y: 40)
                Circle().strokeBorder(Color.tfGreen, lineWidth: 1.5).frame(width: 20, height: 20).offset(x: -20, y: 70)
            }
            .frame(height: 140)

            Text("Чёткое видение грядущего дня")
                .tfText(.title)
                .foregroundStyle(Color.tfText)
            Text("Задачи на сегодня появятся здесь, когда вы назначите дедлайн.")
                .tfText(.row)
                .foregroundStyle(Color.tfSub)
                .multilineTextAlignment(.center)
                .padding(.horizontal, TFSpacing.xl)
        }
        .padding(.top, TFSpacing.xl)
    }
}
