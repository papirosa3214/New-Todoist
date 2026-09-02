import SwiftUI

// `Loading`/`ErrorBanner` — spec/SCREENS-1.md §3.2, SCREENS-2.md §0.2-0.3.
// Текст фиксирован дословно, варианты различаются только версткой, не текстом.
public struct TFLoading: View {
    public enum Variant { case inline, block }
    let variant: Variant

    public init(_ variant: Variant = .inline) { self.variant = variant }

    public var body: some View {
        let text = Text("Загрузка…")
            .tfText(.action)
            .foregroundStyle(Color.tfSub)

        switch variant {
        case .inline:
            text
        case .block:
            // Штатный ProgressView в центре плюс текст «Загрузка…».
            VStack(spacing: TFSpacing.sm) {
                ProgressView()
                    .controlSize(.large)
                text
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TFSpacing.xl)
        }
    }
}

/// Ошибка — inline: маленький коралловый текст. block: тонированная панель с иконкой info.
/// Пустое сообщение — компонент ничего не рисует (можно монтировать безусловно).
public struct TFErrorBanner: View {
    public enum Variant { case inline, block }
    let variant: Variant
    let message: String?

    public init(_ message: String?, variant: Variant = .inline) {
        self.message = message
        self.variant = variant
    }

    public var body: some View {
        if let message, !message.isEmpty {
            switch variant {
            case .inline:
                Text(message)
                    .tfText(.action)
                    .foregroundStyle(Color.tfCoral)
            case .block:
                HStack(spacing: TFSpacing.sm) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(Color.tfCoral)
                    Text(message)
                        .tfText(.action)
                        .foregroundStyle(Color.tfCoral)
                }
                .padding(TFSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.tfCoral.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }
        }
    }
}

#Preview("Загрузка и ошибка") {
    VStack(alignment: .leading, spacing: TFSpacing.lg) {
        TFLoading(.inline)
        TFLoading(.block)
        TFErrorBanner("Не удалось загрузить задачи", variant: .inline)
        TFErrorBanner("Не удалось загрузить задачи", variant: .block)
        TFErrorBanner(nil) // пусто — ничего не рисуется
    }
    .padding()
    .background(Color.tfBackground)
}
