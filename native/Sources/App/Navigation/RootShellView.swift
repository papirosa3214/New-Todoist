import SwiftUI

/// Корневая оболочка после входа: 4 вкладки (Сегодня/Обзор/Планирование/Чат)
/// + центральная кнопка создания, поверх — свой `NavigationStack` (своя
/// история) на каждую вкладку — spec/SCREENS-1.md §1.1, §2.1.
/// `/inbox` не входит в состав — маршрут убран из веба (INTEGRATION.md).
///
/// Панель и меню создания — готовые компоненты `DesignSystem`
/// (`TFTabBar`/`TFCreateMenu`, `Sources/DesignSystem/Navigation/TFTabBar.swift`,
/// появились 31.08.2026 уже по ходу этой задачи) — здесь только их подключение:
/// состояние вкладки/меню, переходы, бейдж «Сегодня». Само оформление панели
/// этот файл не трогает (правило `ARCHITECTURE.md`: DesignSystem — только читать).
struct RootShellView: View {
    enum Tab: Int, CaseIterable, Hashable {
        case today, overview, upcoming, chat

        var route: AppRoute {
            switch self {
            case .today: .today
            case .overview: .overview
            case .upcoming: .upcoming
            case .chat: .chat
            }
        }

        var label: String {
            switch self {
            case .today: "Сегодня"
            case .overview: "Обзор"
            case .upcoming: "Планирование"
            case .chat: "Чат"
            }
        }

        /// Совпадает с примером в превью `TFTabBar.swift` — те же SF Symbols,
        /// что уже выбрал автор компонента (spec §2.1 иначе описывает «живую»
        /// иконку календаря с числом для «Сегодня» — кастомная отрисовка вне
        /// Волны 1, см. `NATIVE-PARTS.md`).
        var icon: String {
            switch self {
            case .today: "calendar"
            case .overview: "house"
            case .upcoming: "calendar.badge.clock"
            case .chat: "message"
            }
        }
    }

    @Environment(TaskStore.self) private var taskStore

    // spec/SCREENS-1.md §1.1: стартовый экран — «Обзор» (было «Сегодня» —
    // расходилось со спекой и заодно ломало бейдж «Сегодня» ниже: initial-
    // срабатывание onChange помечало бы его просмотренным при каждом запуске).
    @State private var selectedTab: Tab = .overview
    @State private var isCreateMenuOpen = false
    @State private var paths: [Tab: NavigationPath] = [:]
    /// Зеркало `taskflow_today_badge_seen_date` из веба (spec §2.1) —
    /// `UserDefaults` вместо `localStorage`, тот же принцип: бейдж гаснет
    /// после первого захода на «Сегодня» в текущий календарный день и не
    /// появляется заново до полуночи, даже если список задач изменился.
    @AppStorage("taskflow_today_badge_seen_date") private var todayBadgeSeenDate: String = ""

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                switch selectedTab {
                case .today: navigationStack(for: .today)
                case .overview: navigationStack(for: .overview)
                case .upcoming: navigationStack(for: .upcoming)
                case .chat: navigationStack(for: .chat)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if isCreateMenuOpen {
                // Подложка ловит тап мимо и закрывает меню БЕЗ затемнения
                // фона (spec §2.1) — почти нулевая непрозрачность вместо
                // clear, иначе `onTapGesture` не ловит касания.
                Color.black.opacity(0.0001)
                    .ignoresSafeArea()
                    .onTapGesture { isCreateMenuOpen = false }
            }

            VStack(spacing: 0) {
                if isCreateMenuOpen {
                    TFCreateMenu(items: createMenuItems)
                        .padding(.bottom, TFCreateMenuMetrics.gapAboveTabBar)
                        .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .bottom)))
                }
                TFTabBar(
                    items: tabItems,
                    selectedIndex: selectedIndexBinding,
                    isCreateMenuOpen: isCreateMenuOpen,
                    onSelect: { index in
                        if let tab = Tab(rawValue: index) { selectedTab = tab }
                    },
                    onCreateTap: { isCreateMenuOpen.toggle() }
                )
            }
        }
        .animation(.easeOut(duration: TFAnimation.createMenu), value: isCreateMenuOpen)
        .onChange(of: selectedTab, initial: true) { _, newTab in
            if newTab == .today {
                todayBadgeSeenDate = DateFormats.todayString()
            }
        }
    }

    private var tabItems: [TFTabItem] {
        Tab.allCases.map { tab in
            TFTabItem(icon: tab.icon, accessibilityLabel: tab.label, badgeCount: tab == .today ? todayBadgeCount : nil)
        }
    }

    private var selectedIndexBinding: Binding<Int?> {
        Binding(
            get: { selectedTab.rawValue },
            set: { newValue in
                if let newValue, let tab = Tab(rawValue: newValue) { selectedTab = tab }
            }
        )
    }

    /// Пункты и переходы — spec/SCREENS-1.md §2.1 (CreateMenu, 3 пункта,
    /// иконки/подписи как в превью `TFCreateMenu` — те же, что выбрал автор
    /// компонента).
    private var createMenuItems: [TFCreateMenuItem] {
        [
            TFCreateMenuItem(icon: "checkmark", title: "Задача", subtitle: "Со сроком и шагами") {
                openCreateMenuTarget(.taskForm(taskID: nil))
            },
            TFCreateMenuItem(icon: "book", title: "Заметка", subtitle: "Запись в дневнике") {
                openCreateMenuTarget(.notes)
            },
            TFCreateMenuItem(icon: "tray", title: "Проект", subtitle: "Задачи и документация") {
                openCreateMenuTarget(.projects)
            },
        ]
    }

    /// Активные задачи со сроком «сегодня» — то же условие, что у веба
    /// (`due_date === todayStr() && status === "active"`, spec §2.1).
    private var todayBadgeCount: Int {
        guard todayBadgeSeenDate != DateFormats.todayString() else { return 0 }
        return taskStore.tasks.count { $0.status == .active && $0.isDueToday }
    }

    private func navigationStack(for tab: Tab) -> some View {
        NavigationStack(path: pathBinding(for: tab)) {
            routeDestination(tab.route)
                .navigationDestination(for: AppRoute.self) { routeDestination($0) }
        }
    }

    private func pathBinding(for tab: Tab) -> Binding<NavigationPath> {
        Binding(
            get: { paths[tab] ?? NavigationPath() },
            set: { paths[tab] = $0 }
        )
    }

    private func openCreateMenuTarget(_ route: AppRoute) {
        isCreateMenuOpen = false
        paths[selectedTab, default: NavigationPath()].append(route)
    }
}
