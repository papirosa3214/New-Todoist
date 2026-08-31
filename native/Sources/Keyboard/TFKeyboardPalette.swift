import SwiftUI

// Палитра клавиатуры — ЛОКАЛЬНАЯ, не из DesignSystem/Theme/Color+Palette.swift.
// Причина: числа сняты замером ТОЛЬКО тёмной темы iOS (spec/NATIVE-PARTS.md §1.1,
// исходный скриншот — тёмная тема, русская раскладка), а в DesignSystem сейчас
// только поверхностные токены приложения (bg/card/card2/…), без ключей самой
// клавиатуры (#3C3C3C клавиша / #5A5A5A нажатая) — их там никто не заводил.
// Сейчас это не проблема: project.yml принудительно ставит
// UIUserInterfaceStyle: Dark, светлая тема недостижима на живом приложении.
// Если DesignSystem заведёт свои токены клавиатуры или проект отпустит
// принудительную тёмную тему — стоит свести эти цвета к общим, а не раньше
// (замерять под светлую тему пока нечего — эталонного скриншота нет).
//
// Цвет `panelBackground` численно совпадает с Color.tfBackground (#171717),
// но НЕ используется по имени `tfBackground` намеренно: клавиатура обязана
// остаться фиксированно тёмной, даже если tfBackground когда-то станет
// адаптивным (сейчас он уже dynamic(dark:light:) — см. Color+Palette.swift).
public enum TFKeyboardPalette {
    /// Фон панели клавиатуры. = --color-bg проекта (замер, см. NATIVE-PARTS §1.1).
    public static let panelBackground = Color(hex: "#171717")
    /// Цвет ЛЮБОЙ клавиши — в тёмной теме iOS служебные того же цвета, что буквенные.
    public static let key = Color(hex: "#3C3C3C")
    /// Клавиша при нажатии — подсвечивается, не проваливается (без тени/скейла).
    public static let keyPressed = Color(hex: "#5A5A5A")
    /// Подпись клавиши и иконки.
    public static let keyText = Color.white
    /// Пометка языка на пробеле («ру» у правого края) — rgba(255,255,255,0.45).
    public static let spaceLanguageLabel = Color.white.opacity(0.45)
    /// Тревожный акцент заглушки микрофона — тот же смысл, что coral в общей
    /// палитре (Color.tfCoral), но своим литералом: клавиатура умышленно не
    /// зависит от DesignSystem по причине выше.
    public static let micStubAccent = Color(hex: "#ff6b6b")
}
