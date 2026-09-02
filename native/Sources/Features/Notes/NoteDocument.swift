import Foundation

// ═══════════ Модель документа заметки ═══════════
//
// Блочное представление, зеркалящее СХЕМУ TipTap/ProseMirror, которую пишет
// веб-редактор (`src/screens/NoteEditorScreen.tsx`: StarterKit + TaskList +
// TaskItem{nested:true} + Highlight + Link{href}, плюс Underline — он не
// импортирован явно, но `editor.chain().toggleUnderline()`/`isActive
// ("underline")` в веб-файле подтверждают, что марка `underline` в схеме
// реально есть). Имена узлов/марок и форма attrs сверены построчно с
// серверными конвертерами `server/src/lib/{markdownToTiptap,
// tiptapToMarkdown}.ts` — они не используются нативным клиентом напрямую
// (см. NotesAPI.swift, почему шлём `content`, а не `markdown`: markdown
// вообще не умеет underline), но их код — единственное живое подтверждение
// формы схемы, которое есть в репозитории.
//
// Представление здесь — ПЛОСКИЙ список блоков с уровнем вложенности
// (`level`) у пунктов списков, а не дерево — так проще редактировать:
// каждый блок = отдельная строка со своим текстовым полем. При
// сериализации соседние блоки одного типа списка и уровня схлопываются
// обратно в узел `bulletList`/`orderedList`/`taskList` с вложенными
// `listItem`/`taskItem` — то же группирование, что делает
// `markdownToTiptap.parseList` в обратную сторону.
//
// ⚠️ Упрощения (названы явно, не спрятаны):
// - `orderedList.attrs.start` (нумерация не с 1) не сохраняется — при
//   загрузке такой заметки список отрисуется с 1, при сохранении
//   исходный сдвиг потеряется. Веб такое создаёт только через markdown-
//   импорт агентом, штатный тулбар веба тоже не даёт менять start.
// - `blockquote` с несколькими параграфами хранится как несколько
//   соседних блоков `.blockquote` и группируется на сериализации — без
//   вложенных списков внутри цитаты (веб-тулбар их тоже не создаёт).
// - Заголовки декодируются в диапазон 1...3 (тулбар даёт только H1–H3);
//   H4–H6 из чужого документа (например, вставленного через агента)
//   упадут до H3, а не потеряются совсем.
struct NoteDocument: Equatable {
    var blocks: [NoteBlock]

    static let empty = NoteDocument(blocks: [NoteBlock(kind: .paragraph)])

    /// Заголовок — первый непустой текстовый блок, обрезка 200 символов.
    /// Зеркалит `deriveTitle()` в вебе: первый textblock с непустым
    /// текстом в порядке документа (спека §2 «Заголовок заметки»).
    var derivedTitle: String {
        for block in blocks {
            let text = block.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return String(text.prefix(200)) }
        }
        return ""
    }

    var isEffectivelyEmpty: Bool {
        blocks.allSatisfy { $0.plainText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

/// Один блок документа — строка редактора. `level` осмыслен только для
/// пунктов списков (глубина вложенности, 0 = верхний уровень); у прочих
/// типов не используется.
struct NoteBlock: Identifiable, Equatable {
    let id: UUID
    var kind: BlockKind
    var level: Int
    /// Инлайн-содержимое. Для `.codeBlock` — единственный run без марок,
    /// текст которого может содержать переносы строк буквально (код —
    /// многострочный, в отличие от параграфа, где перенос — hardBreak).
    var runs: [RichRun]

    init(id: UUID = UUID(), kind: BlockKind, level: Int = 0, runs: [RichRun] = []) {
        self.id = id
        self.kind = kind
        self.level = level
        self.runs = runs
    }

    var plainText: String { runs.map(\.text).joined() }
}

enum BlockKind: Equatable {
    case paragraph
    case heading(level: Int) // 1...3
    case bulletItem
    case orderedItem
    case taskItem(checked: Bool)
    case blockquote
    case codeBlock(language: String?)
    case horizontalRule

    /// «Список» — общий признак трёх кейсов, нужен группировке при кодировании.
    var isListItem: Bool {
        switch self {
        case .bulletItem, .orderedItem, .taskItem: true
        default: false
        }
    }
}

/// Прогон инлайн-текста с марками — Swift-эквивалент text-узла TipTap с
/// массивом `marks`. Имена булевых полей = имена марок в схеме буквально.
struct RichRun: Equatable {
    var text: String
    var bold = false
    var italic = false
    var underline = false
    var strike = false
    var highlight = false
    var code = false
    var linkHref: String?

    init(text: String, bold: Bool = false, italic: Bool = false, underline: Bool = false,
         strike: Bool = false, highlight: Bool = false, code: Bool = false, linkHref: String? = nil) {
        self.text = text
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.strike = strike
        self.highlight = highlight
        self.code = code
        self.linkHref = linkHref
    }
}

// MARK: - Декодирование: JSON-строка (`user_notes.content`) → NoteDocument

extension NoteDocument {
    /// `jsonString` — то, что лежит в `ApiNote.content.stringValue` (сервер
    /// хранит TipTap JSON КАК СТРОКУ в TEXT-колонке, отдаёт как есть). Пустая
    /// или битая строка — не ошибка (то же самое поведение, что у веба:
    /// «battый/чужой формат — открываем пустую страницу, не рушим экран»).
    static func decode(fromJSONString jsonString: String?) -> NoteDocument {
        guard let jsonString,
              !jsonString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let data = jsonString.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let content = obj["content"] as? [Any]
        else { return .empty }

        var blocks: [NoteBlock] = []
        decodeBlocks(content, level: 0, into: &blocks)
        return blocks.isEmpty ? .empty : NoteDocument(blocks: blocks)
    }

    private static func decodeBlocks(_ nodes: [Any], level: Int, into blocks: inout [NoteBlock]) {
        for case let node as [String: Any] in nodes {
            let type = node["type"] as? String
            switch type {
            case "paragraph":
                blocks.append(NoteBlock(kind: .paragraph, runs: decodeInline(node["content"] as? [Any])))

            case "heading":
                let raw = intValue((node["attrs"] as? [String: Any])?["level"]) ?? 1
                blocks.append(NoteBlock(kind: .heading(level: min(max(raw, 1), 3)), runs: decodeInline(node["content"] as? [Any])))

            case "horizontalRule":
                blocks.append(NoteBlock(kind: .horizontalRule))

            case "codeBlock":
                let attrs = node["attrs"] as? [String: Any]
                let lang = attrs?["language"] as? String
                let text = (node["content"] as? [Any])?
                    .compactMap { ($0 as? [String: Any])?["text"] as? String }
                    .joined() ?? ""
                blocks.append(NoteBlock(kind: .codeBlock(language: (lang?.isEmpty == false) ? lang : nil), runs: [RichRun(text: text)]))

            case "blockquote":
                let inner = node["content"] as? [Any] ?? []
                if inner.isEmpty {
                    blocks.append(NoteBlock(kind: .blockquote, runs: []))
                }
                for case let p as [String: Any] in inner {
                    blocks.append(NoteBlock(kind: .blockquote, runs: decodeInline(p["content"] as? [Any])))
                }

            case "bulletList", "orderedList", "taskList":
                decodeListItems(node["content"] as? [Any] ?? [], listType: type!, level: level, into: &blocks)

            default:
                // Неизвестный узел — не роняем документ, вытаскиваем текст
                // детей как есть (зеркалит default-ветку `blockToMd`).
                if let inner = node["content"] as? [Any] {
                    decodeBlocks(inner, level: level, into: &blocks)
                }
            }
        }
    }

    private static func decodeListItems(_ items: [Any], listType: String, level: Int, into blocks: inout [NoteBlock]) {
        for case let item as [String: Any] in items {
            let itemContent = item["content"] as? [Any] ?? []
            var consumedOwnText = false
            for case let child as [String: Any] in itemContent {
                let childType = child["type"] as? String
                if childType == "bulletList" || childType == "orderedList" || childType == "taskList" {
                    decodeListItems(child["content"] as? [Any] ?? [], listType: childType!, level: level + 1, into: &blocks)
                } else if !consumedOwnText {
                    blocks.append(NoteBlock(kind: itemKind(listType, attrs: item["attrs"] as? [String: Any]), level: level, runs: decodeInline(child["content"] as? [Any])))
                    consumedOwnText = true
                }
            }
            if !consumedOwnText {
                blocks.append(NoteBlock(kind: itemKind(listType, attrs: item["attrs"] as? [String: Any]), level: level, runs: []))
            }
        }
    }

    private static func itemKind(_ listType: String, attrs: [String: Any]?) -> BlockKind {
        switch listType {
        case "taskList": .taskItem(checked: attrs?["checked"] as? Bool ?? false)
        case "orderedList": .orderedItem
        default: .bulletItem
        }
    }

    private static func decodeInline(_ nodes: [Any]?) -> [RichRun] {
        guard let nodes else { return [] }
        var runs: [RichRun] = []
        for case let node as [String: Any] in nodes {
            let type = node["type"] as? String
            if type == "hardBreak" {
                if var last = runs.last {
                    last.text += "\n"
                    runs[runs.count - 1] = last
                } else {
                    runs.append(RichRun(text: "\n"))
                }
                continue
            }
            guard type == "text", let text = node["text"] as? String, !text.isEmpty else { continue }
            var run = RichRun(text: text)
            if let marks = node["marks"] as? [[String: Any]] {
                for mark in marks {
                    switch mark["type"] as? String {
                    case "bold": run.bold = true
                    case "italic": run.italic = true
                    case "underline": run.underline = true
                    case "strike": run.strike = true
                    case "highlight": run.highlight = true
                    case "code": run.code = true
                    case "link":
                        if let href = (mark["attrs"] as? [String: Any])?["href"] as? String { run.linkHref = href }
                    default: break
                    }
                }
            }
            runs.append(run)
        }
        return runs
    }

    private static func intValue(_ any: Any?) -> Int? {
        if let n = any as? NSNumber { return n.intValue }
        if let i = any as? Int { return i }
        if let d = any as? Double { return Int(d) }
        return nil
    }
}

// MARK: - Кодирование: NoteDocument → JSON-строка (для PATCH `content`)

extension NoteDocument {
    /// Собирает `{"type":"doc","content":[...]}` и сериализует его в строку —
    /// ровно то, что ждёт `typeof req.body.content === "string"` на сервере
    /// (spec: объект вместо строки в этом поле сервер молча проигнорирует).
    func encodeToJSONString() -> String {
        var i = 0
        let content = Self.encodeBlocks(blocks, &i)
        let doc: [String: Any] = ["type": "doc", "content": content.isEmpty ? [["type": "paragraph"]] : content]
        guard JSONSerialization.isValidJSONObject(doc),
              let data = try? JSONSerialization.data(withJSONObject: doc)
        else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func encodeBlocks(_ blocks: [NoteBlock], _ i: inout Int) -> [[String: Any]] {
        var out: [[String: Any]] = []
        while i < blocks.count {
            let block = blocks[i]
            switch block.kind {
            case .paragraph:
                var node: [String: Any] = ["type": "paragraph"]
                if let inline = encodeInline(block.runs) { node["content"] = inline }
                out.append(node); i += 1

            case .heading(let level):
                var node: [String: Any] = ["type": "heading", "attrs": ["level": level]]
                if let inline = encodeInline(block.runs) { node["content"] = inline }
                out.append(node); i += 1

            case .horizontalRule:
                out.append(["type": "horizontalRule"]); i += 1

            case .codeBlock(let language):
                let text = block.runs.first?.text ?? ""
                out.append([
                    "type": "codeBlock",
                    "attrs": ["language": (language as Any?) ?? NSNull()],
                    "content": text.isEmpty ? [] : [["type": "text", "text": text]],
                ])
                i += 1

            case .blockquote:
                var paragraphs: [[String: Any]] = []
                while i < blocks.count, case .blockquote = blocks[i].kind {
                    var p: [String: Any] = ["type": "paragraph"]
                    if let inline = encodeInline(blocks[i].runs) { p["content"] = inline }
                    paragraphs.append(p)
                    i += 1
                }
                out.append(["type": "blockquote", "content": paragraphs])

            case .bulletItem, .orderedItem, .taskItem:
                let level = block.level
                let (node, nextI) = encodeList(blocks, startAt: i, level: level)
                out.append(node)
                i = nextI
            }
        }
        return out
    }

    /// Схлопывает подряд идущие пункты одного семейства и уровня в один
    /// узел списка; вложенный список того же/иного семейства на уровень
    /// глубже уходит рекурсией внутрь `content` последнего пункта.
    private static func encodeList(_ blocks: [NoteBlock], startAt start: Int, level: Int) -> ([String: Any], Int) {
        var i = start
        let listType = listTypeName(blocks[start].kind)
        var items: [[String: Any]] = []

        while i < blocks.count, blocks[i].level == level, listTypeName(blocks[i].kind) == listType {
            var item: [String: Any] = ["type": listType == "taskList" ? "taskItem" : "listItem"]
            if case .taskItem(let checked) = blocks[i].kind {
                item["attrs"] = ["checked": checked]
            }
            var itemContent: [[String: Any]] = []
            var p: [String: Any] = ["type": "paragraph"]
            if let inline = encodeInline(blocks[i].runs) { p["content"] = inline }
            itemContent.append(p)
            i += 1

            if i < blocks.count, blocks[i].kind.isListItem, blocks[i].level == level + 1 {
                let (nested, nextI) = encodeList(blocks, startAt: i, level: level + 1)
                itemContent.append(nested)
                i = nextI
            }
            item["content"] = itemContent
            items.append(item)
        }
        return (["type": listType, "content": items], i)
    }

    private static func listTypeName(_ kind: BlockKind) -> String {
        switch kind {
        case .taskItem: "taskList"
        case .orderedItem: "orderedList"
        default: "bulletList"
        }
    }

    private static func encodeInline(_ runs: [RichRun]) -> [[String: Any]]? {
        var out: [[String: Any]] = []
        for run in runs {
            // «\n» внутри прогона — мягкий перенос (Shift+Enter в вебе),
            // в схеме TipTap это отдельный узел hardBreak между текстами,
            // а не буквальный символ внутри text-узла.
            let parts = run.text.components(separatedBy: "\n")
            for (idx, part) in parts.enumerated() {
                if idx > 0 { out.append(["type": "hardBreak"]) }
                guard !part.isEmpty else { continue }
                var node: [String: Any] = ["type": "text", "text": part]
                var marks: [[String: Any]] = []
                if run.bold { marks.append(["type": "bold"]) }
                if run.italic { marks.append(["type": "italic"]) }
                if run.underline { marks.append(["type": "underline"]) }
                if run.strike { marks.append(["type": "strike"]) }
                if run.highlight { marks.append(["type": "highlight"]) }
                if run.code { marks.append(["type": "code"]) }
                if let href = run.linkHref, !href.isEmpty { marks.append(["type": "link", "attrs": ["href": href]]) }
                if !marks.isEmpty { node["marks"] = marks }
                out.append(node)
            }
        }
        return out.isEmpty ? nil : out
    }
}
