import SwiftUI
import UIKit

// UIView, назначаемая в `.inputView` текстового поля — то, ради чего вся
// клавиатура затевалась (ARCHITECTURE.md: «в нативе это штатный механизм
// inputView»). Просто присвоение этой вьюхи текстовому полю ЗАМЕНЯЕТ
// системную клавиатуру нашей — никакого DOM-перехвата/MutationObserver из
// веба здесь не нужно вовсе (спека §1.4).
//
// Стиль `.default`, не `.keyboard`: `.keyboard` даёт системный блюр/адаптивный
// фон, который перебивал бы наш фиксированный #171717 (спека НЕ измеряла
// светлую тему, см. TFKeyboardPalette) — со своим фоном полный контроль нужнее
// системного вида.
final class TFKeyboardInputView: UIInputView {
    private let hostingController: UIHostingController<TFKeyboardView>

    init(
        target: @escaping () -> UIKeyInput?,
        isMultiline: Bool,
        onEnter: (() -> Void)?,
        onClose: (() -> Void)?
    ) {
        hostingController = UIHostingController(
            rootView: TFKeyboardView(target: target, isMultiline: isMultiline, onEnter: onEnter, onClose: onClose)
        )
        super.init(frame: .zero, inputViewStyle: .default)

        backgroundColor = .clear
        hostingController.view.backgroundColor = .clear
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hostingController.view)
        NSLayoutConstraint.activate([
            hostingController.view.leadingAnchor.constraint(equalTo: leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: trailingAnchor),
            hostingController.view.topAnchor.constraint(equalTo: topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        // Высота панели = contentHeightBase (229) + реальный safe-area-inset-bottom
        // текущего окна — эквивалент веб-версии `calc(8px + env(safe-area-inset-bottom))`
        // (спека §1.1). Поле фокусируется по тапу пользователя, окно уже на экране,
        // поэтому берём фактический инсет активного окна, а не догадываемся числом.
        translatesAutoresizingMaskIntoConstraints = false
        let bottomSafeArea = Self.activeWindowBottomSafeArea()
        heightAnchor.constraint(equalToConstant: TFKeyboardMetrics.contentHeightBase + bottomSafeArea).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("TFKeyboardInputView не поддерживает раскладку из сториборда")
    }

    private static func activeWindowBottomSafeArea() -> CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first?
            .safeAreaInsets.bottom ?? 0
    }
}
