import SwiftUI

// Шапка вида `.large` СО стрелкой «назад» — нужна ровно двум экранам этой
// папки (Настройки, Искусственный интеллект), сверено с живым веб-кодом
// `src/components/UI.tsx` (`ScreenHeader`, 27.08.2026: «шапка решает сама:
// экран не корневая вкладка и своего leading не передал — рисуем стрелку»,
// правило действует для ОБОИХ вариантов, large и compact) и с реальными
// скриншотами `settings.png`/`settings-voice-models.png` — там стрелка есть
// при крупном левом заголовке.
//
// `TFScreenHeader` (DesignSystem, чужой файл) сейчас рисует `leading` ТОЛЬКО
// у `.compact` — у `.large` параметр `leading` тихо игнорируется (см. код
// компонента). Двум экранам этой папки специально ПО СПЕКЕ нужна именно
// крупная левая типографика (не центрированная `.compact`, как у
// Интеграций/Шаблонов — там `TFScreenHeader(.compact, leading:)` подходит
// как есть). Не патчим чужой файл (правило ARCHITECTURE.md — общие файлы
// правит каркасный исполнитель), а собираем то же самое здесь, из тех же
// токенов, что использует сам `TFScreenHeader.large`. Отмечено в отчёте как
// гэп для владельца DesignSystem — стоит перенести туда.
struct SettingsHeaderChrome: View {
    let title: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        HStack(spacing: TFSpacing.sm) {
            Button(action: { dismiss() }) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 22, weight: .regular))
                    .foregroundStyle(Color.tfText)
                    .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                    .contentShape(Rectangle())
            }
            .buttonStyle(TFTapScaleStyle())
            .padding(.leading, -TFSpacing.sm) // визуально выравнивает край иконки с текстом, а не с тап-зоной

            Text(title)
                .tfText(.titleLarge)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(height: 56)
        .background(.ultraThinMaterial)
    }
}
