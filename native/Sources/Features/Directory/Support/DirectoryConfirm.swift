import SwiftUI

// Confirm-диалог для раздела «Справочники» — своя копия паттерна
// `Features/Task/Support/TaskConfirm.swift` (чужая папка, не трогаем),
// собрана из тех же кирпичей DesignSystem (`TFBottomSheetContent`).
// spec/SCREENS-2.md §0.5: свой bottom sheet вместо системного confirm,
// БЕЗ drag-to-dismiss.
struct DirectoryConfirmRequest: Identifiable {
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

private struct DirectoryConfirmModifier: ViewModifier {
    @Binding var request: DirectoryConfirmRequest?

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
    func directoryConfirm(_ request: Binding<DirectoryConfirmRequest?>) -> some View {
        modifier(DirectoryConfirmModifier(request: request))
    }
}
