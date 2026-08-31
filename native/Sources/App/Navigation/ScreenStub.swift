import SwiftUI

/// Временная заглушка экрана, пока его не написал ответственный исполнитель
/// (правило контракта `spec/INTEGRATION.md`: «пока экран не написан, фабрика
/// возвращает заглушку с именем `…ScreenStub`»). Показывает имя будущей вью
/// и, если есть, параметры маршрута — удобно проверять навигацию до
/// готовности самих экранов.
///
/// НЕ часть `DesignSystem` — это техническая деталь роутинга Волны 1, а не
/// переиспользуемый кирпич для готовых экранов.
struct ScreenStub: View {
    let name: String
    let detail: String?

    init(_ name: String, detail: String? = nil) {
        self.name = name
        self.detail = detail
    }

    var body: some View {
        VStack(spacing: 0) {
            TFScreenHeader(name, variant: .compact)
            Spacer()
            TFEmptyState(icon: "hammer", text: detail ?? "Экран ещё не написан")
            Spacer()
        }
        .background(Color.tfBackground)
    }
}
