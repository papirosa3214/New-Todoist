import SwiftUI

// `ProjectTasksScreen`/`LabelTasksScreen` рисуют перед заголовком цветной
// значок (кружок цвета проекта / иконка тега цвета метки, `ScreenHeader`
// в вебе получает JSX-узел, а не строку) — `TFScreenHeader` (DesignSystem,
// чужой файл) принимает только `String title`, добавить туда слот я не могу.
// Свой локальный дубль geometрии `.compact`-варианта (высота 48, паддинг
// экрана, `.ultraThinMaterial`) — тот же приём дублирования, что у всего
// раздела Directory/Support, плюс слот `accessory` перед текстом.
// В отчёте — оркестратору: возможно, стоит завести такой слот и в самом
// `TFScreenHeader`, чтобы не плодить вторую шапку.
//
// Кнопка «назад» — `DirectoryBackButton()` (сосед по этой же папке,
// `NotificationsScreen.swift`/`ActivityScreen.swift` уже используют её как
// канонический ответ на то, что `TFScreenHeader` стрелку сама не рисует).
struct DirectoryCompactHeader: View {
    let title: String
    var actions: [TFHeaderAction] = []
    var accessory: (() -> AnyView)?

    var body: some View {
        ZStack {
            HStack {
                DirectoryBackButton()
                Spacer()
                if !actions.isEmpty {
                    HStack(spacing: TFSpacing.headerActionsGap) {
                        ForEach(actions) { action in
                            TFIconButton(action.icon, size: 18, action: action.handler)
                        }
                    }
                }
            }
            HStack(spacing: 6) {
                accessory?()
                Text(title)
                    .tfText(.title)
                    .foregroundStyle(Color.tfText)
                    .lineLimit(1)
            }
            .allowsHitTesting(false)
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(height: 48)
        .background(FrostedGlass(axis: .bottom))
    }
}
