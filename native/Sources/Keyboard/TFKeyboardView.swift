import SwiftUI
import UIKit

// Сама клавиатура — SwiftUI-содержимое, которое хостится внутри inputView
// (см. TFKeyboardInputView). Печатает НАПРЯМУЮ в текущий UIKeyInput через
// insertText/deleteBackward — то самое нативное преимущество inputView,
// которого не было в вебе (спека §1.4: «Каретка — нативная, бесплатно»):
// вставка идёт в позицию каретки/выделения, а не только в конец строки, как
// были вынуждены делать на вебе.
struct TFKeyboardView: View {
    /// Текущий получатель ввода — замыкание, а не хранимая ссылка: поле может
    /// быть воссоздано SwiftUI-обёрткой (updateUIView), а клавиатура — нет.
    let target: () -> UIKeyInput?
    /// Многострочное поле: {enter} вставляет "\n". Однострочное — вызывает
    /// onEnter (по умолчанию onClose), см. спека §1.3.
    let isMultiline: Bool
    let onEnter: (() -> Void)?
    let onClose: (() -> Void)?

    @State private var layoutName: TFKeyboardLayoutName = .letters(.russian, .lower)

    private var rows: [[TFKey]] { TFKeyboardLayout.rows(for: layoutName) }

    var body: some View {
        GeometryReader { geo in
            let availableWidth = geo.size.width - TFKeyboardMetrics.paddingLeft - TFKeyboardMetrics.paddingRight
            VStack(spacing: TFKeyboardMetrics.rowGapV) {
                ForEach(rows.indices, id: \.self) { i in
                    TFKeyboardRowView(
                        row: rows[i],
                        plan: widthPlan(rowIndex: i, availableWidth: availableWidth),
                        onAction: handle
                    )
                }
            }
            .padding(.top, TFKeyboardMetrics.paddingTop)
            .padding(.leading, TFKeyboardMetrics.paddingLeft)
            .padding(.trailing, TFKeyboardMetrics.paddingRight)
            .padding(.bottom, TFKeyboardMetrics.paddingBottomBase)
        }
        // maxHeight:.infinity — GeometryReader сам не растягивает контент, а
        // TFKeyboardInputView отдаёт полную высоту ВКЛЮЧАЯ safe-area-inset-bottom;
        // фон ниже обязан закрасить всё, включая зону под home indicator, иначе
        // там будет шов чужого цвета. Ряды при этом стоят у верха (GeometryReader
        // не растягивает свой контент сам, он просто сообщает размер).
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(TFKeyboardPalette.panelBackground)
        .onAppear { TFKeyboardHaptics.shared.prepare() }
    }

    private func handle(_ action: TFKeyAction) {
        // Отклик — на КАЖДОЕ нажатие, включая служебные (спека §1.3).
        TFKeyboardHaptics.shared.tickKey()

        switch action {
        case .character(let symbol):
            target()?.insertText(symbol)
            // Одиночный Shift — назад в нижний регистр после одной буквы (как на
            // iOS, не Caps Lock). Caps держится, пока не нажмут Shift ещё раз —
            // см. case .shift ниже.
            if case .letters(let lang, .shift) = layoutName {
                layoutName = .letters(lang, .lower)
            }

        case .shift:
            if case .letters(let lang, let mode) = layoutName {
                layoutName = .letters(lang, mode == .lower ? .shift : .lower)
            }

        case .capsLock:
            if case .letters(let lang, _) = layoutName {
                layoutName = .letters(lang, .caps)
            }

        case .globe:
            // Переключение языка — сбрасывает регистр в нижний, упрощение
            // сознательное (не хранить отдельно регистр на каждый язык).
            if case .letters(let lang, _) = layoutName {
                layoutName = .letters(lang == .russian ? .latin : .russian, .lower)
            }

        case .numbers:
            if case .letters(let lang, _) = layoutName {
                layoutName = .numbers(lang)
            }

        case .abc:
            if case .numbers(let lang) = layoutName {
                layoutName = .letters(lang, .lower)
            }

        case .backspace:
            target()?.deleteBackward()

        case .space:
            target()?.insertText(" ")

        case .enter:
            if isMultiline {
                target()?.insertText("\n")
            } else {
                (onEnter ?? onClose)?()
            }

        case .mic:
            // Заглушка — визуальный отклик живёт локально в TFKeyboardKeyView
            // (иконка на mic.slash на 1.2с). Распознавание речи НЕ подключено:
            // по ТЗ микрофон в этой волне остаётся кнопкой-обещанием.
            break
        }
    }

    /// Ширина буквенных клавиш рядов 1–3. Для русской/числовой раскладки —
    /// `.flexible` (letterWidth: nil), т.е. СТАРОЕ поведение без изменений:
    /// у русской раскладки в рядах 1–3 везде ровно 11 гибких клавиш (спека
    /// §1.2), поэтому проблемы «разной ширины между рядами» там нет вовсе —
    /// трогать что-то работающее незачем.
    ///
    /// Для латинской (QWERTY 10/9/7+2) эта проблема есть по-настоящему: если
    /// делить свободное место поровну ВНУТРИ каждого ряда независимо (как
    /// работает `.frame(maxWidth: .infinity)` в HStack), буквы 2-го и 3-го
    /// рядов вышли бы ШИРЕ, чем 1-го — на системной клавиатуре ширина буквы
    /// одна и та же во всех рядах, а короткие ряды получают отступы по бокам
    /// (2-й ряд) либо более широкие Shift/Backspace (3-й ряд). Чисел под это
    /// в спеке нет — посчитано геометрически от ширины экрана, не с чьего-то
    /// замера.
    private func widthPlan(rowIndex: Int, availableWidth: CGFloat) -> TFKeyboardRowWidthPlan {
        guard case .letters(.latin, _) = layoutName, rowIndex < 3 else { return .flexible }

        let gap = TFKeyboardMetrics.rowGapH
        let n1: CGFloat = 10 // 1-й ряд QWERTY — самый широкий, от него считается ширина буквы
        let letterWidth = max(0, (availableWidth - (n1 - 1) * gap) / n1)

        switch rowIndex {
        case 1:
            let n2: CGFloat = 9
            let contentWidth = n2 * letterWidth + (n2 - 1) * gap
            let margin = max(0, (availableWidth - contentWidth) / 2)
            return TFKeyboardRowWidthPlan(letterWidth: letterWidth, sideMargin: margin)
        default: // ряд 0 (сам эталон) и ряд 2 (Shift/Backspace добирают остаток сами)
            return TFKeyboardRowWidthPlan(letterWidth: letterWidth, sideMargin: 0)
        }
    }
}

/// Ширина буквенной клавиши в ряду (nil = обычный гибкий флекс, как раньше)
/// и боковой отступ ряда (нужен только 2-му ряду латиницы, чтобы центрировать
/// 9 клавиш фиксированной ширины под 10-клавишным рядом сверху).
struct TFKeyboardRowWidthPlan {
    let letterWidth: CGFloat?
    let sideMargin: CGFloat
    static let flexible = TFKeyboardRowWidthPlan(letterWidth: nil, sideMargin: 0)
}

/// Один ряд клавиш. Ширины row4 — из спеки §1.1 (числа те же, что и раньше):
/// {globe}/{numbers}/{abc}/{mic} узкие фиксированные, {enter} широкая
/// фиксированная, пробел — гибкий остаток. {globe} в спеке не было вовсе
/// (языка/переключения там нет) — добавлена той же узкой шириной, что и
/// соседние служебные клавиши ряда, число не с замера, а по аналогии.
struct TFKeyboardRowView: View {
    let row: [TFKey]
    let plan: TFKeyboardRowWidthPlan
    let onAction: (TFKeyAction) -> Void

    var body: some View {
        HStack(spacing: TFKeyboardMetrics.rowGapH) {
            ForEach(row) { key in
                TFKeyboardKeyView(key: key, fixedWidth: width(for: key), onAction: onAction)
            }
        }
        .padding(.horizontal, plan.sideMargin)
    }

    /// По ДЕЙСТВИЮ клавиши, не по номеру ряда — так же, как в исходном CSS
    /// (`[data-skbtn="{abc}"]` не завязан на ряд). Из-за этого у числовой
    /// раскладки ведущая клавиша {abc} ряда 3 («буквы . , ? ! ' + = ⌫») ТОЖЕ
    /// становится узкой фиксированной, хотя визуально это середина ряда —
    /// проверено по исходнику построчно, это не опечатка, а точное поведение
    /// оригинала.
    private func width(for key: TFKey) -> CGFloat? {
        switch key.action {
        case .globe, .numbers, .abc, .mic: TFKeyboardMetrics.row4NarrowWidth
        case .enter: TFKeyboardMetrics.row4EnterWidth
        case .character: plan.letterWidth
        default: nil // shift/capsLock(не рендерится)/backspace/space — всегда флекс
        }
    }
}
