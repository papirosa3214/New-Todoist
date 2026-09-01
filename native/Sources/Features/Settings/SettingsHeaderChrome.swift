import SwiftUI

// Шапка вида `.large` ТОЛЬКО с заголовком — стрелку «назад» рисует
// NavigationStack сам, отдельная кнопка поверх неё была дублем
// (ревьюер 01.09.2026: «две кнопки «назад» одна над другой — оставить
// одну, системную»). Эта шапка была workaround-ом против гэпа
// `TFScreenHeader.large` (DesignSystem, чужой файл) — тот не принимает
// `leading`. Сейчас leading не нужен, но `.large`-типографика всё ещё
// нужна (Интеграции/Шаблоны используют `.compact` со своим `leading`,
// а здесь — крупная левая). Оставляем собственную композицию, чтобы
// не патчить общий файл (правило ARCHITECTURE.md).
struct SettingsHeaderChrome: View {
    let title: String

    var body: some View {
        HStack(spacing: TFSpacing.sm) {
            Text(title)
                .tfText(.titleLarge)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(height: 56)
        .background(FrostedGlass(axis: .top))
    }
}
