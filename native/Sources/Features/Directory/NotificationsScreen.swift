import SwiftUI

// «Уведомления» — spec/SCREENS-2.md §13, `/notifications`. Список читаю из
// общего `NotificationStore` (Environment) — прогрет при старте приложения
// и живёт по WS-событию `notification:new`, единый источник истины.
//
// ⚠️ Мутации — НЕ через `NotificationStore.markRead`. Проверено чтением
// живого `server/src/routes/notifications.ts` (только чтение, спека сама
// путей не даёт): реальные роуты — `PATCH /notifications/:id/read` (БЕЗ
// тела), `POST /notifications/read-all`, `DELETE /notifications/:id`.
// `Core/Networking/APIClient+Notifications.swift.markNotificationRead` шлёт
// `PATCH /notifications/:id` С телом `{read:true}` — такого маршрута на
// сервере нет вовсе, запрос получит 404. Использую вместо него
// `directoryMarkNotificationRead`/`directoryMarkAllNotificationsRead` из
// `Support/DirectoryAPI.swift` (уже заведены параллельным исполнителем по
// той же причине) и после успеха перезагружаю стор целиком (`load()`,
// публичный метод) — стор не даёт точечно поправить один элемент
// (`notifications` — `private(set)`), а трогать чужой файл нельзя.
// `deleteNotification` в Core адресом верен — используется как есть.
//
// В отчёте оркестратору: `NotificationStore` стоит обзавестись реальными
// `markRead`/`markAllRead`/`delete` с точечным обновлением массива — иначе
// каждое действие здесь стоит полного рефетча уведомлений.
struct NotificationsScreen: View {
    @Environment(NotificationStore.self) private var notificationStore

    @State private var route: AppRoute?
    @State private var isMarkingAllRead = false
    @State private var markAllErrorMessage: String?
    @State private var rowErrors: [String: String] = [:]

    private let apiClient = APIClient()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: TFSpacing.sm) {
                TFErrorBanner(notificationStore.errorMessage, variant: .inline)
                TFErrorBanner(markAllErrorMessage, variant: .inline)

                if notificationStore.notifications.isEmpty {
                    TFEmptyState(text: "Уведомлений пока нет").padding(.top, TFSpacing.xl)
                } else {
                    TFCard(padding: 0) {
                        VStack(spacing: 0) {
                            ForEach(Array(notificationStore.notifications.enumerated()), id: \.element.id) { idx, n in
                                notificationRow(n)
                                if idx < notificationStore.notifications.count - 1 { TFDivider() }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, TFSpacing.screenHorizontal)
            .padding(.top, TFSpacing.md)
            .padding(.bottom, TFSpacing.xl)
        }
        .background(Color.tfBackground)
        // Своя кнопка «назад» уже есть в шапке; без скрытия системного навбара
        // на экране два значка «назад» (владелец 01.09.2026).
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .navigationDestination(item: $route) { routeDestination($0) }
        .task { await notificationStore.load() }
    }

    // MARK: - Шапка (кастомная — нужна текстовая кнопка справа, `TFHeaderAction` только иконки)

    private var header: some View {
        ZStack {
            HStack {
                DirectoryBackButton()
                Spacer()
                Button {
                    Task { await markAllRead() }
                } label: {
                    Text("Прочитать все").tfText(.action).foregroundStyle(Color.tfSub)
                }
                .buttonStyle(TFTapFadeStyle())
                .disabled(isMarkingAllRead || allRead)
                .opacity((isMarkingAllRead || allRead) ? 0.4 : 1)
            }
            Text("Уведомления").tfText(.title).foregroundStyle(Color.tfText).lineLimit(1).allowsHitTesting(false)
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
        .frame(height: 48)
        // Тот же фон, что у шапок остальных экранов: `.ultraThinMaterial`
        // выбивался — он светлее и не совпадал с подложкой приложения.
        .background(FrostedGlass(axis: .top).ignoresSafeArea(edges: .top))
    }

    private var allRead: Bool { notificationStore.notifications.allSatisfy(\.read) }

    // MARK: - Строка уведомления

    private func notificationRow(_ n: ApiNotification) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: TFSpacing.md) {
                avatar(n)

                Button {
                    Task { await open(n) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(n.text ?? "").tfText(.row).foregroundStyle(Color.tfText)
                        if let title = n.taskTitle, !title.isEmpty {
                            Text(title).tfText(.action).foregroundStyle(Color.tfSub).lineLimit(1)
                        }
                        Text(dateLine(n)).tfText(.meta).foregroundStyle(Color.tfDim)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(TFTapRowStyle())

                HStack(spacing: TFSpacing.xs) {
                    if !n.read {
                        Circle().fill(Color.tfRed).frame(width: 8, height: 8)
                    }
                    Button {
                        Task { await delete(n) }
                    } label: {
                        Image(systemName: "trash").font(.system(size: 18)).foregroundStyle(Color.tfDim)
                            .frame(width: TFHitTarget.min, height: TFHitTarget.min)
                    }
                    .buttonStyle(TFTapScaleStyle())
                }
            }
            if let error = rowErrors[n.id] {
                TFErrorBanner(error, variant: .inline).padding(.leading, 36 + TFSpacing.md)
            }
        }
        .padding(.horizontal, TFSpacing.md)
        .padding(.vertical, TFSpacing.sm + 2)
    }

    @ViewBuilder
    private func avatar(_ n: ApiNotification) -> some View {
        let hasActor = n.actorId != nil && !(n.actorName ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        if hasActor {
            Circle()
                .fill(n.actorColor.map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
                .frame(width: 36, height: 36)
                .overlay {
                    Text(n.actorInitials ?? "?").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white)
                }
        } else {
            Circle()
                .fill(Color.tfCard2)
                .frame(width: 36, height: 36)
                .overlay {
                    Image(systemName: "gearshape").font(.system(size: 17)).foregroundStyle(Color.tfDim)
                }
        }
    }

    private func dateLine(_ n: ApiNotification) -> String {
        guard let date = n.createdAtDate else { return "" }
        return "\(DirectoryDate.relative(date)) · \(DirectoryDate.absolute(date))"
    }

    // MARK: - Действия

    private func open(_ n: ApiNotification) async {
        rowErrors[n.id] = nil
        if !n.read {
            do {
                try await apiClient.directoryMarkNotificationRead(id: n.id)
                await notificationStore.load()
            } catch {
                rowErrors[n.id] = "Не удалось отметить прочитанным"
            }
        }
        if let taskId = n.taskId { route = .taskDetail(taskID: taskId) }
    }

    private func delete(_ n: ApiNotification) async {
        rowErrors[n.id] = nil
        do {
            try await apiClient.deleteNotification(id: n.id)
            await notificationStore.load()
        } catch {
            rowErrors[n.id] = "Не удалось удалить уведомление"
        }
    }

    private func markAllRead() async {
        guard !isMarkingAllRead, !allRead else { return }
        isMarkingAllRead = true
        markAllErrorMessage = nil
        defer { isMarkingAllRead = false }
        do {
            try await apiClient.directoryMarkAllNotificationsRead()
            await notificationStore.load()
        } catch {
            markAllErrorMessage = "Не удалось отметить все прочитанными"
        }
    }
}
