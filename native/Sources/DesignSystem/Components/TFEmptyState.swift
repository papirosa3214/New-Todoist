import SwiftUI

// Пустое состояние — числами спека не покрывает отдельно, снято с
// компоновки в скриншотах (`search.png`: крупная иконка `sub`, подпись
// `body`/`sub` под ней по центру; `today.png`: пустое состояние-ссылка
// «Сбросить фильтры» текстом акцента без иконки). Даём оба варианта одним
// компонентом — иконка опциональна.
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
        VStack(spacing: TFSpacing.md) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 36))
                    .foregroundStyle(Color.tfSub)
            }
            Text(text)
                .tfText(.body)
                .foregroundStyle(Color.tfSub)
                .multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .tfText(.body)
                        .foregroundStyle(Color.tfRed)
                }
                .buttonStyle(TFTapFadeStyle())
            }
        }
        .padding(.horizontal, TFSpacing.xl)
        .frame(maxWidth: .infinity)
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
