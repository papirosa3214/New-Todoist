import CoreGraphics

// Геометрия своей клавиатуры — числа 1:1 из spec/NATIVE-PARTS.md §1.1, сверены
// построчно с исходником веба (src/index.css, блок «СВОЯ ЭКРАННАЯ КЛАВИАТУРА»,
// строки ~1341–1560). Расхождений со спекой нет.
//
// Веб замерял всё делением на 3 от скриншота @3x — здесь оставлены те же
// выражения (например 19/3), чтобы связь с исходным замером была видна и не
// потерялась при следующей правке, как того требует комментарий в исходном CSS.
public enum TFKeyboardMetrics {
    /// Высота любой клавиши всех 4 рядов.
    public static let keyHeight: CGFloat = 45
    /// Горизонтальный зазор между клавишами в ряду (`.hg-row { gap: 6px }`).
    public static let rowGapH: CGFloat = 6
    /// Вертикальный зазор между рядами (`.hg-row + .hg-row { margin-top: 11px }`).
    public static let rowGapV: CGFloat = 11
    /// Боковые поля панели — асимметрия намеренная, так на эталонном замере.
    public static let paddingLeft: CGFloat = 20.0 / 3.0   // ≈ 6.67
    public static let paddingRight: CGFloat = 19.0 / 3.0  // ≈ 6.33
    public static let paddingTop: CGFloat = 8
    /// Нижний паддинг БЕЗ safe-area — safe-area-inset-bottom добавляется
    /// отдельно в момент установки клавиатуры (см. TFKeyboardInputView).
    public static let paddingBottomBase: CGFloat = 8
    /// Радиус скругления клавиши.
    public static let keyRadius: CGFloat = 19.0 / 3.0     // ≈ 6.33

    /// Кегль буквенной/цифровой клавиши. Спека прямо предупреждает: подогнано
    /// под Linux-рендер (на .110 нет SF Pro) — на реальном iPhone пересчитать
    /// замером заново, при первой живой проверке на устройстве.
    public static let letterKeyFontSize: CGFloat = 22
    /// Кегль служебной клавиши с текстовой подписью ({numbers}/{abc}).
    public static let utilKeyFontSize: CGFloat = 17

    /// Ряд 4: {numbers}/{abc}/{mic} — фиксированная узкая ширина.
    public static let row4NarrowWidth: CGFloat = 45
    /// Ряд 4: {enter} — фиксированная широкая ширина. Пробел — без числа здесь,
    /// растягивается (flex: 1 1 0), как и буквенные клавиши рядов 1–3.
    public static let row4EnterWidth: CGFloat = 97

    // Размеры масок иконок служебных клавиш (spec §1.1) — на native переносятся
    // как frame для SF Symbol/Image (см. TFKeyboardKeyView).
    public static let shiftIconSize: CGFloat = 19
    public static let backspaceIconSize = CGSize(width: 46.0 / 3.0, height: 38.0 / 3.0)
    public static let enterIconSize: CGFloat = 20
    public static let micIconSize: CGFloat = 23

    /// Полная высота панели БЕЗ safe-area: 4 ряда × 45 + 3 зазора × 11 + паддинги 8/8.
    /// = 180 + 33 + 16 = 229. safe-area-inset-bottom прибавляется отдельно
    /// (TFKeyboardInputView), т.к. известен только в момент установки в окно.
    public static let contentHeightBase: CGFloat =
        keyHeight * 4 + rowGapV * 3 + paddingTop + paddingBottomBase
}
