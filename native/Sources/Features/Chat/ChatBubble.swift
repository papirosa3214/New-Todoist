import SwiftUI

// Пузырь сообщения — 1:1 `ChatBubble`/`AddressLine` из `src/screens/ChatScreen.tsx`.
// Числа не в spec/DESIGN-TOKENS.md (компонент туда не попал построчно) —
// сняты с живого веб-кода по правилу ARCHITECTURE.md п.3 «расходится спека
// с кодом — верить коду».

/// «→ тебе» / «→ {имя}» / «→ всем» над пузырём (SCREENS-2 §3, дословно).
private struct AddressLine: View {
    let message: ApiChatMessage
    let mine: Bool
    let toMe: Bool

    var body: some View {
        let target = toMe ? "тебе" : (message.toUserId != nil ? (message.toUserName ?? "—") : "всем")
        HStack(spacing: 4) {
            if !mine {
                Text(message.fromUserName ?? "—")
            }
            Text("→ \(target)")
                .foregroundStyle(toMe ? Color.tfRed : (mine ? Color.tfDim : Color.tfSub))
                .fontWeight(toMe ? .semibold : .regular)
        }
        .tfText(.meta) // 12px — ближайшая ступень шкалы к веб-тексту 12px
        .foregroundStyle(mine ? Color.tfDim : Color.tfSub)
        .padding(.horizontal, 4)
    }
}

/// Картинка-вложение — требует `Authorization` (`APIClient.downloadAttachment`,
/// см. комментарий в Core), поэтому `AsyncImage(url:)` сюда не годится:
/// грузим байты сами и держим готовый `UIImage`.
private struct ChatAttachmentImage: View {
    let attachmentId: String
    let fileName: String
    @State private var uiImage: UIImage?
    @State private var failed = false
    private let api = APIClient()

    var body: some View {
        Group {
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else if failed {
                ChatFileChip(fileName: fileName)
            } else {
                Color.tfCard2
                    .frame(height: 140)
                    .overlay { ProgressView() }
            }
        }
        .frame(maxWidth: 220)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        .task {
            guard uiImage == nil else { return }
            do {
                let data = try await api.downloadAttachment(id: attachmentId)
                uiImage = UIImage(data: data)
                if uiImage == nil { failed = true }
            } catch {
                failed = true
            }
        }
    }
}

/// Аватар автора сообщения — фото, если есть (`avatar_url` отдаётся
/// сервером БЕЗ авторизации, `AsyncImage(url:)` годится напрямую в отличие
/// от вложений), иначе инициалы через `TFAvatar`. Обёртка нужна ровно
/// потому, что `TFAvatar.image` — уже готовый `Image`, а не URL.
private struct ChatUserAvatar: View {
    let avatarUrlPath: String?
    let initials: String
    let tint: Color

    var body: some View {
        if let avatarUrlPath, let url = URL(string: APIClient.baseURL.absoluteString + avatarUrlPath) {
            AsyncImage(url: url) { phase in
                if case .success(let image) = phase {
                    TFAvatar(size: .md, image: image, initials: initials, tint: tint)
                } else {
                    TFAvatar(size: .md, initials: initials, tint: tint)
                }
            }
        } else {
            TFAvatar(size: .md, initials: initials, tint: tint)
        }
    }
}

/// Файл-не-картинка — чип со скрепкой и именем (веб: `bg-card2 h-9 px-3`).
private struct ChatFileChip: View {
    let fileName: String
    var body: some View {
        HStack(spacing: TFSpacing.sm) {
            Image(systemName: "paperclip")
                .tfText(.action)
                .foregroundStyle(Color.tfSub)
            Text(fileName)
                .tfText(.meta)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, TFSpacing.md)
        .frame(height: 36)
        .frame(maxWidth: 220, alignment: .leading)
        .background(Color.tfCard2)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }
}

struct ChatBubble: View {
    let message: ApiChatMessage
    let mine: Bool
    let toMe: Bool

    var body: some View {
        HStack(alignment: .top, spacing: TFSpacing.sm) {
            if mine { Spacer(minLength: 40) }

            if !mine {
                // Размер — веб 28px точечно; в шкале `TFAvatar.Size` ближайшее 30 (см. отчёт).
                ChatUserAvatar(
                    avatarUrlPath: message.fromUserAvatarUrl,
                    initials: message.fromUserInitials ?? "?",
                    tint: Color(hex: message.fromUserColor ?? "#A6A6A6")
                )
            }

            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                AddressLine(message: message, mine: mine, toMe: toMe)

                if !message.text.isEmpty {
                    Text(message.text)
                        .tfText(.row) // 14px — веб text-[14px]
                        .foregroundStyle(mine ? .white : Color.tfText)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(mine ? Color.tfRed : Color.tfCard)
                        .overlay {
                            if !mine && toMe {
                                RoundedRectangle(cornerRadius: TFRadius.xl)
                                    .strokeBorder(Color.tfRed, lineWidth: TFBorder.width)
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
                }

                ForEach(message.attachments ?? [], id: \.id) { attachment in
                    if let mime = attachment.mime, mime.hasPrefix("image/") {
                        ChatAttachmentImage(attachmentId: attachment.id, fileName: attachment.fileName)
                    } else {
                        ChatFileChip(fileName: attachment.fileName)
                    }
                }

                if let taskId = message.taskId, let taskTitle = message.taskTitle {
                    // Прямой переход по маршруту из контракта (INTEGRATION.md:
                    // «переход на другой экран — через маршрут из таблицы»),
                    // а не колбэк наружу — `AppRoute` публичный, стек навигации
                    // уже объявлен в RootShellView и примет push отсюда.
                    NavigationLink(value: AppRoute.taskDetail(taskID: taskId)) {
                        Text(taskTitle)
                            .tfText(.meta)
                            .foregroundStyle(Color.tfSub)
                            .underline()
                            .padding(.horizontal, 4)
                    }
                }

                Text(timestampText)
                    .tfText(.caption)
                    .foregroundStyle(Color.tfDim)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
            }
            .frame(maxWidth: 300, alignment: mine ? .trailing : .leading) // ~78% экрана 420pt (веб max-w-[78%])

            if !mine { Spacer(minLength: 40) }
        }
        .padding(.horizontal, TFSpacing.lg)
    }

    private var timestampText: String {
        guard let date = message.createdAtDate else { return "" }
        return "\(RelativeTime.relative(from: date)) · \(RelativeTime.absoluteMoscow(from: date))"
    }
}
