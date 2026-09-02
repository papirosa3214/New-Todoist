import SwiftUI

// Поля ввода — spec/DESIGN-TOKENS.md §4 «Поля ввода» + §2 (16px обязателен
// для текста внутри поля — единственное место, где эта ступень шкалы легальна).
public struct TFTextField: View {
    let placeholder: String
    @Binding var text: String
    let icon: String?

    public init(_ placeholder: String, text: Binding<String>, icon: String? = nil) {
        self.placeholder = placeholder
        self._text = text
        self.icon = icon
    }

    public var body: some View {
        HStack(spacing: TFField.iconTextGap) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: TFIconSize.sm))
                    .foregroundStyle(Color.tfDim)
            }
            TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Color.tfDim))
                .tfText(.input)
                .foregroundStyle(Color.tfText)
        }
        .padding(.horizontal, TFSpacing.lg)
        .frame(height: TFField.height)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }
}

/// Строка внутри `FieldGroup` — «Срок и время», «Проект», «Приоритет», «Метки»
/// (task-new.png): иконка слева, заголовок, значение справа + шеврон, тап
/// целиком открывает выбор. Разделитель между строками рисует контейнер `TFFieldGroup`.
public struct TFFieldRow: View {
    let icon: String
    let title: String
    let value: String
    /// Цвет значения — обычно `sub`, но «Приоритет: Срочный» красится акцентом.
    let valueColor: Color
    let action: () -> Void

    public init(icon: String, title: String, value: String, valueColor: Color = .tfSub, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.value = value
        self.valueColor = valueColor
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: TFField.iconTextGap) {
                Image(systemName: icon)
                    .font(.system(size: TFIconSize.sm))
                    .foregroundStyle(Color.tfDim)
                    .frame(width: TFIconSize.sm)
                Text(title)
                    .tfText(.body)
                    .fontWeight(.medium)
                    .foregroundStyle(Color.tfText)
                Spacer()
                Text(value)
                    .tfText(.body)
                    .foregroundStyle(valueColor)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.tfDim)
            }
            .padding(.horizontal, TFField.cardInsetH)
            .frame(minHeight: TFField.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }
}

/// Карточка-контейнер для группы `TFFieldRow` — фон `card`, радиус 16px,
/// разделители 1px `stroke` между строками (не во всю ширину карточки — инсет `mx-4`).
public struct TFFieldGroup<Content: View>: View {
    let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        VStack(spacing: 0) {
            content
        }
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }
}

/// Разделитель между строками `TFFieldGroup` — вставляется вручную между
/// строками контента (SwiftUI не даёт «разделитель кроме первого» декларативно
/// проще, чем явной расстановкой).
public struct TFFieldDivider: View {
    public init() {}
    public var body: some View {
        Rectangle()
            .fill(Color.tfStroke)
            .frame(height: TFBorder.width)
            .padding(.horizontal, TFField.cardInsetH)
    }
}

#Preview("Поля ввода") {
    VStack(spacing: TFSpacing.lg) {
        TFTextField("Название задачи", text: .constant(""))
        TFFieldGroup {
            TFFieldRow(icon: "calendar", title: "Срок и время", value: "Не установлен") {}
            TFFieldDivider()
            TFFieldRow(icon: "number", title: "Проект", value: "AI Control Center") {}
            TFFieldDivider()
            TFFieldRow(icon: "flag", title: "Приоритет", value: "Срочный", valueColor: .tfRed) {}
            TFFieldDivider()
            TFFieldRow(icon: "tag", title: "Метки", value: "Нет") {}
        }
    }
    .padding()
    .background(Color.tfBackground)
}
