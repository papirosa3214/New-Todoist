import SwiftUI
import EventKit
import Observation

/// Вью-модель `IntegrationsScreen` — статус Google (сервер), права/списки
/// Apple (`EventKit`, устройство). Контракты — `GoogleIntegrationsAPI.swift`/
/// `AppleEventKitAccess.swift`, поведение — `src/screens/IntegrationsScreen.tsx`
/// (спека §14 не даёт нужной детали, ARCHITECTURE.md п.3 разрешает читать код).
@MainActor
@Observable
final class IntegrationsViewModel {
    private let apiClient = APIClient()

    var status: IntegrationStatusResponse?
    var isStatusLoading = true
    var googleLists: [GoogleTaskListItem] = []
    var isGoogleListsLoading = false
    var googleCalendars: [GoogleCalendarInfo] = []
    var isGoogleCalendarsLoading = false

    var calPermGranted = AppleEventKitAccess.calendarGranted()
    var remPermGranted = AppleEventKitAccess.remindersGranted()
    var appleCalendars: [EKCalendar] = []
    var appleReminderLists: [EKCalendar] = []
    var selectedAppleCalendarIds: Set<String> = Set(IntegrationsLocalPrefs.appleCalendarIds())
    var selectedGoogleCalendarIds: Set<String> = Set(IntegrationsLocalPrefs.googleCalendarIds())
    var selectedReminderListId: String? = IntegrationsLocalPrefs.reminderListId()

    var isGoogleAuthorizing = false
    var isGoogleSyncing = false
    var isGoogleDisconnecting = false
    var isAppleSyncing = false

    var errorMessage: String?
    var successMessage: String?

    var googleConnected: Bool { status?.google.connected ?? false }

    func loadAppleState() {
        calPermGranted = AppleEventKitAccess.calendarGranted()
        remPermGranted = AppleEventKitAccess.remindersGranted()
        if calPermGranted { appleCalendars = AppleEventKitAccess.calendars() }
        if remPermGranted {
            appleReminderLists = AppleEventKitAccess.reminderLists()
            if selectedReminderListId == nil, let first = defaultReminderList(appleReminderLists) {
                selectedReminderListId = first.calendarIdentifier
                IntegrationsLocalPrefs.setReminderListId(first.calendarIdentifier)
            }
        }
    }

    private func defaultReminderList(_ lists: [EKCalendar]) -> EKCalendar? {
        lists.first { $0.calendarIdentifier == AppleEventKitAccess.store.defaultCalendarForNewReminders()?.calendarIdentifier } ?? lists.first
    }

    func loadGoogleStatus() async {
        isStatusLoading = true
        defer { isStatusLoading = false }
        do {
            status = try await apiClient.integrationsStatus()
        } catch {
            // Молчаливо: статус недоступен — секции покажут «Проверка…»/«Импорт задач»,
            // отдельного баннера под это в вебе тоже нет.
        }
        await loadGoogleListsIfNeeded()
        await loadGoogleCalendarsIfNeeded()
    }

    func loadGoogleListsIfNeeded() async {
        guard googleConnected else { return }
        isGoogleListsLoading = true
        defer { isGoogleListsLoading = false }
        googleLists = (try? await apiClient.googleTaskLists()) ?? []
    }

    func loadGoogleCalendarsIfNeeded() async {
        guard googleConnected else { return }
        isGoogleCalendarsLoading = true
        defer { isGoogleCalendarsLoading = false }
        googleCalendars = (try? await apiClient.googleCalendars()) ?? []
    }

    // MARK: - Apple Календарь

    func requestCalendarAccess() async {
        errorMessage = nil
        let granted = await AppleEventKitAccess.requestCalendarAccess()
        calPermGranted = AppleEventKitAccess.calendarGranted()
        if granted {
            appleCalendars = AppleEventKitAccess.calendars()
            let allIds = Set(appleCalendars.map(\.calendarIdentifier))
            selectedAppleCalendarIds = allIds
            IntegrationsLocalPrefs.setAppleCalendarIds(Array(allIds))
        } else if !calPermGranted {
            errorMessage = "Доступ к Apple Календарю не выдан. Проверьте разрешение в Настройках iPhone."
        }
    }

    func toggleAppleCalendar(_ id: String) {
        if selectedAppleCalendarIds.contains(id) {
            selectedAppleCalendarIds.remove(id)
        } else {
            selectedAppleCalendarIds.insert(id)
        }
        IntegrationsLocalPrefs.setAppleCalendarIds(Array(selectedAppleCalendarIds))
    }

    // MARK: - Apple Напоминания

    func requestRemindersAccess() async {
        errorMessage = nil
        let granted = await AppleEventKitAccess.requestRemindersAccess()
        remPermGranted = AppleEventKitAccess.remindersGranted()
        if granted {
            appleReminderLists = AppleEventKitAccess.reminderLists()
            if let first = defaultReminderList(appleReminderLists) {
                selectedReminderListId = first.calendarIdentifier
                IntegrationsLocalPrefs.setReminderListId(first.calendarIdentifier)
            }
        } else if !remPermGranted {
            errorMessage = "Доступ к Apple Напоминаниям не выдан. Проверьте разрешение в Настройках iPhone."
        }
    }

    func selectReminderList(_ id: String) {
        selectedReminderListId = id
        IntegrationsLocalPrefs.setReminderListId(id)
    }

    func syncAppleReminders(taskStore: TaskStore, projectStore: ProjectStore) async {
        errorMessage = nil
        isAppleSyncing = true
        defer { isAppleSyncing = false }

        var appleProjectId = projectStore.projects.first { $0.name == "Apple Напоминания" }?.id
        if appleProjectId == nil {
            appleProjectId = await projectStore.create(name: "Apple Напоминания", color: "#FF9500")?.id
        }

        let list = appleReminderLists.first { $0.calendarIdentifier == selectedReminderListId }
        let result = await AppleRemindersSync.syncAll(
            tasks: taskStore.tasks, list: list, taskStore: taskStore, defaultProjectId: appleProjectId
        )
        successMessage = "Синхронизация Apple Напоминаний: добавлено в TaskFlow: \(result.imported), отправлено в Apple: \(result.exported), обновлено: \(result.updated)"
        scheduleSuccessClear()
    }

    // MARK: - Google

    func toggleGoogleCalendar(_ id: String) {
        if selectedGoogleCalendarIds.contains(id) {
            selectedGoogleCalendarIds.remove(id)
        } else {
            selectedGoogleCalendarIds.insert(id)
        }
        IntegrationsLocalPrefs.setGoogleCalendarIds(Array(selectedGoogleCalendarIds))
    }

    func connectGoogle() async {
        errorMessage = nil
        isGoogleAuthorizing = true
        defer { isGoogleAuthorizing = false }
        do {
            let authURL = try await apiClient.googleAuthURL(redirectURI: GoogleOAuth.redirectURI)
            guard let url = URL(string: authURL.url) else { throw APIError.invalidResponse }
            let code = try await GoogleOAuth.authorize(url: url)
            let result = try await apiClient.googleCallback(code: code, redirectURI: GoogleOAuth.redirectURI)
            successMessage = "Google аккаунт \(result.email ?? "") успешно подключён!"
            scheduleSuccessClear()
            await loadGoogleStatus()
        } catch is CancellationError {
            // Пользователь закрыл окно входа — не ошибка.
        } catch {
            errorMessage = "Ошибка подключения Google: \(Self.message(error))"
        }
    }

    func disconnectGoogle() async {
        errorMessage = nil
        isGoogleDisconnecting = true
        defer { isGoogleDisconnecting = false }
        do {
            _ = try await apiClient.googleDisconnect()
            await loadGoogleStatus()
        } catch {
            errorMessage = "Ошибка отключения Google: \(Self.message(error))"
        }
    }

    func syncGoogle() async {
        errorMessage = nil
        isGoogleSyncing = true
        defer { isGoogleSyncing = false }
        do {
            let listId = status?.google.settings.listId ?? "@default"
            let result = try await apiClient.googleSync(listId: listId)
            successMessage = "Google Задачи: импортировано \(result.imported), обновлено \(result.updated) (всего \(result.totalGoogleTasks))"
            scheduleSuccessClear()
            await loadGoogleStatus()
        } catch {
            errorMessage = "Ошибка синхронизации Google: \(Self.message(error))"
        }
    }

    func selectGoogleList(_ id: String) async {
        _ = try? await apiClient.updateGoogleListId(id)
        await loadGoogleStatus()
    }

    private func scheduleSuccessClear() {
        let current = successMessage
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if successMessage == current { successMessage = nil }
        }
    }

    private static func message(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

/// `/settings/integrations` — spec/SCREENS-2.md §14. Четыре аккордеона:
/// Apple Календарь/Напоминания (`EventKit`, устройство), Google Задачи/
/// Календарь (сервер, `GoogleIntegrationsAPI.swift`).
///
/// ⚠️ Живой сервер — только чтение (граница задачи): код ниже реализует
/// подключение/синхронизацию/отключение по-настоящему (иначе владелец не
/// сможет ими пользоваться), но при проверке этой задачи ни одна из
/// мутирующих кнопок не нажималась — только компиляция и сверка со спекой/
/// скриншотом (см. отчёт).
struct IntegrationsScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(TaskStore.self) private var taskStore
    @Environment(ProjectStore.self) private var projectStore

    @State private var viewModel = IntegrationsViewModel()
    @State private var isAppleCalOpen = false
    @State private var isAppleRemOpen = false
    @State private var isGoogleTasksOpen = true // веб-дефолт: этот аккордеон открыт сразу
    @State private var isGoogleCalOpen = false

    var body: some View {
        VStack(spacing: 0) {
            TFScreenHeader("Интеграции", variant: .compact, leading: { AnyView(backButton) })
            ScrollView {
                VStack(alignment: .leading, spacing: TFSpacing.lg) {
                    TFErrorBanner(viewModel.errorMessage, variant: .block)
                    if let successMessage = viewModel.successMessage {
                        successBanner(successMessage)
                    }
                    appleSection
                    googleSection
                }
                .padding(.horizontal, TFSpacing.screenHorizontal)
                .padding(.top, TFSpacing.sm)
                .padding(.bottom, TFSpacing.xl * 2)
            }
        }
        // Своя шапка уже несёт заголовок и кнопку «назад» — системный навбар
        // поверх неё давал ВТОРУЮ стрелку и лишнюю полосу.
        // Нативная сворачивающаяся шапка.
        .navigationTitle("Интеграции")
        .navigationBarTitleDisplayMode(.large)
        .background(Color.tfBackground)
        .task {
            viewModel.loadAppleState()
            await viewModel.loadGoogleStatus()
        }
    }

    private var backButton: some View {
        Button(action: { dismiss() }) {
            Image(systemName: "chevron.left")
                .font(.system(size: 18))
                .foregroundStyle(Color.tfText)
                .frame(width: TFHitTarget.min, height: TFHitTarget.min)
        }
        .buttonStyle(TFTapScaleStyle())
    }

    private func successBanner(_ text: String) -> some View {
        HStack(spacing: TFSpacing.sm) {
            Image(systemName: "checkmark").font(.system(size: 16)).foregroundStyle(Color.tfTeal)
            Text(text).tfText(.action).foregroundStyle(Color.tfTeal)
        }
        .padding(TFSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.tfCard)
        .overlay(RoundedRectangle(cornerRadius: TFRadius.xl).strokeBorder(Color.tfTeal.opacity(0.3), lineWidth: TFBorder.width))
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }

    // MARK: - Apple Экосистема (iOS)

    private var appleSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            SettingsCapsLabel("Apple Экосистема (iOS)")
            appleCalendarAccordion
            appleRemindersAccordion
        }
    }

    private var appleCalendarAccordion: some View {
        IntegrationAccordionCard(
            icon: "calendar", iconTint: .tfRed, title: "Apple Календарь",
            subtitle: appleCalendarSubtitle,
            badge: viewModel.calPermGranted ? "Включён" : nil,
            isExpanded: $isAppleCalOpen
        ) {
            if !viewModel.calPermGranted {
                TFButton("Разрешить доступ к Apple Календарю", variant: .primary) {
                    Task { await viewModel.requestCalendarAccess() }
                }
            } else if viewModel.appleCalendars.isEmpty {
                Text("Календари не найдены").tfText(.action).foregroundStyle(Color.tfSub)
            } else {
                Text("Отображать календари в расписании:").tfText(.caption).fontWeight(.medium).foregroundStyle(Color.tfSub)
                VStack(spacing: 0) {
                    ForEach(viewModel.appleCalendars, id: \.calendarIdentifier) { calendar in
                        CalendarCheckRow(
                            color: Color(cgColor: calendar.cgColor),
                            title: calendar.title,
                            isChecked: viewModel.selectedAppleCalendarIds.isEmpty || viewModel.selectedAppleCalendarIds.contains(calendar.calendarIdentifier),
                            action: { viewModel.toggleAppleCalendar(calendar.calendarIdentifier) }
                        )
                    }
                }
                .padding(TFSpacing.xs)
                .background(Color.tfCard2.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }
        }
    }

    private var appleCalendarSubtitle: String {
        guard viewModel.calPermGranted else { return "Требуется разрешение" }
        guard !viewModel.appleCalendars.isEmpty else { return "Доступ открыт" }
        let count = viewModel.selectedAppleCalendarIds.isEmpty ? "все" : "\(viewModel.selectedAppleCalendarIds.count)"
        return "Выбрано: \(count) из \(viewModel.appleCalendars.count)"
    }

    private var appleRemindersAccordion: some View {
        IntegrationAccordionCard(
            icon: "checklist", iconTint: .tfOrange, title: "Apple Напоминания",
            subtitle: viewModel.remPermGranted ? "Двусторонняя синхронизация задач" : "Требуется разрешение",
            badge: viewModel.remPermGranted ? "Включён" : nil,
            isExpanded: $isAppleRemOpen
        ) {
            if !viewModel.remPermGranted {
                TFButton("Разрешить доступ к Apple Напоминаниям", variant: .primary) {
                    Task { await viewModel.requestRemindersAccess() }
                }
            } else {
                if !viewModel.appleReminderLists.isEmpty {
                    listPicker(
                        label: "Список Apple Напоминаний:",
                        options: viewModel.appleReminderLists.map { ($0.calendarIdentifier, $0.title) },
                        selectedId: viewModel.selectedReminderListId ?? "",
                        onSelect: { viewModel.selectReminderList($0) }
                    )
                }
                TFButton(
                    viewModel.isAppleSyncing ? "Синхронизация..." : "Синхронизировать сейчас",
                    icon: "arrow.triangle.2.circlepath", variant: .secondary, isEnabled: !viewModel.isAppleSyncing
                ) {
                    Task { await viewModel.syncAppleReminders(taskStore: taskStore, projectStore: projectStore) }
                }
            }
        }
    }

    // MARK: - Google Сервисы

    private var googleSection: some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            SettingsCapsLabel("Google Сервисы")
            googleTasksAccordion
            googleCalendarAccordion
        }
    }

    private var googleTasksAccordion: some View {
        IntegrationAccordionCard(
            icon: "tag", iconTint: .tfBlue, title: "Google Задачи",
            subtitle: googleTasksSubtitle,
            badge: viewModel.googleConnected ? "В сети" : nil,
            isExpanded: $isGoogleTasksOpen
        ) {
            if !viewModel.googleConnected {
                TFButton(viewModel.isGoogleAuthorizing ? "Формирование ссылки..." : "Войти через Google", variant: .primary, isEnabled: !viewModel.isGoogleAuthorizing) {
                    Task { await viewModel.connectGoogle() }
                }
            } else {
                if viewModel.isGoogleListsLoading {
                    Text("Загрузка списков задач...").tfText(.action).foregroundStyle(Color.tfSub)
                } else if !viewModel.googleLists.isEmpty {
                    listPicker(
                        label: "Список Google Tasks:",
                        options: [("@default", "Основной список (@default)")] + viewModel.googleLists.map { ($0.id, $0.title) },
                        selectedId: viewModel.status?.google.settings.listId ?? "@default",
                        onSelect: { id in Task { await viewModel.selectGoogleList(id) } }
                    )
                }
                HStack(spacing: TFSpacing.sm) {
                    TFButton(viewModel.isGoogleSyncing ? "Синхронизация..." : "Синхронизировать", icon: "arrow.triangle.2.circlepath", variant: .secondary, isEnabled: !viewModel.isGoogleSyncing) {
                        Task { await viewModel.syncGoogle() }
                    }
                    disconnectButton
                }
                if let lastSyncedAt = viewModel.status?.google.lastSyncedAt, let date = DateFormats.sqliteUTC(lastSyncedAt) {
                    Text("Последняя синхронизация: \(Self.syncDateFormatter.string(from: date))")
                        .tfText(.caption).foregroundStyle(Color.tfDim)
                        .frame(maxWidth: .infinity, alignment: .center)
                }
            }
        }
    }

    /// Отключение Google — общая кнопка для обоих аккордеонов (Задачи и
    /// Календарь): учётка в интеграции одна, отключение у сервера тоже одно
    /// (`googleDisconnect`), поэтому и кнопка одна на две секции.
    private var disconnectButton: some View {
        TFButton(
            viewModel.isGoogleDisconnecting ? "Отключение..." : "Отключить",
            icon: "xmark.circle",
            variant: .secondary,
            isEnabled: !viewModel.isGoogleDisconnecting
        ) {
            Task { await viewModel.disconnectGoogle() }
        }
    }

    private var googleTasksSubtitle: String {
        if viewModel.isStatusLoading { return "Проверка..." }
        if viewModel.googleConnected { return viewModel.status?.google.email ?? "Аккаунт подключён" }
        return "Импорт задач и списков"
    }

    private var googleCalendarAccordion: some View {
        IntegrationAccordionCard(
            icon: "calendar", iconTint: .tfBlue, title: "Google Календарь",
            subtitle: googleCalendarSubtitle,
            badge: viewModel.googleConnected ? "В сети" : nil,
            isExpanded: $isGoogleCalOpen
        ) {
            if !viewModel.googleConnected {
                TFButton(viewModel.isGoogleAuthorizing ? "Формирование ссылки..." : "Войти через Google", variant: .primary, isEnabled: !viewModel.isGoogleAuthorizing) {
                    Task { await viewModel.connectGoogle() }
                }
            } else if viewModel.isGoogleCalendarsLoading {
                Text("Загрузка календарей Google...").tfText(.action).foregroundStyle(Color.tfSub)
            } else if !viewModel.googleCalendars.isEmpty {
                Text("Отображать календари Google:").tfText(.caption).fontWeight(.medium).foregroundStyle(Color.tfSub)
                VStack(spacing: 0) {
                    ForEach(viewModel.googleCalendars) { calendar in
                        CalendarCheckRow(
                            color: calendar.backgroundColor.map(Color.init(hex:)) ?? Color(hex: "#4285F4"),
                            title: calendar.primary == true ? "\(calendar.summary) (Основной)" : calendar.summary,
                            isChecked: viewModel.selectedGoogleCalendarIds.isEmpty || viewModel.selectedGoogleCalendarIds.contains(calendar.id),
                            action: { viewModel.toggleGoogleCalendar(calendar.id) }
                        )
                    }
                }
                .padding(TFSpacing.xs)
                .background(Color.tfCard2.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            } else {
                Text("Календари не найдены или нет доступа").tfText(.action).foregroundStyle(Color.tfSub)
            }
        }
    }

    private var googleCalendarSubtitle: String {
        guard viewModel.googleConnected else { return "Требуется вход с Google" }
        guard !viewModel.googleCalendars.isEmpty else { return "События в Предстоящем и Сегодня" }
        let count = viewModel.selectedGoogleCalendarIds.isEmpty ? "все" : "\(viewModel.selectedGoogleCalendarIds.count)"
        return "Выбрано: \(count) из \(viewModel.googleCalendars.count)"
    }

    /// Замена HTML `<select>` — нативный `Menu`, тап показывает системный
    /// список пунктов (ближайший честный эквивалент выпадающего списка на iOS).
    private func listPicker(label: String, options: [(id: String, title: String)], selectedId: String, onSelect: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.xs) {
            Text(label).tfText(.caption).foregroundStyle(Color.tfSub)
            Menu {
                ForEach(options, id: \.id) { option in
                    Button(option.title) { onSelect(option.id) }
                }
            } label: {
                HStack {
                    Text(options.first { $0.id == selectedId }?.title ?? selectedId)
                        .tfText(.action).foregroundStyle(Color.tfText).lineLimit(1)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 11)).foregroundStyle(Color.tfDim)
                }
                .padding(.horizontal, TFSpacing.md)
                .frame(height: 40)
                .background(Color.tfCard2)
                .overlay(RoundedRectangle(cornerRadius: TFRadius.lg).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width))
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
            }
        }
    }

    private static let syncDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.timeZone = TimeZone(identifier: "Europe/Moscow")
        formatter.dateFormat = "dd.MM.yyyy, HH:mm:ss"
        return formatter
    }()
}

// MARK: - Аккордеон-карточка (Apple Календарь/Напоминания, Google Задачи/Календарь)

private struct IntegrationAccordionCard<Content: View>: View {
    let icon: String
    let iconTint: Color
    let title: String
    let subtitle: String
    let badge: String?
    @Binding var isExpanded: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: TFDuration.fast)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: TFSpacing.md) {
                    RoundedRectangle(cornerRadius: TFRadius.md)
                        .fill(iconTint.opacity(0.15))
                        .frame(width: 32, height: 32)
                        .overlay { Image(systemName: icon).font(.system(size: 15)).foregroundStyle(iconTint) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).tfText(.body).fontWeight(.medium).foregroundStyle(Color.tfText)
                        Text(subtitle).tfText(.action).foregroundStyle(Color.tfSub).lineLimit(1)
                    }
                    Spacer()
                    if let badge {
                        Text(badge).tfText(.caption).fontWeight(.medium).foregroundStyle(Color.tfTeal)
                            .padding(.horizontal, TFSpacing.sm).padding(.vertical, 2)
                            .background(Color.tfTeal.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
                    }
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 13)).foregroundStyle(Color.tfSub)
                }
                .padding(TFSpacing.md)
                .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())

            if isExpanded {
                TFDivider(dimmed: true)
                VStack(alignment: .leading, spacing: TFSpacing.sm) { content() }
                    .padding(TFSpacing.md)
                    .background(Color.tfCard2.opacity(0.3))
            }
        }
        .background(Color.tfCard)
        .overlay(RoundedRectangle(cornerRadius: TFRadius.xl).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width))
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
    }
}

/// Строка-чекбокс календаря — цветной кружок + название + галочка при выборе
/// (spec §14, скриншот `settings-integrations.png`).
private struct CalendarCheckRow: View {
    let color: Color
    let title: String
    let isChecked: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: TFSpacing.sm) {
                Circle().fill(color).frame(width: 10, height: 10)
                Text(title).tfText(.action).foregroundStyle(Color.tfText).lineLimit(1)
                Spacer()
                if isChecked {
                    Image(systemName: "checkmark").font(.system(size: 12)).foregroundStyle(Color.tfRed)
                }
            }
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, TFSpacing.xs + 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }
}
