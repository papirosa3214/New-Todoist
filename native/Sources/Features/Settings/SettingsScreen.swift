import SwiftUI

/// `/settings` — spec/SCREENS-2.md §6. Дерево настроек: профиль, тема/
/// биометрия/иконка, ИИ, общие разделы-переходы, сервер, выход.
///
/// Шапка — `SettingsHeaderChrome` (своя композиция, не `TFScreenHeader`):
/// см. комментарий в файле компонента — веб держит здесь `variant="large"`
/// (по умолчанию) СО стрелкой «назад» (правило добавлено в
/// `ScreenHeader.tsx` 27.08.2026), а нативный `TFScreenHeader.large` стрелку
/// не рисует вовсе — гэп, не мой файл чинить.
struct SettingsScreen: View {
    @Environment(SessionStore.self) private var session
    @State private var viewModel = SettingsViewModel()
    @State private var profileOverride: ApiUser?
    @State private var isEditProfilePresented = false

    var body: some View {
        VStack(spacing: 0) {
            SettingsHeaderChrome(title: "Настройки")
            ScrollView {
                VStack(alignment: .leading, spacing: TFSpacing.xl) {
                    accountSection
                    userSettingsSection
                    aiSection
                    generalSection
                    serverSection
                    signOutSection
                }
                .padding(.vertical, TFSpacing.lg)
            }
            // TFTabBar рисуется поверх push-навигаций в ZStack RootShellView —
            // без safe-area-inset снизу последняя секция уезжает под него.
            // Шаблон для всех push-навигаций папки Настроек, см. также
            // `IntegrationsScreen`/`TemplatesScreen`/`VoiceModelsScreen` —
            // если ревью увидит срез где-то ещё, фикс симметричный.
            .safeAreaInset(edge: .bottom) {
                Color.clear.frame(height: TFTabBarMetrics.heightCompact)
            }
        }
        .background(Color.tfBackground)
        .environment(viewModel)
        .tfBottomSheet(isPresented: $isEditProfilePresented) {
            if let user = displayedUser {
                EditProfileSheet(user: user) { updated in
                    profileOverride = updated
                }
            }
        }
    }

    private var displayedUser: ApiUser? { profileOverride ?? session.currentUser }

    @ViewBuilder
    private var accountSection: some View {
        TFCard(padding: 0) {
            if let user = displayedUser {
                ProfileAccountRow(
                    user: user,
                    avatarURLOverride: profileOverride?.avatarUrl,
                    onEdit: { isEditProfilePresented = true },
                    onAvatarChanged: { newURL in
                        // Строка выше про override — тот же приём, что для
                        // имени: `SessionStore.currentUser` не обновляем
                        // (нет публичного сеттера), только локальный вид.
                        var patched = displayedUser ?? user
                        patched = ApiUser(
                            id: patched.id, name: patched.name, email: patched.email,
                            role: patched.role, type: patched.type, avatarColor: patched.avatarColor,
                            initials: patched.initials, status: patched.status, createdAt: patched.createdAt,
                            isSystemBot: patched.isSystemBot, createdBy: patched.createdBy,
                            avatarUrl: newURL?.isEmpty == false ? newURL : nil,
                            avatarUrlWorking: patched.avatarUrlWorking, avatarUrlBlocked: patched.avatarUrlBlocked,
                            lastSeenAt: patched.lastSeenAt, activity: patched.activity, online: patched.online,
                            lastAction: patched.lastAction, lastActionTitle: patched.lastActionTitle, limits: patched.limits
                        )
                        profileOverride = patched
                    }
                )
            } else {
                TFListRow(icon: "person", title: "Аккаунт")
            }
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
    }

    @ViewBuilder
    private var userSettingsSection: some View {
        section(title: "Пользовательские настройки") {
            toggleRow(icon: "moon", tint: .tfRed, title: "Тема", valueLabel: viewModel.isDarkTheme ? "Тёмная" : "Светлая", isOn: $viewModel.isDarkTheme)
            if viewModel.isBiometryAvailable {
                TFDivider(inset: rowDividerInset)
                toggleRow(icon: viewModel.biometryKind == .faceID ? "faceid" : "touchid", tint: .tfTeal, title: viewModel.biometryLabel, valueLabel: viewModel.isBiometryEnabled ? "Включён" : "Выключен", isOn: $viewModel.isBiometryEnabled)
            }
            TFDivider(inset: rowDividerInset)
            TFListRow(icon: "photo", iconTint: .tfPink, title: "Иконка", trailing: AnyView(infoValue("Pure Minimal Glass")))
            TFDivider(inset: rowDividerInset)
            toggleRow(icon: "keyboard", tint: .tfBlue, title: "Своя клавиатура", valueLabel: viewModel.isCustomKeyboardEnabled ? "Включена" : "Системная", isOn: $viewModel.isCustomKeyboardEnabled)
        }
    }

    @ViewBuilder
    private var aiSection: some View {
        section(title: "Искусственный интеллект") {
            NavigationLink(value: AppRoute.voiceModels) {
                TFListRow(icon: "sparkles", iconTint: .tfPurple, title: "Искусственный интеллект", trailing: AnyView(chevron))
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var generalSection: some View {
        section(title: "Общие") {
            navRow(icon: "bookmark", tint: .tfOrange, title: "Шаблоны задач", route: .templates)
            TFDivider(inset: rowDividerInset)
            navRow(icon: "tag", tint: .tfRed, title: "Метки", route: .labels)
            TFDivider(inset: rowDividerInset)
            navRow(icon: "person.3.fill", tint: .tfRed, title: "Команда", route: .agents)
            TFDivider(inset: rowDividerInset)
            navRow(icon: "link", tint: .tfTeal, title: "Интеграции (Google, Apple)", route: .integrations)
        }
    }

    @ViewBuilder
    private var serverSection: some View {
        section(title: "Сервер") {
            ServerStatusSection()
        }
    }

    @ViewBuilder
    private var signOutSection: some View {
        TFCard(padding: 0) {
            Button(role: .destructive) {
                session.logout()
            } label: {
                HStack {
                    Text("Выйти")
                        .tfText(.body)
                        .foregroundStyle(Color.tfRed)
                    Spacer()
                }
                .padding(.horizontal, TFSpacing.lg)
                .frame(minHeight: TFField.height)
                .contentShape(Rectangle())
            }
            .buttonStyle(TFTapRowStyle())
        }
        .padding(.horizontal, TFSpacing.screenHorizontal)
    }

    // MARK: - Общие строители строк

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: TFSpacing.sm) {
            TFSectionHeader(title)
            TFCard(padding: 0) { VStack(spacing: 0) { content() } }
                .padding(.horizontal, TFSpacing.screenHorizontal)
        }
    }

    private func navRow(icon: String, tint: Color, title: String, route: AppRoute) -> some View {
        NavigationLink(value: route) {
            TFListRow(icon: icon, iconTint: tint, title: title, trailing: AnyView(chevron))
        }
        .buttonStyle(.plain)
    }

    /// Шеврон рисуется вручную через `trailing`, а не через `action` у
    /// `TFListRow`: тап-зону и переход уже даёт обёртывающий `NavigationLink`,
    /// вложенный `Button` внутри него задвоил бы жест (см. INTEGRATION.md —
    /// переходы только `NavigationLink(value:)`).
    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 13))
            .foregroundStyle(Color.tfDim)
    }

    private func toggleRow(icon: String, tint: Color, title: String, valueLabel: String, isOn: Binding<Bool>) -> some View {
        TFListRow(
            icon: icon, iconTint: tint, title: title,
            trailing: AnyView(HStack(spacing: TFSpacing.sm) {
                infoValue(valueLabel)
                TFToggle(isOn: isOn)
            })
        )
    }

    private func infoValue(_ text: String) -> some View {
        Text(text).tfText(.body).foregroundStyle(Color.tfSub)
    }

    private var rowDividerInset: CGFloat { TFSpacing.lg + 40 + TFSpacing.md }
}
