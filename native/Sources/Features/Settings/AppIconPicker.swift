import SwiftUI
import UIKit

/// Выбор значка приложения — штатные Alternate App Icons iOS.
///
/// Владелец 01.09.2026: «у нас есть просто в настройках иконка, неужели нельзя
/// сделать, чтобы через настройки её воткнуть, и она бы поменялась». Раньше
/// строка была справочной: показывала имя и ничего не делала.
enum AppIconOption: String, CaseIterable, Identifiable {
    /// Основной значок объявлен в проекте как `AppIcon`; у альтернативных —
    /// имена наборов из ассетов.
    case glass
    case classic
    case dark

    var id: String { rawValue }

    /// nil — вернуть основной значок (этого требует `setAlternateIconName`).
    var alternateName: String? {
        switch self {
        case .glass: nil
        case .classic: "AppIconClassic"
        case .dark: "AppIconDark"
        }
    }

    var title: String {
        switch self {
        case .glass: "Pure Minimal Glass"
        case .classic: "Классика"
        case .dark: "Тёмная"
        }
    }

    /// Файл превью в ассетах: показать сам значок приложения система не даёт,
    /// поэтому в списке рисуется одноимённая картинка.
    var previewAsset: String {
        switch self {
        case .glass: "AppIconPreviewGlass"
        case .classic: "AppIconPreviewClassic"
        case .dark: "AppIconPreviewDark"
        }
    }

    static var current: AppIconOption {
        let name = UIApplication.shared.alternateIconName
        return AppIconOption.allCases.first { $0.alternateName == name } ?? .glass
    }
}

struct AppIconPickerSheet: View {
    @Binding var selection: AppIconOption
    let onClose: () -> Void
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Значок приложения").tfText(.title).foregroundStyle(Color.tfText)
                Spacer()
                Button("Готово", action: onClose)
                    .tfText(.action)
                    .foregroundStyle(Color.tfRed)
            }
            .padding(.horizontal, TFSpacing.lg)
            .padding(.bottom, TFSpacing.md)

            ForEach(AppIconOption.allCases) { option in
                Button {
                    apply(option)
                } label: {
                    HStack(spacing: TFSpacing.md) {
                        Image(option.previewAsset)
                            .resizable()
                            .frame(width: 52, height: 52)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        Text(option.title)
                            .tfText(.body)
                            .foregroundStyle(Color.tfText)
                        Spacer()
                        if option == selection {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.tfRed)
                        }
                    }
                    .padding(.horizontal, TFSpacing.lg)
                    .padding(.vertical, TFSpacing.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings.app-icon.\(option.rawValue)")
            }

            if let errorMessage {
                Text(errorMessage)
                    .tfText(.caption)
                    .foregroundStyle(Color.tfRed)
                    .padding(.horizontal, TFSpacing.lg)
                    .padding(.top, TFSpacing.sm)
            }
        }
        .padding(.vertical, TFSpacing.lg)
    }

    private func apply(_ option: AppIconOption) {
        guard UIApplication.shared.supportsAlternateIcons else {
            errorMessage = "Система не разрешает менять значок на этом устройстве"
            return
        }
        UIApplication.shared.setAlternateIconName(option.alternateName) { error in
            Task { @MainActor in
                if let error {
                    errorMessage = error.localizedDescription
                } else {
                    errorMessage = nil
                    selection = option
                }
            }
        }
    }
}
