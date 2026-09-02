import SwiftUI
import UIKit

// Обёртка «одной строкой» — то, чем другие исполнители пользуются вместо
// системного TextField, когда полю нужна СВОЯ клавиатура:
//
//   TFKeyboardTextField(text: $title, placeholder: "Название задачи")
//
// Внутри — обычный UITextField с `.inputView`, подменённым на TFKeyboardView
// (см. TFKeyboardInputView). Каретка, выделение, автоперенос курсора при
// удалении — всё нативное и бесплатное (спека §1.4), клавиатура лишь шлёт
// insertText/deleteBackward в это же поле через UIKeyInput.
public struct TFKeyboardTextField: UIViewRepresentable {
    @Binding private var text: String
    private let placeholder: String
    private let onSubmit: (() -> Void)?

    public init(text: Binding<String>, placeholder: String = "", onSubmit: (() -> Void)? = nil) {
        self._text = text
        self.placeholder = placeholder
        self.onSubmit = onSubmit
    }

    public func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.text = text
        field.placeholder = placeholder
        // input-ступень шкалы (16px) — единственная, которую спека разрешает
        // ставить на текстовые поля (spec/DESIGN-TOKENS.md §2).
        field.font = .systemFont(ofSize: 16)
        field.textColor = .white
        field.tintColor = UIColor(Color.tfRed)
        field.addTarget(context.coordinator, action: #selector(Coordinator.editingChanged(_:)), for: .editingChanged)

        field.inputView = TFKeyboardInputView(
            target: { [weak field] in field },
            isMultiline: false,
            onEnter: { [weak field] in
                onSubmit?()
                field?.resignFirstResponder()
            },
            onClose: { [weak field] in field?.resignFirstResponder() }
        )
        return field
    }

    public func updateUIView(_ uiView: UITextField, context: Context) {
        if uiView.text != text { uiView.text = text }
    }

    public func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    public final class Coordinator: NSObject {
        private let text: Binding<String>
        init(text: Binding<String>) { self.text = text }

        @objc func editingChanged(_ sender: UITextField) {
            text.wrappedValue = sender.text ?? ""
        }
    }
}
