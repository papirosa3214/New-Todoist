import SwiftUI

// Confirm-диалог — spec/SCREENS-2.md §0.5 (`Dialog`/`useDialog`): свой bottom
// sheet вместо системного confirm, **БЕЗ drag-to-dismiss** (подтверждающая
// шторка не должна закрываться случайным свайпом — отдельное требование от
// обычных шторок). Построен на готовом `TFBottomSheetContent` из
// `DesignSystem` (та же карточка, что использует его собственный превью
// «Удалить задачу?») — здесь только добавлен `.interactiveDismissDisabled()`,
// которого нет у общего модификатора `tfBottomSheet`.
struct TaskConfirmRequest: Identifiable {
    let id = UUID()
    let title: String
    let description: String?
    let confirmLabel: String
    let cancelLabel: String
    let danger: Bool
    let onConfirm: () -> Void

    init(
        title: String, description: String? = nil,
        confirmLabel: String = "Удалить", cancelLabel: String = "Отмена",
        danger: Bool = true, onConfirm: @escaping () -> Void
    ) {
        self.title = title
        self.description = description
        self.confirmLabel = confirmLabel
        self.cancelLabel = cancelLabel
        self.danger = danger
        self.onConfirm = onConfirm
    }
}

private struct TaskConfirmModifier: ViewModifier {
    @Binding var request: TaskConfirmRequest?

    func body(content: Content) -> some View {
        content.sheet(item: $request) { req in
            TFBottomSheetContent(title: req.title, onClose: { request = nil }) {
                VStack(alignment: .leading, spacing: TFSpacing.md) {
                    if let description = req.description {
                        Text(description)
                            .tfText(.body)
                            .foregroundStyle(Color.tfSub)
                    }
                    TFButton(req.confirmLabel, variant: req.danger ? .primary : .secondary) {
                        request = nil
                        req.onConfirm()
                    }
                    TFButton(req.cancelLabel, variant: .outline) { request = nil }
                }
                .padding(.bottom, TFSpacing.xl)
            }
            .presentationDetents([.height(240)])
            .presentationDragIndicator(.hidden)
            .presentationBackground(Color.tfCard)
            .interactiveDismissDisabled() // spec §0.5 — без drag-to-dismiss
        }
    }
}

extension View {
    func taskConfirm(_ request: Binding<TaskConfirmRequest?>) -> some View {
        modifier(TaskConfirmModifier(request: request))
    }
}
