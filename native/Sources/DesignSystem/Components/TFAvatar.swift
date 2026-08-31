import SwiftUI

// Аватар (`Avatar`, UI.tsx) — spec/DESIGN-TOKENS.md §4.
// Два принципиально разных вида в зависимости от наличия фото:
// - фото — радиус 8px (`rounded-lg`), НЕ круг, `object-fit: contain`
//   (вписывается целиком, не обрезает) — осознанное решение 18.08.2026,
//   круглая обрезка давала «кругляш» на фото с прозрачным фоном;
// - инициалы-заглушка — круг, фон = цвет пользователя или `#A6A6A6`,
//   шрифт `size × 0.43`, вес 600, белый текст.
public struct TFAvatar: View {
    public enum Size: CGFloat {
        case xs = 18   // строка карточки доски
        case sm = 20   // строка задачи в списке
        case md = 30
        case lg = 32   // размер по умолчанию
    }

    let size: Size
    /// nil — показываем инициалы-заглушку.
    let image: Image?
    let initials: String
    let tint: Color

    public init(size: Size = .lg, image: Image? = nil, initials: String, tint: Color = Color(hex: "#A6A6A6")) {
        self.size = size
        self.image = image
        self.initials = initials
        self.tint = tint
    }

    public var body: some View {
        Group {
            if let image {
                image
                    .resizable()
                    .aspectRatio(contentMode: .fit) // object-fit: contain
                    .frame(width: size.rawValue, height: size.rawValue)
                    .background(Color.tfCard2)
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
            } else {
                Circle()
                    .fill(tint)
                    .frame(width: size.rawValue, height: size.rawValue)
                    .overlay {
                        Text(initials)
                            .font(.system(size: size.rawValue * 0.43, weight: .semibold))
                            .foregroundStyle(.white)
                    }
            }
        }
    }
}

#Preview("Аватары") {
    HStack(alignment: .center, spacing: TFSpacing.md) {
        TFAvatar(size: .xs, initials: "МК", tint: .tfBlue)
        TFAvatar(size: .sm, initials: "МК", tint: .tfPurple)
        TFAvatar(size: .md, initials: "МК", tint: .tfTeal)
        TFAvatar(size: .lg, initials: "МК")
    }
    .padding()
    .background(Color.tfBackground)
}
