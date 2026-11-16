import Foundation

// MARK: - Events

/// `GET /v1/events` のサーバー→クライアントメッセージ。
public enum RelayEvent: Equatable, Sendable, Decodable {
    case hello(pending: [AgentRequest])
    case created(AgentRequest)
    case updated(AgentRequest)
    case pong
    /// 未知の type (無視する)。
    case unknown(type: String)

    enum CodingKeys: String, CodingKey { case type, pending, request }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            self = .hello(pending: try c.decodeLossyArray(AgentRequest.self, forKey: .pending))
        case "request.created":
            self = .created(try c.decode(AgentRequest.self, forKey: .request))
        case "request.updated":
            self = .updated(try c.decode(AgentRequest.self, forKey: .request))
        case "pong":
            self = .pong
        default:
            self = .unknown(type: type)
        }
    }

    /// テキストフレームを解釈する。JSON でない・必須項目が欠けている場合は nil (呼び出し側は無視する)。
    public static func decode(text: String) -> RelayEvent? {
        try? OyobidashiJSON.makeDecoder().decode(RelayEvent.self, from: Data(text.utf8))
    }
}

// MARK: - WebSocket abstraction

public enum WebSocketFrame: Equatable, Sendable {
    case text(String)
    case data(Data)
}

public protocol WebSocketConnection: AnyObject, Sendable {
    /// 次のフレームを待つ。切断時は throw。upgrade が 401 で拒否された場合は `RelayError.unauthorized` を throw する。
    func receive() async throws -> WebSocketFrame
    func send(text: String) async throws
    func close()
}

public protocol WebSocketConnector: Sendable {
    func connect(_ request: URLRequest) async throws -> any WebSocketConnection
}

public struct URLSessionWebSocketConnector: WebSocketConnector {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func connect(_ request: URLRequest) async throws -> any WebSocketConnection {
        let task = session.webSocketTask(with: request)
        task.resume()
        return URLSessionWebSocketConnection(task: task)
    }
}

final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func receive() async throws -> WebSocketFrame {
        do {
            switch try await task.receive() {
            case .string(let text): return .text(text)
            case .data(let data): return .data(data)
            @unknown default: return .data(Data())
            }
        } catch {
            // upgrade が拒否された場合、HTTP レスポンスが task.response に残る。
            if let http = task.response as? HTTPURLResponse, http.statusCode == 401 {
                throw RelayError.unauthorized
            }
            throw error
        }
    }

    func send(text: String) async throws {
        try await task.send(.string(text))
    }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
    }
}

// MARK: - Backoff / sleeping

/// 再接続の待ち時間: `initial * multiplier^attempt` を `maximum` で頭打ち (既定 1, 2, 4, 8, 16, 30, 30, … 秒)。
public struct BackoffPolicy: Equatable, Sendable {
    public var initial: Double
    public var multiplier: Double
    public var maximum: Double

    public init(initial: Double = 1, multiplier: Double = 2, maximum: Double = 30) {
        self.initial = initial
        self.multiplier = multiplier
        self.maximum = maximum
    }

    public func delay(forAttempt attempt: Int) -> Double {
        let raw = initial * pow(multiplier, Double(max(0, attempt)))
        guard raw.isFinite else { return maximum }
        return min(maximum, max(0, raw))
    }
}

public protocol Sleeper: Sendable {
    func sleep(seconds: Double) async throws
}

public struct TaskSleeper: Sleeper {
    public init() {}
    public func sleep(seconds: Double) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

// MARK: - Stream client

public enum EventStreamState: Equatable, Sendable {
    case connecting
    /// 接続後、最初のメッセージ (通常 hello) を受信した。
    case connected
    /// 切断された。`retryIn` 秒後に再接続する (`attempt` は連続失敗回数, 1 始まり)。
    case waiting(retryIn: Double, attempt: Int)
    /// 401 で拒否された。再接続しない。
    case unauthorized
}

public enum EventStreamSignal: Equatable, Sendable {
    case state(EventStreamState)
    case event(RelayEvent)
}

public protocol EventStreaming: AnyObject, Sendable {
    func start(handler: @escaping @Sendable (EventStreamSignal) async -> Void)
    func stop()
}

/// `/v1/events` に接続し続けるクライアント。
///
/// - 切断・接続失敗時は `BackoffPolicy` に従って再接続する。メッセージを1つでも受信できたら失敗回数をリセットする。
/// - 401 (`RelayError.unauthorized`) の場合は `.state(.unauthorized)` を通知して終了する (再接続しない)。
/// - `stop()` 後は再接続せず、以後 handler も呼ばない。再開するには新しいインスタンスを作る。
/// - 解釈できないメッセージ・未知の type・`pong` は handler に渡さない。
public final class EventStreamClient: EventStreaming, @unchecked Sendable {
    private let request: URLRequest
    private let connector: any WebSocketConnector
    private let backoff: BackoffPolicy
    private let sleeper: any Sleeper
    private let pingInterval: Double?

    private let lock = NSLock()
    private var stopped = false
    private var task: Task<Void, Never>?
    private var current: (any WebSocketConnection)?

    public init(
        endpoint: RelayEndpoint, deviceToken: String,
        connector: any WebSocketConnector = URLSessionWebSocketConnector(),
        backoff: BackoffPolicy = BackoffPolicy(),
        sleeper: any Sleeper = TaskSleeper(),
        pingInterval: Double? = 25
    ) {
        var request = URLRequest(url: endpoint.eventsURL)
        request.setValue("Bearer \(deviceToken)", forHTTPHeaderField: "Authorization")
        self.request = request
        self.connector = connector
        self.backoff = backoff
        self.sleeper = sleeper
        self.pingInterval = pingInterval
    }

    public var isStopped: Bool { lock.withLock { stopped } }

    public func start(handler: @escaping @Sendable (EventStreamSignal) async -> Void) {
        lock.withLock {
            guard task == nil, !stopped else { return }
            task = Task { [self] in await run(handler: handler) }
        }
    }

    public func stop() {
        let (task, connection) = lock.withLock { () -> (Task<Void, Never>?, (any WebSocketConnection)?) in
            stopped = true
            defer { self.task = nil; current = nil }
            return (self.task, current)
        }
        task?.cancel()
        connection?.close()
    }

    /// 接続ループ本体。`stop()` されるか 401 を受けるまで戻らない。
    public func run(handler: @escaping @Sendable (EventStreamSignal) async -> Void) async {
        var attempt = 0

        func emit(_ signal: EventStreamSignal) async {
            guard !isStopped else { return }
            await handler(signal)
        }

        while !isStopped, !Task.isCancelled {
            await emit(.state(.connecting))
            var connection: (any WebSocketConnection)?
            var pingTask: Task<Void, Never>?
            do {
                let opened = try await connector.connect(request)
                connection = opened
                let accepted = lock.withLock { () -> Bool in
                    if stopped { return false }
                    current = opened
                    return true
                }
                guard accepted else {
                    opened.close()
                    return
                }
                pingTask = startPing(on: opened)
                var announced = false
                while true {
                    let frame = try await opened.receive()
                    let text: String
                    switch frame {
                    case .text(let value): text = value
                    case .data(let data): text = String(decoding: data, as: UTF8.self)
                    }
                    guard let event = RelayEvent.decode(text: text) else { continue }
                    attempt = 0
                    if !announced {
                        announced = true
                        await emit(.state(.connected))
                    }
                    switch event {
                    case .pong, .unknown: continue
                    case .hello, .created, .updated: await emit(.event(event))
                    }
                }
            } catch {
                pingTask?.cancel()
                connection?.close()
                lock.withLock { current = nil }
                if isStopped || Task.isCancelled { return }
                if let relayError = error as? RelayError, relayError == .unauthorized {
                    await emit(.state(.unauthorized))
                    lock.withLock { stopped = true }
                    return
                }
            }

            let delay = backoff.delay(forAttempt: attempt)
            attempt += 1
            await emit(.state(.waiting(retryIn: delay, attempt: attempt)))
            do {
                try await sleeper.sleep(seconds: delay)
            } catch {
                return
            }
        }
    }

    private func startPing(on connection: any WebSocketConnection) -> Task<Void, Never>? {
        guard let pingInterval else { return nil }
        let sleeper = self.sleeper
        return Task {
            while !Task.isCancelled {
                do {
                    try await sleeper.sleep(seconds: pingInterval)
                    try await connection.send(text: #"{"type":"ping"}"#)
                } catch {
                    // 送れなければ切断扱いにして再接続させる (キャンセル時は何もしない)。
                    if !Task.isCancelled { connection.close() }
                    return
                }
            }
        }
    }
}
