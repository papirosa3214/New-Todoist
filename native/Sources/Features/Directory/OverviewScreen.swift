import SwiftUI

// «Обзор» — spec/SCREENS-1.md §5.3, `/overview`, стартовый экран. Числа и
// цвета сняты с живого `src/screens/OverviewScreen.tsx` (спека сама не
// расписывает точные цвета/иконки сетки 2×2 — только состав).
//
// Состояний загрузки/ошибки НАРОЧНО нет (спека прямо это оговаривает):
// счётчики читаются из уже прогретого `TaskStore.tasks`, пока кэш пуст —
// молча показывают 0.
struct OverviewScreen: View {
    @Environment(TaskStore.self) private var taskStore

    /// Поиск открывается кнопкой в шапке, а не пунктом навигации, поэтому
    /// ему нужен свой флаг: `NavigationLink(value:)` требует собственный
    /// тап-лейбл, а здесь тап уже съеден кнопкой шапки.
    @State private var searchOpen = false

    /// «Сводка недели» — модалка `WeeklySummaryModal` вне зоны этого экрана
    /// (не входит в список экранов задачи), тап оставлен инертным.
    /// В отчёте — оркестратору, кто и когда возьмёт эту модалку.
    var body: some View {
        ScrollView {
            VStack(spacing: TFSpacing.md) {
                statusGrid
                weeklySummaryCard
                VStack(spacing: TFSpacing.sm) {
                    navCard(route: .projects, icon: "tray", tint: .tfRed,
                            title: "Проекты", subtitle: "Задачи по проектам и документация")
                    navCard(route: .notifications, icon: "bell", tint: Color(hex: "#f59e0b"),
                            title: "Уведомления", subtitle: "История событий и напоминаний")
                    navCard(route: .activity, icon: "waveform.path.ecg", tint: Color(hex: "#4a9fd8"),
                            title: "Активность и статистика", subtitle: "Графики продуктивности и выполненные задачи")
                    navCard(route: .settings, icon: "gearshape", tint: .white.opacity(0.7),
                            title: "Настройки", subtitle: "Профиль, ИИ, сервер и внешний вид")
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.top, TFSpacing.sm)
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Штатная SwiftUI-шапка. Кнопка поиска переехала из
        // самодельного TFScreenHeader в `.toolbar { .topBarTrailing }` —
        // дубль заголовка «Обзор» (системный + наш поверх) ушёл.
        // `toolbarTitleDisplayMode(.large)` — iOS 17+ (кросс-платформенный
        // аналог `navigationBarTitleDisplayMode`, тот депрекейтнут на iOS 27).
        .navigationTitle("Обзор")
        .toolbarTitleDisplayMode(.large)
        // Штатный фон навбара — замена кастомного `FrostedGlass`.
        // `toolbarBackground(_:for:)` с Material — iOS 16.0+; `.automatic`
        // фон виден только когда контент заехал под навбар (та самая
        // механика, которую раньше давал наш blur с масками).
        .toolbarBackground(.ultraThinMaterial, for: .navigationBar)
        .toolbarBackgroundVisibility(.automatic, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    searchOpen = true
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .accessibilityLabel("Поиск")
                .accessibilityIdentifier("overview.search")
            }
        }
        // Кнопка в шапке — обработчик без своего Label-контейнера, поэтому
        // переход не через `NavigationLink(value:)` (тому нужен собственный
        // тап-лейбл), а через локальный `navigationDestination(isPresented:)`
        // на свой же экран поиска — тот же пункт таблицы маршрутов
        // (`SearchScreen`, INTEGRATION.md), просто без похода через общий
        // `routeDestination` в `Sources/App/`.
        // Экран поиска берём из общей фабрики маршрутов, а не создаём тип
        // напрямую: пока экран не написан, фабрика отдаёт заглушку, и
        // «Обзор» от этого не ломается.
        .navigationDestination(isPresented: $searchOpen) { routeDestination(.search) }
    }

    // MARK: - Сетка 2×2 статусов агентов — числа считаются на клиенте (spec §5.3)

    private var statusGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: TFSpacing.sm), GridItem(.flexible())], spacing: TFSpacing.sm) {
            statusTile(route: .agentWork, title: "В работе", count: workingCount,
                       icon: "waveform.path.ecg", tint: .tfBlue, bgOpacity: 0.15)
            statusTile(route: .agentWork, title: "На проверке", count: reviewCount,
                       icon: "checkmark", tint: Color(hex: "#fbbf24"), bgOpacity: 0.15)
            statusTile(route: .agentWork, title: "Заблокированы", count: blockedCount,
                       icon: "flag", tint: .tfCoral, bgOpacity: 0.20)
            statusTile(route: .agentWork, title: "Пропали", count: staleCount,
                       icon: "cpu", tint: .tfCoral, bgOpacity: 0.20)
        }
    }

    private func statusTile(route: AppRoute, title: String, count: Int, icon: String, tint: Color, bgOpacity: Double) -> some View {
        let active = count > 0
        return NavigationLink(value: route) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .tfText(.caption)
                        .foregroundStyle(Color.tfSub)
                        .lineLimit(1)
                    Text("\(count)")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(active ? tint : Color.tfText)
                }
                Spacer(minLength: 0)
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .foregroundStyle(active ? tint : Color.tfDim)
            }
            .padding(TFSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(active ? tint.opacity(bgOpacity) : Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        }
        .buttonStyle(TFTapScaleStyle())
    }

    // MARK: - Сводка недели

    private var weeklySummaryCard: some View {
        Button {
            // Инертно — WeeklySummaryModal не входит в мою зону экранов.
        } label: {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: TFRadius.lg)
                    .fill(LinearGradient(colors: [Color(hex: "#FF2D55"), Color(hex: "#FF9500")], startPoint: .bottomLeading, endPoint: .topTrailing))
                    .frame(width: 36, height: 36)
                    .overlay {
                        Image(systemName: "brain.head.profile")
                            .font(.system(size: 18))
                            .foregroundStyle(.white)
                    }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: TFSpacing.sm) {
                        Text("Сводка недели")
                            .tfText(.body)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.tfText)
                        TFAccentTag("SECOND BRAIN", color: Color(hex: "#FF2D55"))
                    }
                    Text("Победы, хвосты и фокус на цели недели")
                        .tfText(.caption)
                        .foregroundStyle(Color.tfSub)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.tfDim)
            }
            .padding(TFSpacing.lg)
            .background(Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        }
        .buttonStyle(TFTapRowStyle())
    }

    private func navCard(route: AppRoute, icon: String, tint: Color, title: String, subtitle: String) -> some View {
        NavigationLink(value: route) {
            HStack(spacing: TFSpacing.md) {
                RoundedRectangle(cornerRadius: TFRadius.lg)
                    .fill(tint.opacity(0.15))
                    .frame(width: 32, height: 32)
                    .overlay {
                        Image(systemName: icon)
                            .tfText(.input)
                            .foregroundStyle(tint)
                    }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .tfText(.body)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.tfText)
                    Text(subtitle)
                        .tfText(.caption)
                        .foregroundStyle(Color.tfSub)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.tfDim)
            }
            .padding(TFSpacing.lg)
            .background(Color.tfCard)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        }
        .buttonStyle(TFTapRowStyle())
    }

    // Кнопка поиска в шапке — тоже переход по маршруту, но actions
    // TFScreenHeader ждёт обработчик, не value-ссылку, поэтому здесь
    // отдельный @State-флаг + скрытый NavigationLink(isActive:) современный
    // эквивалент — value-based navigationDestination тоже слушает push
    // программно через тот же механизм с помощью `NavigationLink(value:)`,
    // но у кнопки шапки нет своего Label-контейнера для него, поэтому
    // прокладываем переход через отдельный invisible link.
    @State private var searchPushed = false
    private func navigateToSearch() { searchPushed = true }

    private var workingCount: Int {
        taskStore.tasks.count { $0.status == .active && $0.agentState == .inProgress && $0.agentStale != true }
    }
    private var reviewCount: Int {
        taskStore.tasks.count { $0.status == .active && $0.agentState == .review }
    }
    private var blockedCount: Int {
        taskStore.tasks.count { $0.status == .active && $0.agentState == .blocked }
    }
    private var staleCount: Int {
        taskStore.tasks.count { $0.agentState == .inProgress && $0.agentStale == true }
    }
}
