import SwiftUI

// «Кто сейчас работает» — 1:1 `TypingLine` из `ChatScreen.tsx` + анимация
// точек `nt-typing-dot` (spec/DESIGN-TOKENS.md §5: период 1.2с, сдвиг фазы
// 0.2с на точку). Имена НЕ сокращаются («и ещё N») — участников мало.
struct TypingLine: View {
    let typists: [ChatTypist]

    var body: some View {
        if !typists.isEmpty {
            HStack(spacing: TFSpacing.sm) {
                Text(who)
                    .tfText(.meta)
                    .foregroundStyle(Color.tfSub)
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { i in
                        TypingDot(delay: Double(i) * TFAnimation.typingDotPhaseShift)
                    }
                }
            }
            .padding(.horizontal, TFSpacing.lg)
        }
    }

    private var who: String {
        let names = typists.map(\.name)
        if names.count == 1 { return "\(names[0]) работает…" }
        let head = names.dropLast().joined(separator: ", ")
        return "\(head) и \(names.last ?? "") работают…"
    }
}

private struct TypingDot: View {
    let delay: Double
    @State private var lit = false

    var body: some View {
        Circle()
            .fill(Color.tfSub)
            .frame(width: 4, height: 4)
            .opacity(lit ? 1 : 0.25)
            .onAppear {
                withAnimation(
                    .easeInOut(duration: TFAnimation.typingDotPeriod / 2)
                        .repeatForever(autoreverses: true)
                        .delay(delay)
                ) {
                    lit = true
                }
            }
    }
}

#Preview("Печатает") {
    VStack(alignment: .leading, spacing: TFSpacing.lg) {
        TypingLine(typists: [ChatTypist(userId: "1", name: "Гермес")])
        TypingLine(typists: [
            ChatTypist(userId: "1", name: "Гермес"),
            ChatTypist(userId: "2", name: "DeepSeek-Agent"),
        ])
    }
    .padding()
    .background(Color.tfBackground)
}
