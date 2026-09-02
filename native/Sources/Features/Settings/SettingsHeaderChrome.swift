import SwiftUI

// Шапка настроек приведена к эталону «Уведомлений» (владелец 01.09.2026:
// «возьми за референс уведомления — где заголовок и где стрелка назад, и так
// по всем экранам»): стрелка слева, заголовок по центру, высота 48, фон
// FrostedGlass с заходом под статус-бар.
//
// Стрелка теперь СВОЯ, а не системная: системный навбар на всех экранах скрыт
// (`.toolbar(.hidden, for: .navigationBar)`) — иначе он рисовал вторую кнопку
// «назад» в кругляшке прямо поверх нашей.
struct SettingsHeaderChrome: View {
    let title: String

    var body: some View {
        ZStack {
            HStack {
                DirectoryBackButton()
                Spacer()
            }
            Text(title)
                .tfText(.title)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
                .allowsHitTesting(false)
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(height: 48)
        // Штатный фон навбара — вызывающий код добавляет
        // .toolbarBackground(.ultraThinMaterial, for: .navigationBar) +
        // .toolbarBackgroundVisibility(.automatic, for: .navigationBar).
        // (FrostedGlass удалён — см. коммит 9 в native-app.)
        // safeAreaInset, не навбар — явный `.background(.ultraThinMaterial)`,
        // полупрозрачный blur (frosted glass, как в вебе). Иначе шапка
        // сольётся с tfBackground экрана (Claude_Bot приёмка 02.09.2026).
        .background(.ultraThinMaterial)
    }
}
