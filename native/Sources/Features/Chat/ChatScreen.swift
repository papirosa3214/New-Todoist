import SwiftUI

/// Переключатель каналов «Оркестратор Claude» / «Агенты» — 1:1 `ChannelTabs`
/// (`src/screens/ChatScreen.tsx`), встроен в шапку через слот `below`
/// (spec/SCREENS-2.md §0.1: уезжает и затухает вместе с ней, не отдельным
/// блоком под ней — снято живьём на вебе 28.08.2026 по той же причине).
private struct ChannelTabs: View {
    let value: ChatChannel
    let counterpartName: String
    let onChange: (ChatChannel) -> Void

    var body: some View {
        HStack(spacing: 4) {
            tab(.owner, label: counterpartName)
            tab(.agents, label: "Агенты")
        }
        .padding(3)
        .frame(height: 44)
        .background(Color.tfCard2)
        .clipShape(RoundedRectangle(cornerRadius: TFRadius.xl))
        .padding(.horizontal, TFSpacing.lg)
        .padding(.top, TFSpacing.sm)
    }

    private func tab(_ channel: ChatChannel, label: String) -> some View {
        Button {
            onChange(channel)
        } label: {
            Text(label)
                .tfText(.row)
                .foregroundStyle(value == channel ? Color.tfText : Color.tfSub)
                .frame(maxWidth: .infinity)
                .frame(height: 38)
                .background(value == channel ? Color.tfCard : .clear)
                .clipShape(RoundedRectangle(cornerRadius: TFRadius.lg))
        }
        .buttonStyle(TFTapFadeStyle())
    }
}

/// Чат координации — `/chat` (SCREENS-2 §3). Никакого стриминга токенов
/// нет (спека прямо это оговаривает) — сообщения приходят целиком, живой
/// сигнал только один: `TypingLine`.
struct ChatScreen: View {
    @Environment(SessionStore.self) private var session
    /// Стрелка «назад» в шапке: на чате нижняя панель вкладок скрыта, и это
    /// единственный выход. Действие кладёт `RootShellView` — чат корневая
    /// вкладка, `dismiss()` тут закрывать нечего.
    @Environment(\.chatBackAction) private var chatBack
    @State private var viewModel = ChatViewModel()

    var body: some View {
        VStack(spacing: 0) {
            TFScreenHeader(
                viewModel.headerTitle,
                variant: .compact,
                leading: chatBack.map { back in { AnyView(DirectoryBackButton(action: back)) } },
                actions: [TFHeaderAction(icon: "chart.bar") { /* ChatStatsSheet — вне охвата, см. отчёт */ }],
                below: viewModel.bothChannelsVisible ? {
                    AnyView(ChannelTabs(
                        value: viewModel.activeChannel,
                        counterpartName: viewModel.counterpartFirstName,
                        onChange: { viewModel.switchChannel(to: $0) }
                    ))
                } : nil
            )

            TFErrorBanner(viewModel.historyErrorMessage.map { _ in "Не удалось загрузить чат" })
                .padding(.horizontal, TFSpacing.lg)
                .padding(.top, TFSpacing.sm)

            messageList
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            ChatComposer(viewModel: viewModel)
        }
        // Своя шапка уже несёт заголовок и кнопку «назад» — системный навбар
        // поверх неё давал ВТОРУЮ стрелку и лишнюю полосу.
        // Нативная сворачивающаяся шапка по официальным гайдам SwiftUI.
        .navigationTitle(viewModel.headerTitle)
        .navigationBarTitleDisplayMode(.large)
        .background(Color.tfBackground)
        .accessibilityIdentifier("chat.screen")
        .task {
            viewModel.configure(currentUser: session.currentUser)
            // Fire-and-forget: экран показывается сразу, данные подтягиваются в фоне.
            // Это и было главной причиной 27 с открытия чата — `start()` ждал
            // `reloadAll()` (участники + история + typing snapshot + markChatRead),
            // экран не отрисовывался пока все запросы не завершатся.
            Task { await viewModel.start() }
        }
        .onDisappear {
            viewModel.stop()
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: TFSpacing.md) {
                    if viewModel.isLoadingHistory {
                        TFLoading(.block)
                    } else if viewModel.messages.isEmpty {
                        Text(viewModel.emptyStateText)
                            .tfText(.action)
                            .foregroundStyle(Color.tfDim)
                            .padding(.horizontal, TFSpacing.xl)
                            .padding(.top, TFSpacing.md)
                    }

                    ForEach(viewModel.messages) { message in
                        ChatBubble(
                            message: message,
                            mine: message.fromUserId == viewModel.currentUserId,
                            toMe: viewModel.currentUserId != nil
                                && message.toUserId == viewModel.currentUserId
                                && message.fromUserId != viewModel.currentUserId
                        )
                        .id(message.id)
                    }

                    TypingLine(typists: viewModel.visibleTypists)
                        .id("typing-line")
                }
                .padding(.top, TFSpacing.md)
            }
            .onChange(of: viewModel.messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: viewModel.visibleTypists) { _, _ in scrollToBottom(proxy) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo("typing-line", anchor: .bottom)
        }
    }
}
