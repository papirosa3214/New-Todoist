import SwiftUI

// Тумблер — теперь обёртка над штатным `Toggle` (iOS 13+). Старый код
// рисовал свой Switch с дорожкой 43×25 и бегунком 20×20; штатный Switch
// в iOS 26 даёт визуально похожий результат. Кастомный акцентный цвет
// (`.tfRed` вместо `.accentColor`) идёт через `.tint(.tfRed)`.
public struct TFToggle: View {
    @Binding var isOn: Bool

    public init(isOn: Binding<Bool>) { self._isOn = isOn }

    public var body: some View {
        Toggle(isOn: $isOn) { EmptyView() }
            .labelsHidden()
            .tint(.tfRed)
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
