import SwiftUI

/// Капс-заголовок секции (`APPLE ЭКОСИСТЕМА (IOS)` на `settings-integrations.png`,
/// `SectionTitle`/`.uppercase.tracking-wider` в `TemplatesScreen.tsx`/
/// `IntegrationsScreen.tsx`/`VoiceModelsScreen.tsx`).
///
/// Свой компонент, а не переиспользование `DesignSystem.TFSectionHeader`:
/// тот не задаёт ни `uppercase`, ни `font-semibold` (см. его код,
/// `Components/TFCard.swift`) — на `settings.png` (шапка «Пользовательские
/// настройки» соседа) это расхождение незаметно на глаз (короткая подпись
/// смешанного регистра сама выглядит нейтрально), но здесь спека и
/// скриншоты однозначно требуют капс+полужирный, поэтому свой хелпер вместо
/// подгонки чужого компонента. Гэп `TFSectionHeader` — в отчёте.
struct SettingsCapsLabel: View {
    let title: String
    let trailing: (() -> AnyView)?

    init(_ title: String, trailing: (() -> AnyView)? = nil) {
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack {
            Text(title.uppercased())
                .tfText(.action)
                .fontWeight(.semibold)
                .foregroundStyle(Color.tfSub)
            Spacer()
            trailing?()
        }
    }
}
