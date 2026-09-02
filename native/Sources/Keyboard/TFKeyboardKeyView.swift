import SwiftUI

// Одна клавиша. Иконки служебных клавиш — SF Symbols вместо встроенных SVG
// веба (спека §1.1: «идею — иконка = маска, не наложенный слой — переносить,
// конкретные SVG-пути не обязательны, в SwiftUI есть готовые системные
// символы shift/delete.left/return»). Реальное имя символа возврата каретки —
// `arrow.turn.down.left` (символа с буквальным именем «return» в SF Symbols
// нет). Для микрофона спека прямо разрешает готовый символ вместо контура —
// взят `mic.fill`.
struct TFKeyboardKeyView: View {
    let key: TFKey
    /// nil = гибкая ширина (flex: 1 1 0 в вебе), заполняет ряд поровну с
    /// соседями. Не-nil — фиксированная (ряд 4: {numbers}/{abc}/{mic}/{enter}).
    let fixedWidth: CGFloat?
    let onAction: (TFKeyAction) -> Void

    @State private var isPressed = false
    @State private var longPressConsumed = false
    @State private var longPressTimer: Timer?
    @State private var repeatTimer: Timer?
    /// Заглушка микрофона: 1.2с иконка меняется на mic.slash + тревожный цвет —
    /// понятный отклик на тап без реальной записи (речь НЕ подключаем, ТЗ).
    @State private var micStubActive = false

    private let longPressThreshold: TimeInterval = 0.45
    private let backspaceRepeatDelay: TimeInterval = 0.45
    private let backspaceRepeatInterval: TimeInterval = 0.09

    var body: some View {
        content
            .background(
                RoundedRectangle(cornerRadius: TFKeyboardMetrics.keyRadius, style: .continuous)
                    .fill(isPressed ? TFKeyboardPalette.keyPressed : TFKeyboardPalette.key)
            )
            .overlay(alignment: .trailing) {
                // Пробел на системной клавиатуре без надписи — только мелкая
                // пометка языка у правого края (спека §1.1). «ру»/«en» —
                // текущий язык (spec §1.6 говорил, что языка тут нет вовсе;
                // задача добавляет — метка обязана отражать реальный, а не
                // быть статичной «ру», как было бы, если бы латиницы не было).
                if let mark = key.overlayMark {
                    Text(mark)
                        .tfText(.action)
                        .foregroundStyle(TFKeyboardPalette.spaceLanguageLabel)
                        .padding(.trailing, 10)
                }
            }
            .animation(.easeOut(duration: 0.08), value: isPressed)
            .contentShape(Rectangle())
            .gesture(pressGesture)
            .onDisappear { endPressTimers() }
    }

    @ViewBuilder
    private var content: some View {
        let inner = keyContent
            .frame(maxWidth: fixedWidth == nil ? .infinity : nil)
            .frame(width: fixedWidth, height: TFKeyboardMetrics.keyHeight)
        inner
    }

    @ViewBuilder
    private var keyContent: some View {
        switch key.action {
        case .shift:
            // normal/active/locked — без этого включённый Caps ничем не
            // отличался бы от обычного состояния и проверить его на экране
            // было бы нельзя (спека молчит про эту клавишу вовсе — Caps в
            // вебе не было, см. TFKeyboardLayout.swift).
            Image(systemName: shiftIconName)
                .resizable().scaledToFit()
                .frame(width: TFKeyboardMetrics.shiftIconSize, height: TFKeyboardMetrics.shiftIconSize)
                .foregroundStyle(TFKeyboardPalette.keyText)
        case .globe:
            // Клавиша переключения языка — в спеке её нет вовсе (языка/
            // переключения там не было), размер иконки взят по аналогии с
            // enter (число не с замера).
            Image(systemName: "globe")
                .resizable().scaledToFit()
                .frame(width: TFKeyboardMetrics.enterIconSize, height: TFKeyboardMetrics.enterIconSize)
                .foregroundStyle(TFKeyboardPalette.keyText)
        case .capsLock:
            // Не рендерится как отдельная клавиша НИКОГДА — это только payload
            // долгого нажатия Shift (см. TFKeyboardLayout.lettersRows). Ветка
            // нужна лишь для исчерпывающего switch по TFKeyAction.
            EmptyView()
        case .backspace:
            Image(systemName: "delete.left")
                .resizable().scaledToFit()
                .frame(width: TFKeyboardMetrics.backspaceIconSize.width, height: TFKeyboardMetrics.backspaceIconSize.height)
                .foregroundStyle(TFKeyboardPalette.keyText)
        case .enter:
            Image(systemName: "arrow.turn.down.left")
                .resizable().scaledToFit()
                .frame(width: TFKeyboardMetrics.enterIconSize, height: TFKeyboardMetrics.enterIconSize)
                .foregroundStyle(TFKeyboardPalette.keyText)
        case .mic:
            Image(systemName: micStubActive ? "mic.slash.fill" : "mic.fill")
                .resizable().scaledToFit()
                .frame(width: TFKeyboardMetrics.micIconSize, height: TFKeyboardMetrics.micIconSize)
                .foregroundStyle(micStubActive ? TFKeyboardPalette.micStubAccent : TFKeyboardPalette.keyText)
        case .space:
            Color.clear
        default:
            Text(key.label)
                .font(.system(size: fontSize, weight: .regular))
                .foregroundStyle(TFKeyboardPalette.keyText)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }

    private var shiftIconName: String {
        switch key.visualState {
        case .normal: "shift"
        case .active: "shift.fill"
        case .locked: "capslock.fill"
        }
    }

    /// {numbers}/{abc} — служебный текстовый кегль 17px, все остальные подписи
    /// (буквы, цифры, знаки в числовой раскладке) — 22px (спека §1.1: класс
    /// kb-key-util отдельным правилом задан только этим двум клавишам).
    private var fontSize: CGFloat {
        switch key.action {
        case .numbers, .abc: TFKeyboardMetrics.utilKeyFontSize
        default: TFKeyboardMetrics.letterKeyFontSize
        }
    }

    // MARK: - Жест

    private var pressGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in
                guard !isPressed else { return }
                isPressed = true
                longPressConsumed = false
                beginPressTimers()
            }
            .onEnded { _ in
                endPressTimers()
                isPressed = false
                if !longPressConsumed {
                    fireTap()
                }
            }
    }

    private func fireTap() {
        onAction(key.action)
        if key.action == .mic {
            micStubActive = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { micStubActive = false }
        }
    }

    private func beginPressTimers() {
        // Backspace: первое удаление СРАЗУ на нажатие (как обычный тап), затем,
        // если палец не отпустили, повтор с задержкой — требование задачи
        // «backspace с повтором при удержании», в спеке веба этого нет вовсе
        // (там простой value.slice(0,-1) без hold-репита), это нативное добавление.
        if key.action == .backspace {
            onAction(.backspace)
            longPressConsumed = true // тап на onEnded не должен удалить символ ещё раз
            repeatTimer = Timer.scheduledTimer(withTimeInterval: backspaceRepeatDelay, repeats: false) { _ in
                repeatTimer = Timer.scheduledTimer(withTimeInterval: backspaceRepeatInterval, repeats: true) { _ in
                    onAction(.backspace)
                }
            }
            return
        }
        // Долгое нажатие («ь» → «ъ»).
        if let longPress = key.longPress {
            longPressTimer = Timer.scheduledTimer(withTimeInterval: longPressThreshold, repeats: false) { _ in
                longPressConsumed = true
                onAction(longPress)
            }
        }
    }

    private func endPressTimers() {
        longPressTimer?.invalidate()
        longPressTimer = nil
        repeatTimer?.invalidate()
        repeatTimer = nil
    }
}
