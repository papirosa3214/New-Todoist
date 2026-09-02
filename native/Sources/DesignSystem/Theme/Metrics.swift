import SwiftUI

// Отступы, радиусы, толщины, тени, длительности — spec/DESIGN-TOKENS.md §3, §5.
public enum TFSpacing {
    public static let xs: CGFloat = 4
    public static let sm: CGFloat = 8
    public static let md: CGFloat = 12
    public static let lg: CGFloat = 16
    public static let xl: CGFloat = 24

    /// Горизонтальный отступ экрана — 16px везде, включая шапку (заголовок и контент на одной вертикали).
    public static let screenHorizontal: CGFloat = 16
    /// Отступ между кнопками в шапке.
    public static let headerActionsGap: CGFloat = 8
}

public enum TFRadius {
    /// Плашка задачи в сетке часов.
    public static let sm: CGFloat = 6
    /// Кнопка-иконка, чип тулбара, аватар-фото (НЕ круг), слот «что создать».
    public static let md: CGFloat = 8
    /// Кнопка, поле ввода, строка-карточка, слот аватара в чате.
    public static let lg: CGFloat = 12
    /// Карточка (`FieldGroup`, `CreateMenu`), выпадающее меню.
    public static let xl: CGFloat = 16
    /// Верхние углы нижней шторки.
    public static let sheet: CGFloat = 20
    /// Тумблер, аватар-инициалы, точка-индикатор, круглые кнопки таббара/FAB.
    public static let full: CGFloat = 9999
    /// Пилюля бейджа строки задачи — самый мелкий элемент, отдельно от основной шкалы.
    public static let pill: CGFloat = 4
}

public enum TFBorder {
    /// Граница везде одна: 1px, цвет `tfStroke`.
    public static let width: CGFloat = 1
}

/// Тап-зона — минимум 44×44pt везде, даже если визуальная иконка меньше.
public enum TFHitTarget {
    public static let min: CGFloat = 44
}

/// Шкала длительностей (`index.css --dur-*`) — для нового кода; старые перенесённые
/// анимации (таббар, drag-lift и т.п.) держат собственные измеренные числа отдельно,
/// см. `TFAnimation` ниже — намеренно не сведены к этой шкале (спека §5).
public enum TFDuration {
    public static let instant: Double = 0.08
    public static let fast: Double = 0.15
    public static let base: Double = 0.20
    public static let slow: Double = 0.35
    public static let deliberate: Double = 0.50
}

/// Конкретные измеренные анимации, которые не попадают под общую шкалу `TFDuration` —
/// перенесены как отдельные числа, чтобы не потерять точность при будущей унификации.
public enum TFAnimation {
    /// Смена вкладки/появление шарика таббара.
    public static let tabSwitch: Double = 0.35
    /// Меню создания: opacity + scale(.95→1).
    public static let createMenu: Double = 0.20
    /// Захват при drag: transition тени/scale.
    public static let dragLift: Double = 0.22
    public static let dragLiftSpring = SwiftUI.Animation.timingCurve(0.34, 1.56, 0.64, 1, duration: dragLift)
    /// Долгое нажатие FAB — порог альтернативного действия.
    public static let fabLongPress: Double = 0.50
    /// «Печатает…» — волна гашения точек, период на точку.
    public static let typingDotPeriod: Double = 1.2
    public static let typingDotPhaseShift: Double = 0.2
    /// Микрофон — пульсация записи.
    public static let micPulse: Double = 1.0
}

/// Тени — используются только на «физически висящих над поверхностью» элементах,
/// глубина остального интерфейса передаётся фоном, не тенями (спека §3).
public enum TFShadow {
    public struct Spec {
        public let color: Color
        public let radius: CGFloat
        public let x: CGFloat
        public let y: CGFloat
    }

    /// Кнопка FAB (десктоп-приём, на native пригодится для крупных circular actions).
    public static let fab = Spec(color: Color(hex: "#e44332").opacity(0.45), radius: 16, x: 0, y: 6)
    /// Всплывающий список / унифицированный поповер (`ActionsMenu`, `CreateMenu`).
    public static let popover = Spec(color: .black.opacity(0.35), radius: 30, x: 0, y: 10)
    /// Выпадающее меню (легаси-имя `shadow-dropdown`, отдельное от `popover` числами).
    public static let dropdown = Spec(color: .black.opacity(0.45), radius: 16, x: 0, y: 6)
    /// Бегунок тумблера.
    public static let toggle = Spec(color: .black.opacity(0.3), radius: 3, x: 0, y: 1)
    /// Липкая шапка.
    public static let sticky = Spec(color: .black.opacity(0.55), radius: 16, x: 0, y: 10)
    /// Захваченная при перетаскивании карточка — первый (дальний) слой; второй слой ближе и мягче.
    public static let dragLiftFar = Spec(color: .black.opacity(0.45), radius: 28, x: 0, y: 12)
    public static let dragLiftNear = Spec(color: .black.opacity(0.35), radius: 8, x: 0, y: 2)
}

public extension View {
    func tfShadow(_ spec: TFShadow.Spec) -> some View {
        self.shadow(color: spec.color, radius: spec.radius, x: spec.x, y: spec.y)
    }
}

/// Именные размеры иконок (`ICON_SIZE`, UI.tsx) — вне шкалы используются точечные
/// замеренные числа (например 28px иконка свайп-действия, 12px иконка в бейдже).
public enum TFIconSize {
    public static let xs: CGFloat = 14
    public static let sm: CGFloat = 18
    public static let md: CGFloat = 22
    public static let lg: CGFloat = 26
}

/// Геометрия нижней навигации (`.nt-tabbar-menu` + AnimatedTabBar.tsx) — самая
/// узнаваемая часть интерфейса, числа сняты буквально, ничего не додумано.
/// Горб — убран владельцем 27.08.2026, панель ровная (см. компонент `TFTabBar`
/// в `Navigation/TFTabBar.swift` — имя этого enum'а с суффиксом `Metrics`,
/// чтобы не конфликтовать с ним, как и у `TFButtonMetrics` выше).
public enum TFTabBarMetrics {
    /// Высота панели без safe-area (значение в браузере).
    public static let heightCompact: CGFloat = 52
    /// Общий оптический canvas четырёх вкладок. SF Symbols имеют разные
    /// intrinsic bounds даже при одинаковом pointSize, поэтому один только
    /// `.font(size:)` не делает значки визуально одинаковыми.
    public static let tabIconSize: CGFloat = 32
    /// Размер glyph внутри отдельной центральной кнопки создания.
    public static let iconSize: CGFloat = 28
    /// Круг-«шарик» под активной вкладкой.
    public static let bubbleSize: CGFloat = 44
    public static let bubbleColor = Color.white.opacity(0.1)
    /// Центральная кнопка «Создать».
    public static let createButtonSize: CGFloat = 44
    /// Тап-зона пункта — вертикальный паддинг сверху/снизу (без safe-area слагаемого, оно добавляется отдельно).
    public static let itemVerticalPadding: CGFloat = 12
}

/// Меню «что создать» (`CreateMenu.tsx`) — всплывающая карточка над центральной
/// кнопкой, НЕ боковой веер (FanMenu — легаси, не используется, MOBILE_NAV_STYLE="tabbar").
/// Имя с суффиксом `Metrics` — сам компонент `TFCreateMenu` в `Navigation/TFTabBar.swift`.
public enum TFCreateMenuMetrics {
    public static let width: CGFloat = 232
    public static let itemIconSlot: CGFloat = 32
    public static let itemIconSlotRadius: CGFloat = 12
    public static let itemIconSize: CGFloat = 18
    public static let itemPaddingH: CGFloat = 16
    public static let itemPaddingV: CGFloat = 12
    public static let gapAboveTabBar: CGFloat = 8
}

/// Тумблер (`TaskFilterSheet.tsx`, `SettingsScreen.tsx`) — идентичен во всех местах
/// приложения. Имя `Metrics`, потому что `TFToggle` занят одноимённым View-компонентом
/// (`Components/TFToggle.swift`), как и у `TFButtonMetrics` выше.
public enum TFToggleMetrics {
    public static let trackWidth: CGFloat = 43
    public static let trackHeight: CGFloat = 25
    public static let knobSize: CGFloat = 20
    public static let knobInset: CGFloat = 2.5
}

/// Поля ввода / FieldGroup.
public enum TFField {
    public static let height: CGFloat = 52
    public static let iconTextGap: CGFloat = 12
    public static let cardInsetH: CGFloat = 16
}

/// Строка ввода чата — базовый ритм H=44 у всех элементов на одной линии.
public enum TFChatComposer {
    public static let elementHeight: CGFloat = 44
    public static let iconSize: CGFloat = 32
}

/// Кнопки (`Button`, UI.tsx). Имя `Metrics`, потому что `TFButton` занят
/// одноимённым View-компонентом (`Components/TFButton.swift`).
public enum TFButtonMetrics {
    public static let height: CGFloat = 48
    public static let radius: CGFloat = TFRadius.lg
}

/// Нижняя шторка.
public enum TFSheet {
    public static let handleWidth: CGFloat = 36
    public static let handleHeight: CGFloat = 4
    public static let headerCloseSize: CGFloat = 44
    public static let maxWidthWide: CGFloat = 640 // ≥1024px десктоп — не растягивается на всё окно
}
