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
    /// Вкладка «Сегодня» рисует не пустой значок календаря, а рамку с
    /// ЧИСЛОМ текущего дня — как в вебе (`TodayDateIcon` в UI.tsx) и как
    /// это делает системный «Календарь». Владелец 01.09.2026: «сегодня он
    /// отражает фактическую дату, у тебя она не отражается в иконке».
    let showsTodayDate: Bool

    public init(icon: String, accessibilityLabel: String, badgeCount: Int? = nil, showsTodayDate: Bool = false) {
        self.icon = icon
        self.accessibilityLabel = accessibilityLabel
        self.badgeCount = badgeCount
        self.showsTodayDate = showsTodayDate
    }
}

/// Значок календаря с числом сегодняшнего дня.
///
/// Число берётся у системного календаря и обновляется по `NSCalendarDayChanged`
/// — штатному уведомлению о смене суток. Таймер на полночь (как в вебе) здесь
/// не нужен: система шлёт это уведомление и после возврата из фона, поэтому
/// число не застревает на вчерашнем, если телефон пролежал ночь в кармане.
struct TFTodayDateIcon: View {
    let size: CGFloat
    @State private var day = Calendar.current.component(.day, from: Date())

    var body: some View {
        ZStack {
            // Значок — СИСТЕМНЫЙ «calendar», как у соседних вкладок (тот же
            // вес и форма, иначе выбивается из ряда). Убрана только его
            // внутренняя сетка точек: маска оставляет рамку и шапку, а окно
            // вырезает `destinationOut`. Владелец 01.09.2026: «используй ту
            // иконку, просто почисти точки и поставь единичку».
            Image(systemName: "calendar")
                .font(.system(size: size))
                .mask(
                    ZStack {
                        Rectangle()
                        // Окно под число: от линии шапки до низа рамки.
                        // Окно расширено ТОЛЬКО ВВЕРХ — до шапки календаря:
                        // там оставались точки сетки. Нижний край там же, где
                        // был (0.36·size), иначе вырез съедает низ рамки —
                        // 01.09.2026 владелец это сразу увидел.
                        Rectangle()
                            // Ширина и нижняя кромка — РОВНО как были
                            // (0.62 и 0.36·size). Поднят только верх: с -0.08
                            // до -0.14·size, где и оставались точки сетки.
                            .frame(width: size * 0.62, height: size * 0.50)
                            .offset(y: size * 0.11)
                            .blendMode(.destinationOut)
                    }
                    .compositingGroup()
                )
            // Число там же, где в вебе: в окне под шапкой календаря.
            Text("\(day)")
                .font(.system(size: size * (day > 9 ? 0.375 : 0.417), weight: .bold))
                .offset(y: size * 0.13)
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
            day = Calendar.current.component(.day, from: Date())
        }
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
        // `.bottom`, не `.top`: у нижней панели плотная часть затухания
        // должна быть у НИЖНЕЙ кромки экрана («под панелью не просвечивает
        // ничего»), а таять кверху — зеркально шапке. С `.top` градиент был
        // перевёрнут и панель читалась сплошной.
        .background(TFHeaderScrim(axis: .bottom).ignoresSafeArea(edges: .bottom))
    }

    private func tabButton(_ index: Int) -> some View {
        let item = items[index]
        let isActive = selectedIndex == index
        return Button {
            onSelect(index)
        } label: {
            ZStack {
                // Кружка-подложки под активной вкладкой нет (владелец,
                // 01.09.2026: «не надо никаких кружков»). Выделение несёт
                // только цвет значка: серый → белый.
                Group {
                    if item.showsTodayDate {
                        // Замер по кадру 01.09.2026: рисунок «calendar» давал
                        // 27.3pt против 31.7–33.0 у соседей — значок выбивался
                        // из ряда. Коэффициент 1.19 приводит его ширину к тем
                        // же ~32.5pt.
                        TFTodayDateIcon(size: TFTabBarMetrics.iconSize * 1.19)
                    } else {
                        Image(systemName: item.icon)
                            .font(.system(size: TFTabBarMetrics.iconSize))
                            // У `calendar.badge.clock` бейдж висит справа и
                            // тянет всю массу рисунка на 2.9pt вправо: центр
                            // значка не совпадал с центром своей ячейки.
                            .offset(x: item.icon == "calendar.badge.clock" ? -2.9 : 0)
                    }
                }
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

    /// Стабильный identifier для пункта меню по его title (русскому).
    static func identifier(for title: String) -> String {
        switch title {
        case "Задача": return "create.task"
        case "Заметка": return "create.note"
        case "Проект": return "create.project"
        default: return "create.\(title.lowercased())"
        }
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
                .accessibilityLabel(item.title)
                .accessibilityIdentifier(Self.identifier(for: item.title))
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

