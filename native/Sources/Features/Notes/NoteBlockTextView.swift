import SwiftUI
import UIKit

// ═══════════ Текстовый движок одного блока ═══════════
//
// Спека (§2.1) просит SwiftUI-эквивалент AttributedString/TextKit-редактора.
// Чистый SwiftUI `TextEditor` не даёт программного доступа к атрибутам
// выделения (нужно для «подсветить активную кнопку тулбара» и «применить
// жирный к выделению») — поэтому здесь `UITextView` через
// `UIViewRepresentable`, ОДИН на блок документа (параграф/заголовок/пункт
// списка/…), а не один на весь документ: так проще сопоставить с плоской
// моделью `[NoteBlock]` соседа и не переизобретать текстовый движок для
// вставки/удаления целых блоков — это делает ViewModel на уровне массива,
// а не курсор внутри одной гигантской строки.

/// Куда поставить курсор при программном фокусе (после Enter/Backspace/⌫).
enum NoteCursorPosition: Equatable {
    case start
    case end
    case offset(Int)
}

/// Точка входа для тулбара/меню «Ещё» — тулбар живёт в соседнем View
/// (шапка экрана), а не внутри блока, поэтому ему нужен объект, которым
/// можно скомандовать «сделай жирным» БЕЗ обхода через `@Binding`
/// (Binding пересобирается на каждый рендер и не годится для императивных
/// вызовов кнопки). Класс переживает пересоздания `NoteBlockTextView`,
/// пока жив сам блок (хранится в `@State` строки — см. `NoteBlockRow`).
@MainActor
final class NoteBlockTextController {
    fileprivate weak var textView: UITextView?
    var blockKind: BlockKind = .paragraph

    /// `false`, если строка блока ещё не успела появиться в дереве SwiftUI
    /// (`textView == nil`) — вызывающий (см. `NoteEditorScreen`) не должен
    /// в этом случае молча считать фокус применённым: старый блок так и
    /// останется первым респондером с ещё НЕ обрезанным текстом (до/после
    /// разбивки), и следующее нажатие клавиши запишет его как есть,
    /// задвоив содержимое между двумя блоками.
    @discardableResult
    func focus(cursorAt position: NoteCursorPosition) -> Bool {
        guard let tv = textView else { return false }
        if !tv.isFirstResponder { tv.becomeFirstResponder() }
        let length = tv.attributedText.length
        switch position {
        case .start: tv.selectedRange = NSRange(location: 0, length: 0)
        case .end: tv.selectedRange = NSRange(location: length, length: 0)
        case .offset(let n): tv.selectedRange = NSRange(location: min(max(n, 0), length), length: 0)
        }
        return true
    }

    var hasSelection: Bool { (textView?.selectedRange.length ?? 0) > 0 }

    func currentRuns() -> [RichRun] {
        guard let tv = textView else { return [] }
        return NoteRichText.runs(from: tv.attributedText)
    }

    /// Текст текущего выделения — читает меню AI («применяется к выделенному
    /// фрагменту», spec §2 «Меню AI»). `textView` намеренно `fileprivate` —
    /// наружу отдаём только готовую строку, не сам `UITextView`.
    func selectedText() -> String? {
        guard let tv = textView, tv.selectedRange.length > 0 else { return nil }
        return (tv.attributedText.string as NSString).substring(with: tv.selectedRange)
    }

    private func runState(at attrs: [NSAttributedString.Key: Any]) -> RichRun {
        RichRun(
            text: "",
            bold: (attrs[NoteMarkKey.bold] as? Bool) ?? false,
            italic: (attrs[NoteMarkKey.italic] as? Bool) ?? false,
            underline: (attrs[NoteMarkKey.underline] as? Bool) ?? false,
            strike: (attrs[NoteMarkKey.strike] as? Bool) ?? false,
            highlight: (attrs[NoteMarkKey.highlight] as? Bool) ?? false,
            code: (attrs[NoteMarkKey.code] as? Bool) ?? false,
            linkHref: attrs[NoteMarkKey.link] as? String
        )
    }

    private func marks(of run: RichRun) -> Set<InlineMark> {
        var s: Set<InlineMark> = []
        if run.bold { s.insert(.bold) }
        if run.italic { s.insert(.italic) }
        if run.underline { s.insert(.underline) }
        if run.strike { s.insert(.strike) }
        if run.highlight { s.insert(.highlight) }
        if run.code { s.insert(.code) }
        if run.linkHref?.isEmpty == false { s.insert(.link) }
        return s
    }

    /// Марки под курсором/на выделении — при выделении активна только
    /// марка, которой отмечен ВЕСЬ диапазон (пересечение), иначе кнопка
    /// тулбара подсветилась бы на смешанном форматировании как включённая.
    var activeMarks: Set<InlineMark> {
        guard let tv = textView else { return [] }
        let range = tv.selectedRange
        if range.length == 0 {
            return marks(of: runState(at: tv.typingAttributes))
        }
        guard let storage = tv.textStorage as NSTextStorage?,
              range.location >= 0, range.location + range.length <= storage.length
        else { return [] }
        var result: Set<InlineMark>?
        storage.enumerateAttributes(in: range, options: []) { attrs, _, _ in
            let m = marks(of: runState(at: attrs))
            result = result.map { $0.intersection(m) } ?? m
        }
        return result ?? []
    }

    var currentLinkHref: String? {
        guard let tv = textView else { return nil }
        let range = tv.selectedRange
        if range.length == 0 {
            return tv.typingAttributes[NoteMarkKey.link] as? String
        }
        return linkExtendedRange().href
    }

    /// Расширяет пустое выделение до границ марки `link` под курсором —
    /// аналог `extendMarkRange("link")` веба (спека: «снимаем ссылку, если
    /// курсор уже внутри неё»).
    private func linkExtendedRange() -> (range: NSRange?, href: String?) {
        guard let tv = textView, let storage = tv.textStorage as NSTextStorage?, storage.length > 0 else { return (nil, nil) }
        var range = tv.selectedRange
        if range.length > 0 {
            var allSame = true
            var href: String?
            storage.enumerateAttribute(NoteMarkKey.link, in: range, options: []) { value, _, stop in
                let v = value as? String
                if href == nil && v != nil { href = v }
                if v != href { allSame = false; stop.pointee = true }
            }
            return allSame ? (range, href) : (nil, nil)
        }
        let probe = max(0, min(range.location, storage.length - 1))
        guard probe < storage.length, let href = storage.attribute(NoteMarkKey.link, at: probe, effectiveRange: &range) as? String else {
            return (nil, nil)
        }
        return (range, href)
    }

    private func toggle(_ mark: InlineMark, apply: @escaping (inout RichRun, Bool) -> Void) {
        guard let tv = textView else { return }
        let base = NoteRichText.baseFont(for: blockKind)
        let range = tv.selectedRange
        if range.length == 0 {
            var run = runState(at: tv.typingAttributes)
            let turnOn = !marks(of: run).contains(mark)
            apply(&run, turnOn)
            tv.typingAttributes = NoteRichText.attributes(for: run, base: base)
            return
        }
        guard let storage = tv.textStorage as NSTextStorage? else { return }
        let semanticKey = Self.semanticKey(for: mark)
        var allHave = true
        storage.enumerateAttribute(semanticKey, in: range, options: []) { value, _, stop in
            if !((value as? Bool) ?? false) { allHave = false; stop.pointee = true }
        }
        let turnOn = !allHave
        storage.beginEditing()
        storage.enumerateAttributes(in: range, options: []) { attrs, subrange, _ in
            var run = runState(at: attrs)
            apply(&run, turnOn)
            storage.setAttributes(NoteRichText.attributes(for: run, base: base), range: subrange)
        }
        storage.endEditing()
        tv.selectedRange = range
    }

    func toggleBold() { toggle(.bold) { $0.bold = $1 } }
    func toggleItalic() { toggle(.italic) { $0.italic = $1 } }
    func toggleUnderline() { toggle(.underline) { $0.underline = $1 } }
    func toggleStrike() { toggle(.strike) { $0.strike = $1 } }
    func toggleHighlight() { toggle(.highlight) { $0.highlight = $1 } }
    func toggleCode() { toggle(.code) { $0.code = $1 } }

    static func semanticKey(for mark: InlineMark) -> NSAttributedString.Key {
        switch mark {
        case .bold: NoteMarkKey.bold
        case .italic: NoteMarkKey.italic
        case .underline: NoteMarkKey.underline
        case .strike: NoteMarkKey.strike
        case .highlight: NoteMarkKey.highlight
        case .code: NoteMarkKey.code
        case .link: NoteMarkKey.link
        }
    }

    /// Применяет ссылку к выделению (или к границам уже существующей марки
    /// под курсором — «продлить и заменить URL»).
    func applyLink(href: String) {
        guard let tv = textView, let storage = tv.textStorage as NSTextStorage? else { return }
        let base = NoteRichText.baseFont(for: blockKind)
        let range = linkExtendedRange().range ?? tv.selectedRange
        guard range.length > 0 else { return }
        storage.beginEditing()
        storage.enumerateAttributes(in: range, options: []) { attrs, subrange, _ in
            var run = runState(at: attrs)
            run.linkHref = href
            storage.setAttributes(NoteRichText.attributes(for: run, base: base), range: subrange)
        }
        storage.endEditing()
        tv.selectedRange = NSRange(location: range.location + range.length, length: 0)
    }

    func removeLink() {
        guard let tv = textView, let storage = tv.textStorage as NSTextStorage?,
              let range = linkExtendedRange().range
        else { return }
        let base = NoteRichText.baseFont(for: blockKind)
        storage.beginEditing()
        storage.enumerateAttributes(in: range, options: []) { attrs, subrange, _ in
            var run = runState(at: attrs)
            run.linkHref = nil
            storage.setAttributes(NoteRichText.attributes(for: run, base: base), range: subrange)
        }
        storage.endEditing()
    }

    /// Вставляет текст (например, распознанную диктовку или ответ ИИ) в
    /// позицию курсора как обычный текст без марок — используется меню AI.
    func insertPlainParagraph(_ text: String) {
        guard let tv = textView else { return }
        let base = NoteRichText.baseFont(for: blockKind)
        let insertion = NSAttributedString(text: text, attributes: NoteRichText.attributes(for: RichRun(text: text), base: base))
        let range = tv.selectedRange
        guard let storage = tv.textStorage as NSTextStorage? else { return }
        storage.replaceCharacters(in: range, with: insertion)
        tv.selectedRange = NSRange(location: range.location + insertion.length, length: 0)
    }
}

private extension NSAttributedString {
    convenience init(text: String, attributes: [NSAttributedString.Key: Any]) {
        self.init(string: text, attributes: attributes)
    }
}

/// Реестр контроллеров «блок → его текстовый движок» на весь экран.
/// Обычный класс, НЕ `@Observable` — держится в `@State` только затем,
/// чтобы пережить пересоздания `NoteEditorScreen.body`; сама мутация
/// словаря внутри вызова `body` не должна дёргать SwiftUI-инвалидацию
/// (иначе получили бы «изменение состояния во время обновления вью»),
/// поэтому это простой ссылочный тип-кладовка, а не `@State`-словарь.
@MainActor
final class NoteBlockControllerStore {
    private var controllers: [UUID: NoteBlockTextController] = [:]

    func controller(for blockID: UUID) -> NoteBlockTextController {
        if let existing = controllers[blockID] { return existing }
        let created = NoteBlockTextController()
        controllers[blockID] = created
        return created
    }
}

/// `UITextView`, перехватывающий Backspace на пустом выделении в позиции 0 —
/// штатный `shouldChangeTextIn` на «нечего удалять в начале» делегат не
/// зовёт вовсе, поэтому единственный надёжный способ поймать «слияние с
/// предыдущим блоком» — переопределить сам `deleteBackward()`.
final class NoteUITextView: UITextView {
    var onBackspaceAtStart: (() -> Void)?

    override func deleteBackward() {
        if selectedRange.location == 0 && selectedRange.length == 0 {
            onBackspaceAtStart?()
            return
        }
        super.deleteBackward()
    }

    // Авторост высоты внутри SwiftUI-стека: `isScrollEnabled = false` не
    // сам по себе не публикует новый `intrinsicContentSize` при переносе
    // строк — считаем его явно от ширины и инвалидируем на каждый layout
    // (стандартный приём для growing UITextView в SwiftUI).
    override var intrinsicContentSize: CGSize {
        let fitting = sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude))
        return CGSize(width: UIView.noIntrinsicMetric, height: max(fitting.height, 22))
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        invalidateIntrinsicContentSize()
    }
}

struct NoteBlockTextView: UIViewRepresentable {
    let blockID: UUID
    var runs: [RichRun]
    let blockKind: BlockKind
    let controller: NoteBlockTextController

    var onChange: (UUID, [RichRun]) -> Void
    var onFocus: (UUID, NoteBlockTextController) -> Void
    var onBlur: (UUID) -> Void
    var onMarksChange: (UUID, Set<InlineMark>) -> Void
    var onSplit: (UUID, Int) -> Void
    var onBackspaceAtStart: (UUID) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeUIView(context: Context) -> NoteUITextView {
        let tv = NoteUITextView()
        tv.backgroundColor = .clear
        tv.isScrollEnabled = false
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.delegate = context.coordinator
        tv.font = NoteRichText.baseFont(for: blockKind)
        tv.tintColor = UIColor(Color.tfRed)
        tv.dataDetectorTypes = []
        tv.attributedText = NoteRichText.attributedString(runs: runs, blockKind: blockKind)
        tv.onBackspaceAtStart = { [weak coordinator = context.coordinator] in
            guard let coordinator else { return }
            coordinator.parent.onBackspaceAtStart(coordinator.parent.blockID)
        }
        controller.textView = tv
        controller.blockKind = blockKind
        context.coordinator.lastBlockKind = blockKind
        return tv
    }

    func updateUIView(_ uiView: NoteUITextView, context: Context) {
        context.coordinator.parent = self
        controller.blockKind = blockKind
        let kindChanged = context.coordinator.lastBlockKind != blockKind
        context.coordinator.lastBlockKind = blockKind
        let expected = NoteRichText.attributedString(runs: runs, blockKind: blockKind)

        if kindChanged {
            // Смена типа блока (параграф → заголовок и т.п.) обязана
            // перерисоваться, ДАЖЕ если поле сейчас в фокусе (иначе кегль
            // заголовка не применится, пока человек не выйдет из блока).
            let saved = uiView.selectedRange
            uiView.attributedText = expected
            uiView.selectedRange = NSRange(location: min(saved.location, expected.length), length: 0)
            if uiView.isFirstResponder {
                uiView.typingAttributes = NoteRichText.attributes(for: RichRun(text: ""), base: NoteRichText.baseFont(for: blockKind))
            }
        } else if !uiView.isFirstResponder, uiView.attributedText.string != expected.string {
            // Блок сейчас НЕ редактируется — внешняя правка (АИ вставил
            // текст, загрузка документа) синкается свободно. Пока человек
            // печатает в этом же textView, содержимое не трогаем — иначе
            // курсор скачет на каждый ре-рендер SwiftUI.
            uiView.attributedText = expected
        }
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NoteBlockTextView
        var lastBlockKind: BlockKind = .paragraph

        init(parent: NoteBlockTextView) { self.parent = parent }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.onFocus(parent.blockID, parent.controller)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.onBlur(parent.blockID)
        }

        func textViewDidChange(_ textView: UITextView) {
            textView.invalidateIntrinsicContentSize()
            parent.onChange(parent.blockID, NoteRichText.runs(from: textView.attributedText))
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.onMarksChange(parent.blockID, parent.controller.activeMarks)
        }

        /// Перехватывает Enter — блок дальше решает сам (список/цитата/
        /// заголовок/параграф ведут себя по-разному, ViewModel §«Split»).
        /// Блок кода — исключение: перенос строки литеральный, внутри
        /// одного блока (спека и модель документа соседа это подтверждают).
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if case .codeBlock = parent.blockKind { return true }
            if text == "\n" {
                parent.onSplit(parent.blockID, range.location)
                return false
            }
            return true
        }
    }
}
