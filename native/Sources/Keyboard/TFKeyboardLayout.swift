import Foundation

// Раскладки клавиатуры.
//
// Русская — источник: src/components/AppKeyboard.tsx (актуальная версия веба,
// отключённая от приложения 20.08.2026, но раскладка/геометрия в ней рабочие
// и выверены попиксельно — см. spec/NATIVE-PARTS.md §0). Сверено построчно с
// исходником — расхождений со спекой §1.2 нет: ровно 11 клавиш в 1-м и 2-м
// рядах, «ъ» отсутствует вовсе (у нас — добавлена долгим нажатием на «ь»,
// спека §1.4 сама предлагает это как дешёвое нативное добавление).
//
// Латинская — В СПЕКЕ ЕЁ НЕТ ВООБЩЕ. spec/NATIVE-PARTS.md §1.6 перечисляет
// отсутствие английской раскладки и переключения языка как «дыру, решить,
// переносить ли в натив» — а не как окончательное решение. Задача (не спека)
// требует её дословно: «русская и латинская раскладки, … переключение
// языка». Раскладка — стандартная QWERTY (10/9/7 букв), состав и порядок
// клавиш взяты с системной клавиатуры iOS как общеизвестный факт, а не
// замерены с чьего-то скриншота — числами (шириной клавиш) заниматься
// пришлось отдельно, см. TFKeyboardView.widthPlan(rowIndex:availableWidth:).
public enum TFKeyboardLanguage: Equatable {
    case russian
    case latin
}

/// Одиночный Shift возвращается в `.lower` после одной буквы (как на iOS, не
/// Caps Lock). Caps — долгим нажатием на Shift (спека §1.4 подсказывает, что
/// долгое нажатие в нативе дёшево; тут тот же механизм, что у «ь»→«ъ», просто
/// на другой клавише — не двойной тап, как у системной клавиатуры, а тот же
/// приём, что уже есть в проекте, без отдельной логики таймингов двойного тапа).
public enum TFKeyboardCaseMode: Equatable {
    case lower
    case shift
    case caps
}

public enum TFKeyboardLayoutName: Equatable {
    case letters(TFKeyboardLanguage, TFKeyboardCaseMode)
    /// Раскладка чисел одна для обоих языков (цифры/символы не зависят от
    /// языка) — несёт только язык, КУДА вернуться по {abc}.
    case numbers(TFKeyboardLanguage)
}

/// Действие клавиши. `.character` несёт УЖЕ готовый регистр символа для
/// вставки — подпись клавиши (`TFKey.label`) при этом ВСЕГДА заглавная
/// (спека §1.2 п.2) — это два разных значения, их нельзя путать.
public enum TFKeyAction: Equatable {
    case character(String)
    case shift
    case capsLock
    case backspace
    case enter
    case space
    case numbers
    case abc
    case mic
    case globe
}

/// Визуальное состояние Shift — нужно ТОЛЬКО самой клавише Shift, чтобы было
/// видно, что Caps включён (без этого включённый Caps ничем не отличался бы
/// от обычного состояния, и проверить его на экране было бы нельзя).
public enum TFKeyVisualState: Equatable {
    case normal
    case active
    case locked
}

public struct TFKey: Identifiable, Equatable {
    public let id: String
    public let action: TFKeyAction
    public let label: String
    public let longPress: TFKeyAction?
    /// Только у пробела — метка языка у правого края («ру»/«en», спека §1.1).
    public let overlayMark: String?
    /// Только у Shift — normal/active(shift)/locked(caps).
    public let visualState: TFKeyVisualState

    public init(
        _ action: TFKeyAction,
        label: String,
        longPress: TFKeyAction? = nil,
        overlayMark: String? = nil,
        visualState: TFKeyVisualState = .normal
    ) {
        self.action = action
        self.label = label
        self.longPress = longPress
        self.overlayMark = overlayMark
        self.visualState = visualState
        self.id = "\(action)|\(label)"
    }
}

public enum TFKeyboardLayout {
    private static let ruRow1 = "й ц у к е н г ш щ з х".split(separator: " ").map(String.init)
    private static let ruRow2 = "ф ы в а п р о л д ж э".split(separator: " ").map(String.init)
    private static let ruRow3 = "я ч с м и т ь б ю".split(separator: " ").map(String.init)

    // QWERTY — состав общеизвестен, числами (шириной) не описан нигде, см.
    // заголовок файла.
    private static let enRow1 = "q w e r t y u i o p".split(separator: " ").map(String.init)
    private static let enRow2 = "a s d f g h j k l".split(separator: " ").map(String.init)
    private static let enRow3 = "z x c v b n m".split(separator: " ").map(String.init)

    private static func letterKey(_ lower: String, uppercase: Bool, longPress: TFKeyAction? = nil) -> TFKey {
        TFKey(.character(uppercase ? lower.uppercased() : lower), label: lower.uppercased(), longPress: longPress)
    }

    private static func lettersRows(language: TFKeyboardLanguage, caseMode: TFKeyboardCaseMode) -> [[TFKey]] {
        let uppercase = caseMode != .lower
        let (row1, row2, row3Letters): ([String], [String], [String]) =
            language == .russian ? (ruRow1, ruRow2, ruRow3) : (enRow1, enRow2, enRow3)

        let shiftVisual: TFKeyVisualState = caseMode == .caps ? .locked : (caseMode == .shift ? .active : .normal)
        let shiftKey = TFKey(.shift, label: "", longPress: .capsLock, visualState: shiftVisual)

        let row3 = [shiftKey]
            + row3Letters.map { ch -> TFKey in
                // «ь» → долгое нажатие «ъ» — только в русской раскладке, единственное
                // добавление сверх исходной клавиатуры веба (там такой клавиши нет,
                // см. заголовок файла).
                if language == .russian, ch == "ь" {
                    return letterKey(ch, uppercase: uppercase, longPress: .character(uppercase ? "Ъ" : "ъ"))
                }
                return letterKey(ch, uppercase: uppercase)
            }
            + [TFKey(.backspace, label: "")]

        let spaceMark = language == .russian ? "ру" : "en"
        let row4 = [
            TFKey(.globe, label: ""),
            TFKey(.numbers, label: "123"),
            TFKey(.mic, label: ""),
            TFKey(.space, label: "", overlayMark: spaceMark),
            TFKey(.enter, label: ""),
        ]

        return [
            row1.map { letterKey($0, uppercase: uppercase) },
            row2.map { letterKey($0, uppercase: uppercase) },
            row3,
            row4,
        ]
    }

    private static func numbersRows(returnLanguage: TFKeyboardLanguage) -> [[TFKey]] {
        let row1 = "1 2 3 4 5 6 7 8 9 0".split(separator: " ").map(String.init)
        let row2 = ["-", "/", ":", ";", "(", ")", "₽", "&", "@", "\""]
        let row3Mid = [".", ",", "?", "!", "'", "+", "="]
        // Цифры/символы одни на оба языка (не завязаны на язык вообще) — метка
        // {abc}/пробела зависит от языка ТОЛЬКО потому, что показывает, куда
        // вернёмся, а не потому что сам числовой ряд другой.
        let abcLabel = returnLanguage == .russian ? "АБВ" : "ABC"
        let spaceMark = returnLanguage == .russian ? "ру" : "en"

        let row3 = [TFKey(.abc, label: abcLabel)]
            + row3Mid.map { TFKey(.character($0), label: $0) }
            + [TFKey(.backspace, label: "")]
        let row4 = [
            TFKey(.abc, label: abcLabel),
            TFKey(.mic, label: ""),
            TFKey(.space, label: "", overlayMark: spaceMark),
            TFKey(.enter, label: ""),
        ]

        return [
            row1.map { TFKey(.character($0), label: $0) },
            row2.map { TFKey(.character($0), label: $0) },
            row3,
            row4,
        ]
    }

    public static func rows(for layout: TFKeyboardLayoutName) -> [[TFKey]] {
        switch layout {
        case .letters(let language, let caseMode): lettersRows(language: language, caseMode: caseMode)
        case .numbers(let returnLanguage): numbersRows(returnLanguage: returnLanguage)
        }
    }
}
