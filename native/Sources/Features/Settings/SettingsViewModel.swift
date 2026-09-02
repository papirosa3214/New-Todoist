import Foundation
import Observation
import LocalAuthentication

/// Вью-модель `SettingsScreen` — spec/SCREENS-2.md §6.
///
/// Профиль читается из `SessionStore` (общий стор, инъекция через
/// `@Environment`, как у `TodayViewModel`), а вот тема/биометрия — ЛОКАЛЬНЫЕ
/// настройки устройства (спец §6: «сохраняются на устройстве»), под которые
/// в `Core` пока нет общего хранилища настроек. По задаче: «если готового
/// способа хранения ещё нет — положи в UserDefaults у себя и отметь это в
/// отчёте» — так и сделано, ключи ниже.
@MainActor
@Observable
final class SettingsViewModel {
    private let apiClient: APIClient

    /// Тема — spec §6 п.2: тумблер со значением «Тёмная»/«Светлая». Реально
    /// ничего не переключает: `project.yml` сейчас форсит
    /// `UIUserInterfaceStyle: Dark` на весь таргет (правка вне этой папки,
    /// см. комментарий в `Color+Palette.swift`) — тумблер стоит и
    /// сохраняется, но светлая тема недостижима, пока каркасный исполнитель
    /// не снимет форс. Отмечено в отчёте.
    var isDarkTheme: Bool {
        didSet { UserDefaults.standard.set(isDarkTheme, forKey: Self.themeKey) }
    }

    /// Биометрия — spec §6: строка видна только если физически доступна.
    var biometryKind: LABiometryType = .none
    var isBiometryAvailable: Bool { biometryKind != .none }
    var biometryLabel: String {
        biometryKind == .faceID ? "Вход по Face ID" : "Вход по Touch ID"
    }
    var isBiometryEnabled: Bool {
        didSet { UserDefaults.standard.set(isBiometryEnabled, forKey: Self.biometryKey) }
    }

    /// Своя экранная клавиатура (`Sources/Keyboard/`, пишет другой
    /// исполнитель) — ключ и дефолт (ВЫКЛЮЧЕНО, системная клавиатура
    /// остаётся) зафиксированы здесь, поскольку раздел «Пользовательские
    /// настройки» — моя территория. Имя ключа — в отчёт оркестратору, чтобы
    /// исполнитель клавиатуры читал/писал именно его через
    /// `UserDefaults.standard`, а не заводил свой параллельный.
    var isCustomKeyboardEnabled: Bool {
        didSet { UserDefaults.standard.set(isCustomKeyboardEnabled, forKey: Self.customKeyboardKey) }
    }

    var errorMessage: String?

    static let customKeyboardKey = "taskflow_custom_keyboard_enabled"
    private static let themeKey = "taskflow_settings_dark_theme"
    private static let biometryKey = "taskflow_settings_biometry_enabled"

    init(apiClient: APIClient = APIClient()) {
        self.apiClient = apiClient
        isDarkTheme = UserDefaults.standard.object(forKey: Self.themeKey) as? Bool ?? true
        isBiometryEnabled = UserDefaults.standard.bool(forKey: Self.biometryKey)
        // Своя клавиатура по умолчанию выключена: пока она не проверена на
        // живом телефоне, системная остаётся основной.
        isCustomKeyboardEnabled = UserDefaults.standard.bool(forKey: Self.customKeyboardKey)
        detectBiometry()
    }

    private func detectBiometry() {
        let context = LAContext()
        var evalError: NSError?
        // `canEvaluatePolicy` не запрашивает разрешение — только проверяет
        // физическое наличие сенсора, ровно то, что нужно строке-условию
        // «биометрия физически доступна» (spec §6).
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &evalError)
        biometryKind = context.biometryType
    }

    /// `PUT /auth/profile` уже есть в `APIClient+Auth.swift`
    /// (`updateProfile(name:avatarColor:)`) — вызывается прямо отсюда.
    /// `SessionStore.currentUser` при этом НЕ обновляется: свойство
    /// `private(set)`, публичного метода «обновить текущего пользователя»
    /// в сторе нет (только `login`/`logout`/`bootstrap`). Правка чужого
    /// файла не по адресу этой папки, поэтому `SettingsScreen` держит свой
    /// локальный override поверх `session.currentUser` для немедленного
    /// отображения — до следующего перезапуска приложения (новый
    /// `bootstrap()` подтянет актуальное с сервера). Гэп — в отчёт
    /// оркестратору: стоило бы завести `SessionStore.refreshProfile()`.
    func saveProfile(name: String, avatarColor: String?) async throws -> ApiUser {
        try await apiClient.updateProfile(name: name, avatarColor: avatarColor)
    }

    func uploadAvatar(data: Data, mime: String) async throws -> String {
        try await apiClient.uploadAvatar(data: data, mime: mime).avatarUrl
    }

    func deleteAvatar() async throws {
        try await apiClient.deleteAvatar()
    }
}
