import Foundation
import Observation

/// Единственный канал реалтайма — WebSocket, SSE в проекте нет (spec/API.md §4).
/// `ws://192.168.1.110:3001/ws?token=<JWT-или-api_token>` — эндпоинт ВНЕ
/// префикса `/api`, токен в query (хендшейк-заголовки не всегда доступны
/// клиентским WS-библиотекам — тот же приём, что у веба).
///
/// `@MainActor`: всё состояние читает/пишет UI (сторы, индикатор соединения),
/// а `URLSessionWebSocketTask.receive` коллбэк приходит с произвольной
/// очереди — каждый такой коллбэк перепрыгивает на `@MainActor` явным
/// `Task`, вместо `@unchecked Sendable`/ручных блокировок.
@MainActor
@Observable
public final class RealtimeClient {
    public private(set) var isConnected = false

    /// На каждое разобранное событие — сторы подписываются здесь напрямую,
    /// без Combine/NotificationCenter (проще в @Observable-мире SwiftUI).
    /// НЕ `@Sendable` — весь класс уже `@MainActor`, замыкание вызывается
    /// строго оттуда же, лишнее требование только мешало бы захватывать
    /// обычные (не-Sendable) `@Observable`-сторы.
    public var onEvent: ((RealtimeEvent) -> Void)?
    /// Только на ПЕРЕподключение (не на первое) — spec §4.2: сервер не хранит
    /// очередь пропущенных событий за время разрыва, сторам нужно обновиться
    /// явным REST-запросом, а не ждать, что WS сам «досоединится».
    public var onReconnected: (() -> Void)?

    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var watchdogTask: Task<Void, Never>?
    private var lastTrafficAt = Date()
    private var hasConnectedBefore = false
    private var isStopping = true
    private var reconnectAttempt = 0

    private static let watchdogIntervalNs: UInt64 = 20_000_000_000
    /// Дольше этого без НИКАКОГО входящего трафика (включая keepalive `ping`)
    /// — считаем соединение мёртвым (spec §4.2: `OPEN`, но фактически мёртв
    /// после сна/блокировки устройства — `readyState` в этот момент не врёт,
    /// но и не отражает реальность, полагаться только на него нельзя).
    private static let staleThreshold: TimeInterval = 45

    public init() {}

    public func connect() {
        isStopping = false
        openSocket()
        startWatchdog()
    }

    public func disconnect() {
        isStopping = true
        watchdogTask?.cancel()
        watchdogTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
    }

    private func openSocket() {
        guard let token = KeychainService.shared.token else { return }
        var components = URLComponents()
        components.scheme = "ws"
        components.host = APIClient.baseURL.host
        components.port = APIClient.baseURL.port
        components.path = "/ws"
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components.url else { return }

        let newTask = session.webSocketTask(with: url)
        task = newTask
        newTask.resume()
        lastTrafficAt = Date()
        listen(on: newTask)
    }

    private func listen(on socketTask: URLSessionWebSocketTask) {
        socketTask.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                self.handleReceiveResult(result, task: socketTask)
            }
        }
    }

    private func handleReceiveResult(
        _ result: Result<URLSessionWebSocketTask.Message, Error>,
        task socketTask: URLSessionWebSocketTask
    ) {
        switch result {
        case .failure:
            // Тот же гвард, что в success-ветке: watchdog при "зависшем" сокете
            // сам обнуляет `task` и запускает переподключение ДО того, как
            // старый `receive` вернёт failure — без проверки это второй,
            // лишний `handleDisconnect`/reconnect поверх уже открытого нового
            // сокета (дублирующиеся события, двойной onReconnected).
            guard task === socketTask else { return }
            handleDisconnect()
        case .success(let message):
            lastTrafficAt = Date()
            if !isConnected {
                isConnected = true
                if hasConnectedBefore { onReconnected?() }
                hasConnectedBefore = true
                reconnectAttempt = 0
            }
            handle(message: message, task: socketTask)
            // Тот же сокет ещё актуален (не заменён переподключением) — читаем дальше.
            if task === socketTask {
                listen(on: socketTask)
            }
        }
    }

    private func handle(message: URLSessionWebSocketTask.Message, task socketTask: URLSessionWebSocketTask) {
        guard case .string(let text) = message, let data = text.data(using: .utf8) else { return }
        guard let event = RealtimeEvent.parse(data) else { return }
        if case .ping = event {
            // Keepalive — сервер шлёт ping, клиент обязан ответить pong (spec §4).
            socketTask.send(.string("{\"type\":\"pong\"}")) { _ in }
        }
        onEvent?(event)
    }

    private func handleDisconnect() {
        guard !isStopping else { return }
        isConnected = false
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !isStopping else { return }
        reconnectAttempt += 1
        // Экспоненциальный бэкофф, потолок 30с — не долбить сервер при долгом офлайне.
        let delaySeconds = min(30.0, pow(1.6, Double(reconnectAttempt)))
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard let self else { return }
            await MainActor.run {
                guard !self.isStopping else { return }
                self.openSocket()
            }
        }
    }

    private func startWatchdog() {
        watchdogTask?.cancel()
        watchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.watchdogIntervalNs)
                guard !Task.isCancelled, let self else { return }
                await MainActor.run {
                    guard !self.isStopping else { return }
                    if Date().timeIntervalSince(self.lastTrafficAt) > Self.staleThreshold {
                        // Обнулить `task` ДО cancel — иначе отменённый `receive`
                        // придёт с failure чуть позже и (совпав по `task === socketTask`
                        // в старом коде) вызовет второй handleDisconnect/reconnect
                        // поверх уже переоткрытого сокета. См. guard в failure-ветке выше.
                        let staleTask = self.task
                        self.task = nil
                        staleTask?.cancel(with: .abnormalClosure, reason: nil)
                        self.handleDisconnect()
                    }
                }
            }
        }
    }
}
