import SwiftUI

// Экран-демонстрация своей клавиатуры — нативный аналог KeyboardDemoScreen.tsx
// (веб, /kb-demo, отсоединён от навигации 20.08.2026, но именно оттуда сняты
// раскладка и геометрия — спека §0). Здесь, в отличие от веба, это не DOM-хак
// поверх системной клавиатуры: тап по полю честно показывает inputView,
// системная клавиатура вообще не участвует в процессе.
//
// Экран НЕ подключён ни к какой навигации — App/ и таббар это территория
// каркасного исполнителя (волна 1, ARCHITECTURE.md), здесь просто
// самодостаточный View, который можно открыть напрямую для проверки/показа.
// Использует токены DesignSystem (TFSpacing/TFRadius/TFField/Color.tfCard и
// т.д. из Sources/DesignSystem) — тело экрана сделано из того же материала,
// что и остальной интерфейс; своя ЛОКАЛЬНАЯ палитра есть только у самой
// панели клавиатуры (TFKeyboardPalette, см. её файл — почему).
public struct TFKeyboardDemoScreen: View {
    @State private var title: String = ""
    @State private var note: String = ""

    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.lg) {
            VStack(alignment: .leading, spacing: TFSpacing.xs) {
                Text("Своя клавиатура")
                    .tfText(.taskTitle)
                    .foregroundStyle(Color.tfText)
                Text("Тапни по полю и набирай — системная клавиатура здесь не участвует, показывается наша (inputView).")
                    .tfText(.action)
                    .foregroundStyle(Color.tfSub)
            }

            VStack(alignment: .leading, spacing: TFSpacing.sm) {
                TFKeyboardTextField(text: $title, placeholder: "Название задачи")
                    .frame(height: TFField.height)
                    .padding(.horizontal, TFField.cardInsetH)
                    .background(Color.tfCard)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg, style: .continuous))

                Text("Символов: \(title.count)")
                    .tfText(.caption)
                    .foregroundStyle(Color.tfDim)
            }

            VStack(alignment: .leading, spacing: TFSpacing.sm) {
                Text("Многострочное поле — Enter переносит строку, не отправляет")
                    .tfText(.action)
                    .foregroundStyle(Color.tfSub)
                TFKeyboardTextEditor(text: $note, placeholder: "Заметка…")
                    .frame(height: 140)
                    .padding(.horizontal, TFSpacing.sm)
                    .background(Color.tfCard)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg, style: .continuous))
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .padding(.top, TFSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.tfBackground.ignoresSafeArea())
    }
}

#Preview("Клавиатура — демо") {
    TFKeyboardDemoScreen()
}
