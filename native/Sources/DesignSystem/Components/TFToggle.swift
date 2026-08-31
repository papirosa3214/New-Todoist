import SwiftUI

// Тумблер — spec/DESIGN-TOKENS.md §4 «Тумблер». Идентичен во всех местах
// приложения, свой вид не заводить. Дорожка 43×25, бегунок 20×20, отступ
// 2.5px со всех сторон, переход 150ms (`dur-fast`).
public struct TFToggle: View {
    @Binding var isOn: Bool

    public init(isOn: Binding<Bool>) { self._isOn = isOn }

    public var body: some View {
        Button {
            withAnimation(.easeInOut(duration: TFDuration.fast)) { isOn.toggle() }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                RoundedRectangle(cornerRadius: TFRadius.full)
                    .fill(isOn ? Color.tfRed : Color.tfCard2)
                    .overlay {
                        if !isOn {
                            RoundedRectangle(cornerRadius: TFRadius.full)
                                .strokeBorder(Color.tfStroke, lineWidth: TFBorder.width)
                        }
                    }
                Circle()
                    .fill(.white)
                    .tfShadow(TFShadow.toggle)
                    .padding(TFToggleMetrics.knobInset)
                    .frame(width: TFToggleMetrics.trackHeight) // квадрат по высоте дорожки, инсет даёт нужные 20px
            }
            .frame(width: TFToggleMetrics.trackWidth, height: TFToggleMetrics.trackHeight)
            // Расширенная тап-зона 44×44 по центру дорожки — визуально дорожка мельче тап-порога.
            .frame(minWidth: TFHitTarget.min, minHeight: TFHitTarget.min)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview("Тумблер") {
    HStack(spacing: TFSpacing.lg) {
        TFToggle(isOn: .constant(true))
        TFToggle(isOn: .constant(false))
    }
    .padding()
    .background(Color.tfBackground)
}
