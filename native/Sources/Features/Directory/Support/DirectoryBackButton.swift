import SwiftUI

// Стрелка «назад» для compact-шапок раздела «Справочники» — нужна и
// Активности, и Уведомлениям (оба — drill-down экраны, не корневые вкладки).
// `TFScreenHeader` (DesignSystem, чужой файл) сама её не рисует ни у одного
// варианта — тот же гэп, что `SettingsHeaderChrome.swift` уже отметил для
// `.large` (см. его комментарий); здесь та же заплатка для `.compact` и
// для полностью кастомной шапки Уведомлений (там ещё нужна ТЕКСТОВАЯ кнопка
// «Прочитать все» справа, а `TFHeaderAction` — только иконки).
// `@Environment(\.dismiss)` годится, потому что оба экрана реально запушены
// в `NavigationStack` через `routeDestination`/`AppRoute`, не корневые табы.
struct DirectoryBackButton: View {
    /// Своё действие вместо `dismiss()` — для чата: он корневая вкладка,
    /// закрывать в стеке нечего, надо вернуться на прежнюю вкладку.
    var action: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Button(action: { if let action { action() } else { dismiss() } }) {
            Image(systemName: "chevron.left")
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(Color.tfText)
                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                .contentShape(Rectangle())
        }
        .buttonStyle(TFTapScaleStyle())
        .padding(.leading, -TFSpacing.sm) // выравнивает край иконки с текстом, а не с тап-зоной (как SettingsHeaderChrome)
    }
}
