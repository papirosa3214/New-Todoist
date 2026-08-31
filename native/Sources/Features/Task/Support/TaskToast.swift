import SwiftUI

// Тост — spec/SCREENS-1.md §5.4 использует его дважды («Задача выведена в
// Dynamic Island», «Задача сохранена в шаблоны»). В `DesignSystem` готового
// компонента пока нет (Волна 1 его не заводила) — свой, локальный для
// экранов задачи; кандидат на переезд в DesignSystem, если тост понадобится
// другим экранам (сказано в отчёте).
struct TaskToastMessage: Equatable {
    let text: String
    let isError: Bool

    init(_ text: String, isError: Bool = false) {
        self.text = text
        self.isError = isError
    }
}

/// Показывает всплывающую плашку поверх контента на 2.4с и прячет сама.
struct TaskToastModifier: ViewModifier {
    @Binding var message: TaskToastMessage?

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let message {
                Text(message.text)
                    .tfText(.action)
                    .foregroundStyle(Color.tfText)
                    .padding(.horizontal, TFSpacing.lg)
                    .padding(.vertical, TFSpacing.md)
                    .background(message.isError ? Color.tfCoral.opacity(0.92) : Color.tfCard2.opacity(0.96))
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
                    .tfShadow(TFShadow.dropdown)
                    .padding(.top, TFSpacing.xl)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: message) {
                        try? await Task.sleep(nanoseconds: 2_400_000_000)
                        if self.message == message { self.message = nil }
                    }
            }
        }
        .animation(.easeOut(duration: TFDuration.base), value: message)
    }
}

extension View {
    func taskToast(_ message: Binding<TaskToastMessage?>) -> some View {
        modifier(TaskToastModifier(message: message))
    }
}
