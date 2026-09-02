import SwiftUI

// Нижняя шторка — spec/DESIGN-TOKENS.md §4 «Нижняя шторка». Реализована как
// `View`-модификатор поверх `.sheet`, чтобы экраны волны 2 подключали её одной
// строкой (`.tfBottomSheet(isPresented:) { ... }`), не пересобирая вёрстку сами.
//
// На native `.presentationDetents`/`.presentationCornerRadius` уже дают часть
// эффекта нативно (скрим, драг вниз для закрытия) — здесь докручиваем то, что
// спека требует явно: верхние углы 20px, хендл 36×4, шапка с крестиком слева.
public struct TFBottomSheetContent<Content: View>: View {
    let title: String?
    let actionTitle: String?
    let action: (() -> Void)?
    let onClose: () -> Void
    let content: Content

    public init(
        title: String? = nil,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil,
        onClose: @escaping () -> Void,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.actionTitle = actionTitle
        self.action = action
        self.onClose = onClose
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Хендл — и визуальная подсказка, и точка захвата для смахивания вниз.
            Capsule()
                .fill(Color.tfStroke)
                .frame(width: TFSheet.handleWidth, height: TFSheet.handleHeight)
                .padding(.top, TFSpacing.sm)
                .padding(.bottom, TFSpacing.xs)

            if title != nil || actionTitle != nil {
                HStack {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: TFIconSize.sm))
                            .foregroundStyle(Color.tfText)
                            .frame(width: TFSheet.headerCloseSize, height: TFSheet.headerCloseSize)
                    }
                    Spacer()
                    if let title {
                        Text(title).tfText(.title).foregroundStyle(Color.tfText)
                    }
                    Spacer()
                    if let actionTitle, let action {
                        Button(action: action) {
                            Text(actionTitle).tfText(.action).foregroundStyle(Color.tfSub)
                        }
                    } else {
                        Color.clear.frame(width: TFSheet.headerCloseSize)
                    }
                }
                .padding(.horizontal, TFSpacing.sm)
            }

            content
                .padding(.horizontal, TFSpacing.screenHorizontal)
        }
        .frame(maxWidth: .infinity)
        .background(Color.tfCard)
        .clipShape(.rect(topLeadingRadius: TFRadius.sheet, topTrailingRadius: TFRadius.sheet))
        .frame(maxWidth: TFSheet.maxWidthWide) // ≥1024px десктоп — не растягивается на всё окно; на телефоне уже уже экрана, эффекта нет
    }
}

public extension View {
    /// Подключает нижнюю шторку. Скрим — сплошной чёрный без блюра (спека), поэтому
    /// `.presentationBackground` на самой карточке, а не системный материал.
    func tfBottomSheet<SheetContent: View>(
        isPresented: Binding<Bool>,
        title: String? = nil,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> SheetContent
    ) -> some View {
        self.sheet(isPresented: isPresented) {
            TFBottomSheetContent(title: title, actionTitle: actionTitle, action: action, onClose: {
                isPresented.wrappedValue = false
            }, content: content)
            .presentationDragIndicator(.hidden) // свой хендл вместо системного
            .presentationCornerRadius(TFRadius.sheet)
            .presentationBackground(Color.tfCard)
        }
    }
}

#Preview("Нижняя шторка") {
    TFBottomSheetContent(title: "Удалить задачу?", onClose: {}) {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            Text("«Старт нового проекта» будет удалена безвозвратно")
                .tfText(.body)
                .foregroundStyle(Color.tfSub)
            TFButton("Удалить", variant: .primary) {}
            TFButton("Отмена", variant: .secondary) {}
        }
        .padding(.bottom, TFSpacing.xl)
    }
    .background(Color.tfBackground)
}
