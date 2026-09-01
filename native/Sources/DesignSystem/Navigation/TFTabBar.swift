import SwiftUI

// Нижняя навигация — spec/DESIGN-TOKENS.md §4 «Нижняя навигация» +
// spec/SCREENS-1.md §2.1 (уточнение координатора 31.08.2026, разведка
// подтвердила: `Layout.tsx` жёстко на `MOBILE_NAV_STYLE = "tabbar"`).
//
// ⚠️ РАСХОЖДЕНИЕ С ФОРМУЛИРОВКОЙ ЗАДАНИЯ: задание просило «панель с горбом»
// и «веер-меню создания». Оба пункта устарели относительно спеки:
// - горб/«пузырь» убран владельцем 27.08.2026 («по бокам кнопочки, никакого
//   горбика не надо») — панель ровная, без выступа;
// - FanMenu (боковой веер) в коде есть, но НЕ активен (`MOBILE_NAV_STYLE`
//   стоит `"tabbar"`, не `"fan"`); реальное меню создания — всплывающая
//   плоская карточка `CreateMenu` (см. `TFCreateMenu` в этом файле), не веер.
// Скриншоты (`today.png`, `overview.png`) подтверждают ровный ряд из 5
// элементов. Сделано по спеке — веер не строился, числами для него спека и
// не снабжает. Если нужен именно веер — это отдельная переработка после
// прямого указания владельца.
//
// Ровно 4 вкладки (2 слева / 2 справа от круглой кнопки создания), без
// подписей под иконками (только доступность), активная — красным.
public struct TFTabItem: Identifiable {
    public let id = UUID()
    let icon: String
    let accessibilityLabel: String
    /// Только у вкладки «Сегодня» — счётчик активных задач на сегодня.
    let badgeCount: Int?

    public init(icon: String, accessibilityLabel: String, badgeCount: Int? = nil) {
        self.icon = icon
        self.accessibilityLabel = accessibilityLabel
        self.badgeCount = badgeCount
    }
}

public struct TFTabBar: View {
    let items: [TFTabItem]
    @Binding var selectedIndex: Int?
    let isCreateMenuOpen: Bool
    let onSelect: (Int) -> Void
    let onCreateTap: () -> Void

    public init(
        items: [TFTabItem],
        selectedIndex: Binding<Int?>,
        isCreateMenuOpen: Bool,
        onSelect: @escaping (Int) -> Void,
        onCreateTap: @escaping () -> Void
    ) {
        precondition(items.count == 4, "Спека фиксирует ровно 4 вкладки по бокам центральной кнопки")
        self.items = items
        self._selectedIndex = selectedIndex
        self.isCreateMenuOpen = isCreateMenuOpen
        self.onSelect = onSelect
        self.onCreateTap = onCreateTap
    }

    public var body: some View {
        HStack(spacing: 0) {
            tabButton(0)
            tabButton(1)
            createButton
            tabButton(2)
            tabButton(3)
        }
        .frame(height: TFTabBarMetrics.heightCompact)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
    }

    private func tabButton(_ index: Int) -> some View {
        let item = items[index]
        let isActive = selectedIndex == index
        return Button {
            onSelect(index)
        } label: {
            ZStack {
                if isActive {
                    Circle()
                        .fill(TFTabBarMetrics.bubbleColor)
                        .frame(width: TFTabBarMetrics.bubbleSize, height: TFTabBarMetrics.bubbleSize)
                        .transition(.scale(scale: 0).combined(with: .opacity))
                }
                Image(systemName: item.icon)
                    .font(.system(size: TFTabBarMetrics.iconSize))
                    .foregroundStyle(isActive ? Color.tfText : Color.tfDim)
                if let count = item.badgeCount, count > 0 {
                    Text("\(count)")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.tfRed)
                        .offset(x: 14, y: -12) // top:-1em left:3.3em от угла иконки, спека §4
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, TFTabBarMetrics.itemVerticalPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapScaleStyle())
        .animation(.easeOut(duration: TFAnimation.tabSwitch), value: isActive)
        .accessibilityLabel(item.accessibilityLabel)
        .accessibilityIdentifier(Self.identifier(for: item.icon))
    }

    /// Стабильный идентификатор вкладки по её SF Symbol. Не завязан на локаль.
    static func identifier(for icon: String) -> String {
        switch icon {
        case "calendar": return "tab.today"
        case "house": return "tab.directory"
        case "calendar.badge.clock": return "tab.upcoming"
        case "message": return "tab.chat"
        default: return "tab.\(icon)"
        }
    }

    private var createButton: some View {
        Button(action: onCreateTap) {
            ZStack {
                Circle()
                    .fill(Color.tfRed)
                    .frame(width: TFTabBarMetrics.createButtonSize, height: TFTabBarMetrics.createButtonSize)
                Image(systemName: "plus")
                    .font(.system(size: TFTabBarMetrics.iconSize, weight: .semibold))
                    .foregroundStyle(.white)
                    .rotationEffect(.degrees(isCreateMenuOpen ? 45 : 0))
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapScaleStyle())
        .animation(.easeOut(duration: TFAnimation.createMenu), value: isCreateMenuOpen)
        .accessibilityLabel("Новая задача")
        .accessibilityIdentifier("tab.add")
    }
}

// MARK: - CreateMenu

/// Пункт всплывающей карточки «что создать».
public struct TFCreateMenuItem: Identifiable {
    public let id = UUID()
    let icon: String
    let title: String
    let subtitle: String
    let action: () -> Void

    public init(icon: String, title: String, subtitle: String, action: @escaping () -> Void) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.action = action
    }
}

/// Всплывающая карточка над центральной кнопкой (`CreateMenu.tsx`) — НЕ веер.
/// 232px, радиус 16, раскрывается вверх от кнопки, opacity+scale(.95→1) 200ms.
public struct TFCreateMenu: View {
    let items: [TFCreateMenuItem]

    public init(items: [TFCreateMenuItem]) {
        self.items = items
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                if index > 0 {
                    Rectangle().fill(Color.tfStroke).frame(height: TFBorder.width)
                }
                Button(action: item.action) {
                    HStack(spacing: TFSpacing.md) {
                        RoundedRectangle(cornerRadius: TFCreateMenuMetrics.itemIconSlotRadius)
                            .fill(Color.white.opacity(0.1))
                            .frame(width: TFCreateMenuMetrics.itemIconSlot, height: TFCreateMenuMetrics.itemIconSlot)
                            .overlay {
                                Image(systemName: item.icon)
                                    .font(.system(size: TFCreateMenuMetrics.itemIconSize))
                                    .foregroundStyle(Color.tfText)
                            }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).tfText(.body).fontWeight(.medium).foregroundStyle(Color.tfText)
                            Text(item.subtitle).tfText(.meta).foregroundStyle(Color.tfSub)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, TFCreateMenuMetrics.itemPaddingH)
                    .padding(.vertical, TFCreateMenuMetrics.itemPaddingV)
                    .contentShape(Rectangle())
                }
                .buttonStyle(TFTapMenuStyle())
            }
        }
        .frame(width: TFCreateMenuMetrics.width)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        .overlay(RoundedRectangle(cornerRadius: TFRadius.xl).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width))
        .tfShadow(TFShadow.popover)
    }
}

/// `tap-menu`: пункт во всплывающем меню, поверхность на 1 уровень выше — 6% подсветка.
public struct TFTapMenuStyle: ButtonStyle {
    public init() {}
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.white.opacity(0.06) : .clear)
    }
}

#Preview("Таббар") {
    VStack {
        Spacer()
        TFTabBar(
            items: [
                TFTabItem(icon: "calendar", accessibilityLabel: "Сегодня", badgeCount: 3),
                TFTabItem(icon: "house", accessibilityLabel: "Обзор"),
                TFTabItem(icon: "calendar.badge.clock", accessibilityLabel: "Планирование"),
                TFTabItem(icon: "message", accessibilityLabel: "Чат"),
            ],
            selectedIndex: .constant(0),
            isCreateMenuOpen: false,
            onSelect: { _ in },
            onCreateTap: {}
        )
    }
    .background(Color.tfBackground)
}

#Preview("Меню создания") {
    ZStack(alignment: .bottom) {
        Color.tfBackground.ignoresSafeArea()
        VStack {
            TFCreateMenu(items: [
                TFCreateMenuItem(icon: "checkmark", title: "Задача", subtitle: "Со сроком и шагами") {},
                TFCreateMenuItem(icon: "book", title: "Заметка", subtitle: "Запись в дневнике") {},
                TFCreateMenuItem(icon: "tray", title: "Проект", subtitle: "Задачи и документация") {},
            ])
            .padding(.bottom, TFCreateMenuMetrics.gapAboveTabBar + TFTabBarMetrics.heightCompact)
        }
    }
}
