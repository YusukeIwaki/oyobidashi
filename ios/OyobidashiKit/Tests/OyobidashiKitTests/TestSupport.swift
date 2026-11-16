import Foundation
import XCTest
@testable import OyobidashiKit

// MARK: - Fixtures (docs/fixtures を直接読む。コピーしない)

enum Fixtures {
    static let directory: URL = {
        // …/ios/OyobidashiKit/Tests/OyobidashiKitTests/TestSupport.swift → リポジトリルート
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() }
        return url.appendingPathComponent("docs/fixtures", isDirectory: true)
    }()

    static func data(_ name: String) -> Data {
        let url = directory.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else {
            fatalError("fixture not found: \(url.path)")
        }
        return data
    }

    static func string(_ name: String) -> String {
        String(decoding: data(name), as: UTF8.self)
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try OyobidashiJSON.makeDecoder().decode(type, from: data(name))
    }

    static func request(_ name: String) -> AgentRequest {
        try! decode(AgentRequest.self, name)
    }
}

/// JSON を構造として比較する (キー順・空白を無視)。
func assertJSONEqual(_ actual: Data?, _ expected: Data, file: StaticString = #filePath, line: UInt = #line) {
    guard let actual else { return XCTFail("actual is nil", file: file, line: line) }
    guard
        let a = try? JSONSerialization.jsonObject(with: actual, options: [.fragmentsAllowed]),
        let e = try? JSONSerialization.jsonObject(with: expected, options: [.fragmentsAllowed])
    else { return XCTFail("not JSON: \(String(decoding: actual, as: UTF8.self))", file: file, line: line) }
    XCTAssertTrue(
        (a as AnyObject).isEqual(e),
        "JSON mismatch:\n actual: \(String(decoding: actual, as: UTF8.self))\n expected: \(String(decoding: expected, as: UTF8.self))",
        file: file, line: line
    )
}

func encodeJSON<T: Encodable>(_ value: T) -> Data {
    try! OyobidashiJSON.makeEncoder().encode(value)
}

func date(_ string: String) -> Date {
    OyobidashiJSON.parseDate(string)!
}

func makeRequest(
    id: String = "req_1", kind: RequestKind = .question, status: RequestStatus = .pending,
    created: String = "2026-11-15T14:00:00.000Z", updated: String? = nil, choices: [String]? = nil, answer: Answer? = nil
) -> AgentRequest {
    AgentRequest(
        id: id, kind: kind, question: "Q \(id)", choices: choices, status: status, answer: answer,
        createdAt: date(created), updatedAt: updated.map(date)
    )
}

func requestEnvelope(_ request: AgentRequest) -> Data {
    Data(#"{"request":"#.utf8) + encodeJSON(request) + Data("}".utf8)
}

func listEnvelope(_ requests: [AgentRequest]) -> Data {
    Data(#"{"requests":"#.utf8) + encodeJSON(requests) + Data("}".utf8)
}

func errorBody(_ code: String, _ message: String = "msg") -> Data {
    Data(#"{"error":{"code":"\#(code)","message":"\#(message)"}}"#.utf8)
}

// MARK: - HTTP stub

final class StubTransport: HTTPTransport, @unchecked Sendable {
    struct Response {
        var status: Int
        var body: Data
        init(_ status: Int, _ body: Data = Data()) {
            self.status = status
            self.body = body
        }
    }

    typealias Handler = (URLRequest) throws -> Response

    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    private var routes: [String: Handler] = [:]
    private var fallback: Handler = { request in
        Response(599, Data("no stub for \(request.httpMethod ?? "?") \(request.url?.path ?? "?")".utf8))
    }

    var requests: [URLRequest] { lock.withLock { recorded } }

    /// "METHOD /path" ごとの応答を設定する。
    func on(_ method: String, _ path: String, _ handler: @escaping Handler) {
        lock.withLock { routes["\(method) \(path)"] = handler }
    }

    func on(_ method: String, _ path: String, status: Int, body: Data = Data()) {
        on(method, path) { _ in Response(status, body) }
    }

    func onAny(_ handler: @escaping Handler) {
        lock.withLock { fallback = handler }
    }

    func requests(_ method: String, _ path: String) -> [URLRequest] {
        requests.filter { $0.httpMethod == method && $0.url?.path == path }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let handler = lock.withLock { () -> Handler in
            recorded.append(request)
            return routes["\(request.httpMethod ?? "") \(request.url?.path ?? "")"] ?? fallback
        }
        let response = try handler(request)
        let http = HTTPURLResponse(url: request.url!, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (response.body, http)
    }
}

// MARK: - Notifications fake

@MainActor
final class FakeNotifications: NotificationManaging {
    var removed: [String] = []
    var removedAllCount = 0
    var presented: [String] = []

    func removeDelivered(requestIDs: [String]) { removed.append(contentsOf: requestIDs) }
    func removeAllDelivered() { removedAllCount += 1 }
    var replyFailures: [(id: String, reason: ReplyFailureReason)] = []

    func presentIncoming(_ request: AgentRequest) { presented.append(request.id) }
    func presentReplyFailure(requestID: String, reason: ReplyFailureReason) { replyFailures.append((requestID, reason)) }
}

// MARK: - Event stream fakes

struct ConnectionClosed: Error {}

final class FakeConnection: WebSocketConnection, @unchecked Sendable {
    private let continuation: AsyncStream<Result<WebSocketFrame, Error>>.Continuation
    private var iterator: AsyncStream<Result<WebSocketFrame, Error>>.AsyncIterator
    private let lock = NSLock()
    private var sentTexts: [String] = []
    private var isClosed = false

    init() {
        let (stream, continuation) = AsyncStream<Result<WebSocketFrame, Error>>.makeStream()
        self.continuation = continuation
        self.iterator = stream.makeAsyncIterator()
    }

    var sent: [String] { lock.withLock { sentTexts } }
    var closed: Bool { lock.withLock { isClosed } }

    @discardableResult func push(_ text: String) -> FakeConnection {
        continuation.yield(.success(.text(text)))
        return self
    }

    @discardableResult func push(data: Data) -> FakeConnection {
        continuation.yield(.success(.data(data)))
        return self
    }

    @discardableResult func fail(_ error: Error = URLError(.networkConnectionLost)) -> FakeConnection {
        continuation.yield(.failure(error))
        return self
    }

    func receive() async throws -> WebSocketFrame {
        guard let next = await iterator.next() else { throw ConnectionClosed() }
        return try next.get()
    }

    func send(text: String) async throws {
        try lock.withLock {
            if isClosed { throw ConnectionClosed() }
            sentTexts.append(text)
        }
    }

    func close() {
        lock.withLock { isClosed = true }
        continuation.finish()
    }
}

/// 接続ごとの結果を順に返す。使い切ったら `exhausted` を throw する (既定: unauthorized = ループ終了)。
final class FakeConnector: WebSocketConnector, @unchecked Sendable {
    enum Step {
        case open(FakeConnection)
        case fail(Error)
    }

    private let lock = NSLock()
    private var steps: [Step]
    private var recorded: [URLRequest] = []
    var exhausted: Error = RelayError.unauthorized

    init(_ steps: [Step] = []) {
        self.steps = steps
    }

    var requests: [URLRequest] { lock.withLock { recorded } }
    var connectCount: Int { requests.count }

    func connect(_ request: URLRequest) async throws -> any WebSocketConnection {
        let step = lock.withLock { () -> Step? in
            recorded.append(request)
            return steps.isEmpty ? nil : steps.removeFirst()
        }
        switch step {
        case .open(let connection): return connection
        case .fail(let error): throw error
        case nil: throw exhausted
        }
    }
}

final class RecordingSleeper: Sleeper, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [Double] = []
    /// n 回目 (0始まり) 以降の sleep をキャンセルされるまでブロックする。
    var blockFromCall: Int?

    var delays: [Double] { lock.withLock { recorded } }

    func sleep(seconds: Double) async throws {
        let index = lock.withLock { () -> Int in
            recorded.append(seconds)
            return recorded.count - 1
        }
        if let blockFromCall, index >= blockFromCall {
            try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
    }
}

final class SignalCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var collected: [EventStreamSignal] = []

    var signals: [EventStreamSignal] { lock.withLock { collected } }

    func handler() -> @Sendable (EventStreamSignal) async -> Void {
        { [self] signal in lock.withLock { collected.append(signal) } }
    }
}

/// AppModel テスト用: 手動でシグナルを流し込めるストリーム。
final class FakeStream: EventStreaming, @unchecked Sendable {
    private let lock = NSLock()
    private var handler: (@Sendable (EventStreamSignal) async -> Void)?
    private var started = false
    private var stoppedFlag = false

    var isStarted: Bool { lock.withLock { started } }
    var isStopped: Bool { lock.withLock { stoppedFlag } }

    func start(handler: @escaping @Sendable (EventStreamSignal) async -> Void) {
        lock.withLock {
            started = true
            self.handler = handler
        }
    }

    func stop() {
        lock.withLock { stoppedFlag = true }
    }

    /// stop 後でも handler を呼ぶ (遅れて届いたシグナルを模擬できるように)。
    func emit(_ signal: EventStreamSignal) async {
        let handler = lock.withLock { self.handler }
        await handler?(signal)
    }
}

// MARK: - Async helpers

/// 条件が満たされるまで待つ (満たされなければ false)。
func eventually(timeout: Double = 3, _ condition: @escaping @Sendable () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    return await condition()
}
