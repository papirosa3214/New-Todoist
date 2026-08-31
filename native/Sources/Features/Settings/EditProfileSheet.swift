import SwiftUI
import PhotosUI

/// Шторка правки профиля — веб-аналог `EditProfileModal.tsx`. Веб форма
/// шлёт `{name, email, password, currentPassword}` на `PUT /auth/profile`,
/// но нативный `APIClient.updateProfile(name:avatarColor:)`
/// (`Core/Networking/APIClient+Auth.swift`, чужой файл) поддерживает ТОЛЬКО
/// `name`/`avatarColor` — смены логина/пароля там нет. Это гэп Core, не
/// делаю вид, что смена email/пароля работает: поля для них здесь НЕ
/// заведены (честнее, чем нерабочие текстовые поля), отмечено в отчёте.
struct EditProfileSheet: View {
    let user: ApiUser
    let onSaved: (ApiUser) -> Void

    @Environment(SettingsViewModel.self) private var settings
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(user: ApiUser, onSaved: @escaping (ApiUser) -> Void) {
        self.user = user
        self.onSaved = onSaved
        _name = State(initialValue: user.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.lg) {
            Text("Редактировать профиль")
                .tfText(.title)
                .foregroundStyle(Color.tfText)

            TFErrorBanner(errorMessage, variant: .block)

            VStack(alignment: .leading, spacing: TFSpacing.xs) {
                Text("Имя пользователя")
                    .tfText(.caption)
                    .foregroundStyle(Color.tfSub)
                TFTextField("Ваше имя", text: $name, icon: "person")
            }

            HStack(spacing: TFSpacing.md) {
                TFButton("Отмена", variant: .secondary) { dismiss() }
                TFButton(isSaving ? "Сохранение…" : "Сохранить", variant: .primary, isEnabled: !isSaving && !name.trimmingCharacters(in: .whitespaces).isEmpty) {
                    Task { await save() }
                }
            }
        }
        .padding(.bottom, TFSpacing.xl)
    }

    private func save() async {
        errorMessage = nil
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await settings.saveProfile(name: name.trimmingCharacters(in: .whitespaces), avatarColor: nil)
            onSaved(updated)
            dismiss()
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}

/// Кружок аватарки в шапке профиля — тап открывает `PhotosPicker` (смена
/// фото), рядом кнопки «Изменить» (имя, шторка выше) и «Убрать фото»
/// (только если фото уже есть) — 1:1 структура `AccountAvatarRow` в вебе.
struct ProfileAccountRow: View {
    let user: ApiUser
    let avatarURLOverride: String?
    let onEdit: () -> Void
    let onAvatarChanged: (String?) -> Void

    @Environment(SettingsViewModel.self) private var settings
    @State private var pickerItem: PhotosPickerItem?
    @State private var isBusy = false
    @State private var errorMessage: String?

    private var avatarURL: String? { avatarURLOverride ?? user.avatarUrl }

    var body: some View {
        VStack(alignment: .leading, spacing: TFSpacing.xs) {
            HStack(spacing: TFSpacing.md) {
                PhotosPicker(selection: $pickerItem, matching: .images) {
                    avatarView
                }
                .disabled(isBusy)

                VStack(alignment: .leading, spacing: 2) {
                    Text(user.name)
                        .tfText(.body)
                        .fontWeight(.medium)
                        .foregroundStyle(Color.tfText)
                    if let email = user.email {
                        Text(email)
                            .tfText(.action)
                            .foregroundStyle(Color.tfSub)
                    }
                }
                Spacer()
                Button("Изменить", action: onEdit)
                    .buttonStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.tfText)
                    .padding(.horizontal, TFSpacing.sm)
                    .padding(.vertical, TFSpacing.xs)
                    .background(Color.tfCard2)
                    .overlay(RoundedRectangle(cornerRadius: TFRadius.md).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width))
                    .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
                if avatarURL != nil {
                    Button("Убрать фото") { Task { await removeAvatar() } }
                        .buttonStyle(TFTapFadeStyle())
                        .font(.system(size: 12))
                        .foregroundStyle(Color.tfSub)
                        .disabled(isBusy)
                }
            }
            TFErrorBanner(errorMessage)
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.vertical, TFSpacing.md)
        .onChange(of: pickerItem) { _, newItem in
            Task { await upload(newItem) }
        }
    }

    @ViewBuilder
    private var avatarView: some View {
        // `AsyncImage` требует заголовок Authorization, которого он слать не
        // умеет (см. комментарий `APIClient.downloadRaw`) — но `/avatars/:name`
        // ПУБЛИЧНЫЙ (spec §5.10), поэтому прямой `URL` годится без обёртки.
        if let avatarURL, let url = URL(string: avatarURL) {
            AsyncImage(url: url) { image in
                image.resizable().aspectRatio(contentMode: .fill)
            } placeholder: {
                TFAvatar(size: .lg, initials: user.initials ?? "?", tint: (user.avatarColor).map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
            }
            .frame(width: 40, height: 40)
            .clipShape(Circle())
        } else {
            TFAvatar(size: .lg, initials: user.initials ?? "?", tint: (user.avatarColor).map { Color(hex: $0) } ?? Color(hex: "#A6A6A6"))
        }
    }

    private func upload(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { return }
            let url = try await settings.uploadAvatar(data: data, mime: "image/jpeg")
            onAvatarChanged(url)
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func removeAvatar() async {
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }
        do {
            try await settings.deleteAvatar()
            onAvatarChanged("")
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }
}
