import SwiftUI
import UIKit

// Многострочный аналог TFKeyboardTextField — на UITextView (UITextField
// однострочный по природе UIKit). {enter} здесь вставляет перевод строки, а
// не отправляет форму — ровно поведение `multiline` из веб-версии (спека
// §1.3). UITextView не умеет placeholder сам — добавлена служебная UILabel
// поверх, стандартный приём.
public struct TFKeyboardTextEditor: UIViewRepresentable {
    @Binding private var text: String
    private let placeholder: String

    public init(text: Binding<String>, placeholder: String = "") {
        self._text = text
        self.placeholder = placeholder
    }

    public func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.text = text
        view.font = .systemFont(ofSize: 16)
        view.textColor = .white
        view.backgroundColor = .clear
        view.tintColor = UIColor(Color.tfRed)
        view.textContainerInset = UIEdgeInsets(top: 8, left: 4, bottom: 8, right: 4)
        view.delegate = context.coordinator

        let placeholderLabel = UILabel()
        placeholderLabel.text = placeholder
        placeholderLabel.font = view.font
        placeholderLabel.textColor = UIColor.white.withAlphaComponent(0.35)
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        placeholderLabel.isHidden = !text.isEmpty
        view.addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            placeholderLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 9),
        ])
        context.coordinator.placeholderLabel = placeholderLabel

        view.inputView = TFKeyboardInputView(
            target: { [weak view] in view },
            isMultiline: true,
            onEnter: nil,
            onClose: { [weak view] in view?.resignFirstResponder() }
        )
        return view
    }

    public func updateUIView(_ uiView: UITextView, context: Context) {
        if uiView.text != text { uiView.text = text }
        context.coordinator.placeholderLabel?.isHidden = !text.isEmpty
    }

    public func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    public final class Coordinator: NSObject, UITextViewDelegate {
        private let text: Binding<String>
        weak var placeholderLabel: UILabel?
        init(text: Binding<String>) { self.text = text }

        public func textViewDidChange(_ textView: UITextView) {
            text.wrappedValue = textView.text
            placeholderLabel?.isHidden = !textView.text.isEmpty
        }
    }
}
