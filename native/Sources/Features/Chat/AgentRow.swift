import SwiftUI
import UIKit
import PhotosUI

// Аватар агента с произвольным пикселем — веб использует 36px (строка) и
// 48px (форма правки), ни один не входит в `TFAvatar.Size` (18/20/30/32).
// Дублирует ПРАВИЛА `TFAvatar` (фото — rounded-lg contain, инициалы — круг)
// намеренно точно, а не «похоже»: числа обязаны совпасть дословно. Стоило
// бы завести в `TFAvatar` вариант с произвольным `CGFloat` — вне моей
// папки, см. отчёт.
private struct AgentAvatarView: View {
    let urlPath: String?
    let initials: String
    let tint: Color
    let size: CGFloat

    var body: some View {
        if let urlPath, let url = URL(string: APIClient.baseURL.absoluteString + urlPath) {
            AsyncImage(url: url) { phase in
                if case .success(let image) = phase {
                    image
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: size, height: size)
                        .background(Color.tfCard2)
                        .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
                } else {
                    initialsCircle
                }
            }
        } else {
            initialsCircle
        }
    }

    private var initialsCircle: some View {
        Circle()
            .fill(tint)
            .frame(width: size, height: size)
            .overlay {
                Text(initials)
                    .font(.system(size: size * 0.43, weight: .semibold))
                    .foregroundStyle(.white)
            }
    }
}

/// Строка «Команда» — 1:1 `AgentRow` из `src/screens/AgentsScreen.tsx`:
/// приоритет аватарки (blocked > working > дефолт), бейдж роли, «онлайн» +
/// остаток лимита, чем занят прямо сейчас, свайп «Удалить»/«Изменить»
/// (только владелец и `type == "ai"`), инлайн-форма правки на месте строки.
struct AgentRow: View {
    let agent: ApiUser
    let editable: Bool
    let viewModel: AgentsViewModel
    let onRequestDelete: (ApiUser) -> Void

    @State private var isEditing = false
    @State private var editName = ""
    @State private var isSaving = false
    @State private var photoSelection: PhotosPickerItem?

    @State private var offsetX: CGFloat = 0
    @State private var animateOffset = false
    @State private var dragStartOffset: CGFloat = 0
    // Замок оси и счёт скорости переехали в HorizontalPanRecognizer —
    // распознаватель отдаёт готовое смещение и скорость в px/с.

    private let actionWidth: CGFloat = 88

    var body: some View {
        Group {
            if isEditing {
                editForm
            } else {
                swipeRow
            }
        }
    }

    // MARK: - Строка (показ)

    private var swipeRow: some View {
        ZStack {
            if editable {
                HStack(spacing: 0) {
                    actionButton(icon: "trash", label: "Удалить", color: .tfSwipeDelete) {
                        close()
                        onRequestDelete(agent)
                    }
                    .frame(width: actionWidth)
                    Spacer(minLength: 0)
                    actionButton(icon: "pencil", label: "Изменить", color: .tfSwipeEdit) {
                        close()
                        startEdit()
                    }
                    .frame(width: actionWidth)
                }
            }

            rowContent
                .background(Color.tfCard)
                .offset(x: offsetX)
                // Свайп на UIKit-распознавателе (HorizontalPan.swift): SwiftUI-жест
                // внутри ScrollView отбирает вертикальную прокрутку у списка.
                .gesture(
                    HorizontalPan(
                        // Неизменяемые строки (свои агенты) не свайпаются — как
                        // в вебе, где хук просто не подключался. Отключаем
                        // внутри замыканий: у моста `gesture(_:isEnabled:)` нет,
                        // эта перегрузка только для настоящих `Gesture`.
                        onBegin: {
                            guard editable else { return }
                            dragStartOffset = offsetX
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        },
                        onChange: { dx in if editable { drag(dx) } },
                        onEnd: { dx, velocity in if editable { settle(dx: dx, velocity: velocity) } }
                    )
                )
        }
        .clipShape(Rectangle())
    }

    private var rowContent: some View {
        HStack(spacing: TFSpacing.md) {
            AgentAvatarView(
                urlPath: resolvedAvatarPath,
                initials: agent.initials ?? "?",
                tint: Color(hex: agent.avatarColor ?? "#A6A6A6"),
                size: 36
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name)
                    .tfText(.body)
                    .foregroundStyle(Color.tfText)
                    .lineLimit(1)
                if agent.online == true, let action = agent.lastAction {
                    Text(action + (agent.lastActionTitle.map { " «\($0)»" } ?? ""))
                        .tfText(.meta)
                        .foregroundStyle(Color.tfSub)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: TFSpacing.sm)
            roleBadge
            HStack(spacing: 6) {
                Circle()
                    .fill(agent.online == true ? Color.tfGreen : Color.tfDim)
                    .frame(width: 7, height: 7)
                Text(agent.online == true ? "Онлайн" : "Офлайн")
                    .tfText(.meta)
                    .foregroundStyle(Color.tfSub)
                Text(limitsText)
                    .tfText(.caption)
                    .foregroundStyle(Color.tfSub)
            }
        }
        .padding(.horizontal, TFSpacing.lg)
        .padding(.vertical, TFSpacing.md)
        .contentShape(Rectangle())
    }

    private var roleBadge: some View {
        Text(roleBadgeLabel)
            .tfText(.meta)
            .foregroundStyle(.white)
            .padding(.horizontal, TFSpacing.sm)
            .padding(.vertical, 2)
            .background(roleBadgeColor)
            .clipShape(RoundedRectangle(cornerRadius: TFRadius.pill))
    }

    private func actionButton(icon: String, label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: icon).font(.system(size: 18))
                Text(label).tfText(.caption)
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(color)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Производные

    private var resolvedAvatarPath: String? {
        if agent.activity == "blocked", let blocked = agent.avatarUrlBlocked { return blocked }
        if agent.activity == "working", let working = agent.avatarUrlWorking { return working }
        return agent.avatarUrl
    }

    private var roleBadgeColor: Color {
        if agent.role == .owner { return .tfRed }
        if agent.role == .orchestrator { return .tfBlue }
        if agent.type == .ai { return .tfPurple }
        return .tfOrange
    }

    private var roleBadgeLabel: String {
        if agent.role == .owner { return "Владелец" }
        if agent.role == .orchestrator { return "Оркестратор" }
        if agent.type == .ai { return "Агент" }
        return "Наблюдатель"
    }

    private var limitsText: String {
        guard let limits = agent.limits else { return "без лимита" }
        guard let remaining = limits.remaining else { return "Остаток: неизвестно" }
        switch remaining {
        case .number(let n):
            return n == n.rounded() ? "Остаток: \(Int(n))" : "Остаток: \(n)"
        case .text(let s):
            return "Остаток: \(s)"
        }
    }

    // MARK: - Свайп (числа — spec/SCREENS-2.md §0.6 + `src/lib/useRowSwipe.ts`)

    private func close() {
        animateOffset = true
        offsetX = 0
    }

    private func drag(_ dx: CGFloat) {
        // hasLeft/hasRight веба здесь не нужны отдельно: жест вообще не
        // подключается, если строка не `editable` (см. `swipeRow`), а у
        // editable-строки открыты оба направления.
        let raw = dragStartOffset + dx
        var pos = raw
        if raw > actionWidth {
            let over = raw - actionWidth
            pos = actionWidth + (over * 30) / (30 + over)
        } else if raw < -actionWidth {
            let over = -raw - actionWidth
            pos = -actionWidth - (over * 30) / (30 + over)
        }
        animateOffset = false
        offsetX = pos
    }

    /// Скорость приходит от UIKit в px/с — с веб-порогами (280/250) она
    /// сравнима напрямую, в отличие от прежнего самодельного счёта по
    /// `value.location` и `Date()`.
    private func settle(dx: CGFloat, velocity: CGFloat) {
        animateOffset = true
        if dragStartOffset == 0 {
            if offsetX < -36 || velocity < -280 {
                offsetX = -actionWidth
            } else if offsetX > 36 || velocity > 280 {
                offsetX = actionWidth
            } else {
                offsetX = 0
            }
        } else if dragStartOffset < 0 {
            let keep = !(dx > 25 || velocity > 250)
            offsetX = keep ? -actionWidth : 0
        } else {
            let keep = !(dx < -25 || velocity < -250)
            offsetX = keep ? actionWidth : 0
        }
    }

    // MARK: - Форма правки (инлайн, на месте строки)

    private func startEdit() {
        editName = agent.name
        viewModel.renameErrorMessage = nil
        viewModel.avatarErrorMessage = nil
        isEditing = true
    }

    private var editForm: some View {
        VStack(alignment: .leading, spacing: TFSpacing.md) {
            HStack(spacing: TFSpacing.md) {
                PhotosPicker(selection: $photoSelection, matching: .images) {
                    AgentAvatarView(
                        urlPath: resolvedAvatarPath,
                        initials: agent.initials ?? "?",
                        tint: Color(hex: agent.avatarColor ?? "#A6A6A6"),
                        size: 48
                    )
                }
                .onChange(of: photoSelection) { _, item in
                    Task { await handlePickedPhoto(item) }
                }
                VStack(alignment: .leading, spacing: TFSpacing.xs) {
                    PhotosPicker(selection: $photoSelection, matching: .images) {
                        Text("Заменить фото")
                            .tfText(.meta)
                            .foregroundStyle(Color.tfText)
                            .padding(.horizontal, TFSpacing.sm)
                            .padding(.vertical, 4)
                            .background(Color.tfCard2)
                            .overlay {
                                RoundedRectangle(cornerRadius: TFRadius.md).strokeBorder(Color.tfStroke, lineWidth: TFBorder.width)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: TFRadius.md))
                    }
                    if agent.avatarUrl != nil {
                        Button("Убрать фото") {
                            Task { await viewModel.removeAvatar(agentId: agent.id) }
                        }
                        .buttonStyle(TFTapFadeStyle())
                        .font(TFFont.action)
                        .foregroundStyle(Color.tfSub)
                    }
                }
            }

            TextField("Имя агента", text: $editName)
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .padding(.horizontal, TFSpacing.md)
                .frame(height: 44)
                .background(Color.tfCard2)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))

            TFErrorBanner(viewModel.renameErrorMessage, variant: .block)
            TFErrorBanner(viewModel.avatarErrorMessage, variant: .block)

            HStack(spacing: TFSpacing.sm) {
                TFButton("Отмена", variant: .secondary) {
                    isEditing = false
                }
                TFButton(isSaving ? "Сохраняем…" : "Сохранить", variant: .primary, isEnabled: !editName.trimmingCharacters(in: .whitespaces).isEmpty && !isSaving) {
                    Task { await save() }
                }
            }
        }
        .padding(TFSpacing.lg)
    }

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        if await viewModel.renameAgent(id: agent.id, name: editName) {
            isEditing = false
        }
    }

    /// Байты из фотобиблиотеки могут быть HEIC — перекодируем в JPEG сами,
    /// чтобы реальные байты совпадали с заявленным `mime` (сервер сверяет
    /// `Content-Type` со своим белым списком, HEIC там нет).
    private func handlePickedPhoto(_ item: PhotosPickerItem?) async {
        guard let item, let raw = try? await item.loadTransferable(type: Data.self) else { return }
        guard let uiImage = UIImage(data: raw), let jpegData = uiImage.jpegData(compressionQuality: 0.9) else { return }
        await viewModel.uploadAvatar(agentId: agent.id, data: jpegData, mime: "image/jpeg")
        photoSelection = nil
    }
}
