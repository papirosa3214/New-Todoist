import SwiftUI

// Пустое состояние — теперь обёртка над штатным
// `ContentUnavailableView` (iOS 17+). Старый кастом был скопией того,
// что iOS делает сам; обёртка оставлена, потому что в проекте 9 мест
// вызова, и общий API (`icon`/`text`/`action`) привычнее, чем разные
// формы `ContentUnavailableView`. Внутри — один кастомный конструктор,
// оборачивающий штатный.
public struct TFEmptyState: View {
    let icon: String?
    let text: String
    let actionTitle: String?
    let action: (() -> Void)?

    public init(icon: String? = nil, text: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.icon = icon
        self.text = text
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        let img = icon ?? "tray"
        if let actionTitle, let action {
            ContentUnavailableView {
                Label(text, systemImage: img)
            } description: {
                EmptyView()
            } actions: {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .tint(.tfRed)
            }
        } else if icon != nil {
            ContentUnavailableView(text, systemImage: img)
        } else {
            ContentUnavailableView(text, systemImage: "tray")
        }
    }
}

#Preview("Пустое состояние") {
    VStack(spacing: TFSpacing.xl) {
        TFEmptyState(icon: "magnifyingglass", text: "Начните вводить, чтобы найти задачи, проекты и метки")
        TFEmptyState(text: "Под выбранные фильтры ничего не подошло", actionTitle: "Сбросить фильтры") {}
    }
    .padding(.top, 60)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.tfBackground)
}
