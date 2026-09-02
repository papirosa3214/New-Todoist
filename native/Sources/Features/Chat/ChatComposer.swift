import SwiftUI
import UniformTypeIdentifiers

// Строка ввода чата — 1:1 геометрия и поведение `src/components/ChatComposer.tsx`
// (комментарий там выводит H=44/ICON=32/GAP=8/EDGE=16 из шрифта поля;
// spec/DESIGN-TOKENS.md §4 «Строка ввода чата» подтверждает те же числа).
struct ChatComposer: View {
    @Bindable var viewModel: ChatViewModel
    @FocusState private var isFieldFocused: Bool
    @State private var isFileImporterPresented = false

    private let H: CGFloat = TFChatComposer.elementHeight
    private let ICON: CGFloat = TFChatComposer.iconSize

    var body: some View {
        VStack(spacing: 0) {
            TFErrorBanner(viewModel.uploadErrorMessage.map { _ in "Не удалось приложить файл" })
                .padding(.horizontal, TFSpacing.lg)
                .padding(.bottom, viewModel.uploadErrorMessage == nil ? 0 : TFSpacing.sm)
            TFErrorBanner(viewModel.sendErrorMessage.map { _ in "Не удалось отправить сообщение" })
                .padding(.horizontal, TFSpacing.lg)
                .padding(.bottom, viewModel.sendErrorMessage == nil ? 0 : TFSpacing.sm)

            if !viewModel.pendingAttachments.isEmpty {
                VStack(spacing: 4) {
                    ForEach(viewModel.pendingAttachments) { attachment in
                        pendingChip(attachment)
                    }
                }
                .padding(.horizontal, TFSpacing.lg)
                .padding(.bottom, TFSpacing.sm)
            }

            HStack(alignment: .bottom, spacing: TFSpacing.sm) {
                addresseeSlot
                fieldRow
                sendButton
            }
            .padding(.horizontal, TFSpacing.lg)
            .padding(.vertical, TFSpacing.sm)
        }
        .background(.ultraThinMaterial)
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.image, .pdf, .plainText, .text, .item],
            allowsMultipleSelection: false
        ) { result in
            handleFileImport(result)
        }
    }

    // MARK: - Адресат

    @ViewBuilder
    private var addresseeSlot: some View {
        if viewModel.activeChannel == .owner {
            // Собеседник один и постоянный — лицо вместо кнопки выбора (не кликабельно).
            ZStack {
                RoundedRectangle(cornerRadius: TFRadius.lg).fill(Color.tfCard2)
                if let counterpart = viewModel.counterpart {
                    TFAvatar(
                        size: .md,
                        initials: counterpart.initials ?? "?",
                        tint: Color(hex: counterpart.avatarColor ?? "#A6A6A6")
                    )
                }
            }
            .frame(width: H, height: H)
        } else {
            Button {
                viewModel.isAddresseeMenuOpen.toggle()
            } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: TFRadius.lg)
                        .fill(addresseeBackground)
                        .overlay {
                            if case .none = viewModel.addressee {
                                RoundedRectangle(cornerRadius: TFRadius.lg)
                                    .strokeBorder(Color.tfRed, style: StrokeStyle(lineWidth: TFBorder.width, dash: [4]))
                            }
                        }
                    Image(systemName: addresseeIsAll ? "person.2.fill" : "cpu")
                        .font(.system(size: 18))
                        .foregroundStyle(addresseeForeground)
                }
                .frame(width: H, height: H)
            }
            .buttonStyle(TFTapScaleStyle())
            .popover(isPresented: $viewModel.isAddresseeMenuOpen) {
                addresseeMenu
                    .presentationCompactAdaptation(.popover)
            }
        }
    }

    private var addresseeIsAll: Bool { viewModel.addressee == .all }

    private var addresseeBackground: Color {
        switch viewModel.addressee {
        case .user: return .tfRed
        case .all: return .tfCard2
        case .none: return .tfCard
        }
    }

    private var addresseeForeground: Color {
        switch viewModel.addressee {
        case .user: return .white
        case .all: return .tfText
        case .none: return .tfRed
        }
    }

    private var addresseeMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            menuItem(label: "Всем", isSelected: addresseeIsAll) {
                viewModel.addressee = .all
                viewModel.isAddresseeMenuOpen = false
            }
            ForEach(viewModel.others) { participant in
                menuItem(label: participant.name, isSelected: isSelected(participant)) {
                    viewModel.addressee = .user(id: participant.id, name: participant.name)
                    viewModel.isAddresseeMenuOpen = false
                }
            }
        }
        .padding(.vertical, TFSpacing.xs)
        .frame(minWidth: 200)
    }

    private func isSelected(_ participant: ApiChatParticipant) -> Bool {
        if case .user(let id, _) = viewModel.addressee { return id == participant.id }
        return false
    }

    private func menuItem(label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: TFSpacing.sm) {
                Image(systemName: isSelected ? "checkmark" : "cpu")
                    .font(.system(size: TFIconSize.xs))
                    .foregroundStyle(Color.tfRed)
                    .frame(width: 18)
                Text(label).tfText(.row).foregroundStyle(Color.tfText)
                Spacer()
            }
            .padding(.horizontal, TFSpacing.md)
            .frame(height: TFHitTarget.min)
            .contentShape(Rectangle())
        }
        .buttonStyle(TFTapRowStyle())
    }

    // MARK: - Поле

    private var fieldRow: some View {
        HStack(alignment: .bottom, spacing: 4) {
            TextField("", text: $viewModel.draftText, prompt: Text(placeholder).foregroundStyle(Color.tfDim), axis: .vertical)
                .tfText(.input)
                .foregroundStyle(Color.tfText)
                .focused($isFieldFocused)
                .lineLimit(1...4)
                .padding(.vertical, 11)
                .accessibilityIdentifier("chat.message")

            // Скрепка и микрофон — тап не должен отбирать фокус у поля
            // (иначе открытая клавиатура дёргалась бы на каждый тап,
            // spec/SCREENS-2.md §3.1 «важная деталь реализации»).
            iconButton("paperclip") {
                isFileImporterPresented = true
            }
            .disabled(viewModel.isUploadingAttachment)

            // MicOverlay — общий компонент §0.7 спеки, в DesignSystem его
            // ещё нет (запись/распознавание — отдельная инфраструктура,
            // Speech-разрешение в Info.plist сюда не входит). Кнопка стоит
            // для визуального паритета, действия у неё пока нет — см. отчёт.
            iconButton("mic.fill") {}
        }
        .padding(.leading, TFSpacing.md)
        .padding(.trailing, 6)
        // Фиксированная высота 44pt обрезала многострочный TextField, хотя
        // `axis: .vertical` и `lineLimit(1...4)` уже были заданы. Теперь
        // капсула растёт вместе с полем до четырёх строк, после чего SwiftUI
        // включает внутреннюю прокрутку; боковые кнопки остаются у нижней
        // кромки и не прыгают относительно кнопки отправки.
        .frame(minHeight: H)
        .background(Color.tfCard)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private var placeholder: String {
        switch viewModel.addressee {
        case .user(_, let name) where viewModel.activeChannel != .owner:
            return "\(name)…"
        case .all:
            return "Всем…"
        default:
            if viewModel.activeChannel == .owner, let counterpart = viewModel.counterpart {
                return "\(counterpart.name)…"
            }
            return "Кому? выбери адресата"
        }
    }

    private func iconButton(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 18))
                .foregroundStyle(Color.tfSub)
                .frame(width: ICON, height: ICON)
                .contentShape(Rectangle().inset(by: -6)) // добивает тап-зону до 44
        }
        .buttonStyle(TFTapScaleStyle())
    }

    // MARK: - Отправка

    private var sendButton: some View {
        Button {
            isFieldFocused = false
            Task { await viewModel.send() }
        } label: {
            Image(systemName: "chevron.up")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: H, height: H)
                .background(Color.tfRed)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
        .buttonStyle(TFTapScaleStyle())
        .opacity(viewModel.canSend ? 1 : 0.4)
        .disabled(!viewModel.canSend)
        .accessibilityLabel("Отправить")
        .accessibilityIdentifier("chat.send")
    }

    // MARK: - Вложения

    private func pendingChip(_ attachment: ApiChatAttachment) -> some View {
        HStack(spacing: TFSpacing.sm) {
            Image(systemName: "paperclip")
                .font(.system(size: 13))
                .foregroundStyle(Color.tfSub)
            Text(attachment.fileName)
                .tfText(.meta)
                .foregroundStyle(Color.tfText)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button {
                Task { await viewModel.removePendingAttachment(attachment.id) }
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: TFIconSize.xs))
                    .foregroundStyle(Color.tfDim)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(TFTapScaleStyle())
        }
        .padding(.horizontal, TFSpacing.md)
        .frame(height: 36)
        .background(Color.tfCard2)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, let url = urls.first else { return }
        Task {
            guard url.startAccessingSecurityScopedResource() else { return }
            defer { url.stopAccessingSecurityScopedResource() }
            guard let data = try? Data(contentsOf: url) else { return }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            await viewModel.attach(fileName: url.lastPathComponent, data: data, mime: mime)
        }
    }
}
