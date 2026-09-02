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
/// Черновик быстрой задачи: `.sheet(item:)` требует `Identifiable`, а
/// `TaskFormViewModel` — общий класс формы и своего `id` не имеет.
private struct QuickAddDraft: Identifiable {
    let id = UUID()
    let viewModel: TaskFormViewModel
}

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
    /// Панель быстрого создания задачи: своя вью-модель живёт здесь, чтобы
    /// пережить переход «развернуть» в полную форму без потери введённого.
    ///
    /// Подаётся `.sheet(item:)`, а НЕ `.sheet(isPresented:)` с `if let` внутри:
    /// при втором варианте содержимое замыкания строится в той же транзакции,
    /// где вью-модель ещё `nil`, и шторка открывается пустой во весь экран
    /// (детент из пустого содержимого тоже не применяется). Проверено кадром
    /// симулятора 31.08.2026 — даже отладочный `Text` внутри `if let` не рисовался.
    @State private var quickAddDraft: QuickAddDraft?
    /// «Развернуть» из панели — полная форма с ТОЙ ЖЕ вью-моделью. Через
    /// `fullScreenCover`, а не пуш маршрута `/task/new`: маршрут строит экран
    /// заново и заводит СВОЮ вью-модель, то есть введённое в панели название,
    /// срок и выбранные файлы пропадали бы (проверено по коду `TaskFormScreen`
    /// 01.09.2026 — у него для этого есть `init(expandingFrom:)`).
    @State private var expandedDraft: QuickAddDraft?
    /// Куда переходим ПОСЛЕ закрытия панели: открыть полную форму в той же
    /// транзакции, где закрывается шторка, iOS не даёт — второе окно просто
    /// не появляется. Поэтому «развернуть» лишь запоминает вью-модель, а
    /// показ идёт из `onDismiss` (тем же приёмом сделан переход внутри
    /// `TaskFormScreen`).
    @State private var pendingExpand: TaskFormViewModel?
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

            // На чате нижней панели нет: её место занимает панель ввода
            // (владелец 01.09.2026). Выход — стрелка «назад» в шапке чата.
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
                        guard let tab = Tab(rawValue: index) else { return }
                        // Повторный тап по УЖЕ активной вкладке возвращает в её
                        // корень — как в родных приложениях. Без этого из
                        // «Проектов» нельзя было вернуться в «Обзор» тапом по
                        // самой вкладке: она уже выбрана, ничего не менялось.
                        if tab == selectedTab {
                            paths[tab] = NavigationPath()
                        } else {
                            selectedTab = tab
                        }
                    },
                    onCreateTap: { isCreateMenuOpen.toggle() }
                )
            }
            .opacity(selectedTab == .chat ? 0 : 1)
            .allowsHitTesting(selectedTab != .chat)
        }
        .environment(\.chatBackAction, {
            isCreateMenuOpen = false
            paths[.chat] = NavigationPath()
            selectedTab = .overview
        })
        .animation(.easeOut(duration: TFAnimation.createMenu), value: isCreateMenuOpen)
        .sheet(item: $quickAddDraft, onDismiss: {
            if let viewModel = pendingExpand {
                pendingExpand = nil
                expandedDraft = QuickAddDraft(viewModel: viewModel)
            }
        }) { draft in
            QuickAddTaskView(
                viewModel: draft.viewModel,
                onSaved: { quickAddDraft = nil },
                onExpand: {
                    // Развернуть — тот же незаконченный черновик, только
                    // полной формой: вью-модель передаётся как есть,
                    // введённое не теряется.
                    pendingExpand = draft.viewModel
                    quickAddDraft = nil
                }
            )
        }
        .fullScreenCover(item: $expandedDraft) { draft in
            NavigationStack {
                TaskFormScreen(expandingFrom: draft.viewModel)
            }
        }
        #if DEBUG
        // Отладочный автопереход: снять экран в симуляторе иначе нечем —
        // тапать по нему из командной строки нельзя, а показывать владельцу
        // нужно конкретный экран, а не только стартовый. Задаётся переменной
        // окружения при запуске, в релиз не попадает.
        .task {
            guard let raw = ProcessInfo.processInfo.environment["TASKFLOW_DEBUG_ROUTE"],
                  raw.isEmpty == false else { return }
            // Небольшая пауза: сторы должны успеть загрузиться, иначе экран
            // откроется пустым и кадр окажется бесполезным.
            try? await Task.sleep(for: .seconds(2))
            let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
            switch parts[0] {
            case "create":
                isCreateMenuOpen = true
            case "quickadd":
                quickAddDraft = QuickAddDraft(viewModel: TaskFormViewModel(taskID: nil))
            case "expand":
                expandedDraft = QuickAddDraft(viewModel: TaskFormViewModel(taskID: nil))
            case "task" where parts.count == 2:
                paths[selectedTab, default: NavigationPath()].append(AppRoute.taskDetail(taskID: parts[1]))
            case "notifications": paths[selectedTab, default: NavigationPath()].append(AppRoute.notifications)
            case "projects": paths[selectedTab, default: NavigationPath()].append(AppRoute.projects)
            case "settings": paths[selectedTab, default: NavigationPath()].append(AppRoute.settings)
            case "notes": paths[selectedTab, default: NavigationPath()].append(AppRoute.notes)
            case "noteeditor" where parts.count == 2:
                paths[selectedTab, default: NavigationPath()].append(AppRoute.noteEditor(noteID: parts[1]))
            case "today": selectedTab = .today
            case "upcoming": selectedTab = .upcoming
            case "chat": selectedTab = .chat
            default: break
            }
        }
        #endif
        .onChange(of: selectedTab, initial: true) { _, newTab in
            if newTab == .today {
                todayBadgeSeenDate = DateFormats.todayString()
            }
        }
    }

    private var tabItems: [TFTabItem] {
        Tab.allCases.map { tab in
            TFTabItem(icon: tab.icon, accessibilityLabel: tab.label, badgeCount: tab == .today ? todayBadgeCount : nil, showsTodayDate: tab == .today)
        }
    }

    private var selectedIndexBinding: Binding<Int?> {
        Binding(
            get: { selectedTab.rawValue },
            set: { newValue in
                if let newValue, let tab = Tab(rawValue: newValue) {
                    selectedTab = tab
                }
            }
        )
    }

    /// Пункты и переходы — spec/SCREENS-1.md §2.1 (CreateMenu, 3 пункта,
    /// иконки/подписи как в превью `TFCreateMenu` — те же, что выбрал автор
    /// компонента).
    private var createMenuItems: [TFCreateMenuItem] {
        [
            TFCreateMenuItem(icon: "checkmark", title: "Задача", subtitle: "Со сроком и шагами") {
                // Задача заводится компактной панелью над клавиатурой, а не
                // полноэкранным бланком: владелец так и просил — нажал «плюс»,
                // написал название, сохранил. Полная форма остаётся за кнопкой
                // «развернуть» внутри самой панели.
                isCreateMenuOpen = false
                quickAddDraft = QuickAddDraft(viewModel: TaskFormViewModel(taskID: nil))
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
