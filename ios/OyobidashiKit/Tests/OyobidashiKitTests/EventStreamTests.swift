import XCTest
@testable import OyobidashiKit

final class EventStreamTests: XCTestCase {
    private let endpoint = try! RelayEndpoint("http://192.168.1.10:8787")

    private func makeClient(_ connector: FakeConnector, sleeper: RecordingSleeper = RecordingSleeper(), ping: Double? = nil, base: RelayEndpoint? = nil) -> EventStreamClient {
        EventStreamClient(endpoint: base ?? endpoint, deviceToken: "kd_token", connector: connector, backoff: BackoffPolicy(), sleeper: sleeper, pingInterval: ping)
    }

    // MARK: Decoding

    func testEventDecoding() {
        XCTAssertEqual(RelayEvent.decode(text: Fixtures.string("event_hello.json")), .hello(pending: [Fixtures.request("request_pending.json")]))
        XCTAssertEqual(RelayEvent.decode(text: #"{"type":"hello"}"#), .hello(pending: []))
        XCTAssertEqual(RelayEvent.decode(text: #"{"type":"hello","pending":null}"#), .hello(pending: []))
        XCTAssertEqual(RelayEvent.decode(text: #"{"type":"hello","pending":[{"broken":1}],"server_time":"x"}"#), .hello(pending: []))
        XCTAssertEqual(RelayEvent.decode(text: #"{"type":"pong"}"#), .pong)
        XCTAssertEqual(RelayEvent.decode(text: #"{"type":"pong","extra":1}"#), .pong)
        XCTAssertEqual(RelayEvent.decode(text: #"{"type":"request.deleted","request":{"id":"x"}}"#), .unknown(type: "request.deleted"))
        let created = String(decoding: Data(#"{"type":"request.created","request":"#.utf8) + Fixtures.data("request_notification.json") + Data("}".utf8), as: UTF8.self)
        XCTAssertEqual(RelayEvent.decode(text: created), .created(Fixtures.request("request_notification.json")))
    }

    func testMalformedEventsDecodeToNil() {
        XCTAssertNil(RelayEvent.decode(text: ""))
        XCTAssertNil(RelayEvent.decode(text: "not json"))
        XCTAssertNil(RelayEvent.decode(text: "[]"))
        XCTAssertNil(RelayEvent.decode(text: "{}"))
        XCTAssertNil(RelayEvent.decode(text: #"{"type":42}"#))
        XCTAssertNil(RelayEvent.decode(text: #"{"type":"request.created"}"#))
        XCTAssertNil(RelayEvent.decode(text: #"{"type":"request.updated","request":{"id":"only-id"}}"#))
        XCTAssertNil(RelayEvent.decode(text: #"{"type":"request.updated","request":null}"#))
    }

    // MARK: Request

    func testConnectRequestUsesWebSocketSchemeDerivedFromBaseURLAndBearerHeader() async throws {
        let cases: [(String, String)] = [
            ("http://192.168.1.10:8787", "ws://192.168.1.10:8787/v1/events"),
            ("https://relay.example", "wss://relay.example/v1/events"),
            ("http://my-mac.local:8787/prefix/", "ws://my-mac.local:8787/prefix/v1/events"),
        ]
        for (base, expected) in cases {
            let connector = FakeConnector()
            await makeClient(connector, base: try RelayEndpoint(base)).run(handler: { _ in })
            let request = try XCTUnwrap(connector.requests.first)
            XCTAssertEqual(request.url?.absoluteString, expected)
            XCTAssertNil(request.url?.query, "トークンをURLに載せない")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
        }
    }

    // MARK: Delivery

    func testDeliversKnownEventsAndIgnoresUnknownMalformedAndPong() async throws {
        let created = Data(#"{"type":"request.created","request":"#.utf8) + Fixtures.data("request_notification.json") + Data("}".utf8)
        let connection = FakeConnection()
            .push(Fixtures.string("event_hello.json"))
            .push(#"{"type":"mystery","x":1}"#)
            .push("not json")
            .push(#"{"type":"pong"}"#)
            .push(#"{"type":"request.created"}"#)
            .push(Fixtures.string("event_request_updated.json"))
            .push(data: created)
            .fail(RelayError.unauthorized)
        let connector = FakeConnector([.open(connection)])
        let collector = SignalCollector()
        await makeClient(connector).run(handler: collector.handler())

        guard case .updated(let updated) = RelayEvent.decode(text: Fixtures.string("event_request_updated.json")) else { return XCTFail() }
        XCTAssertEqual(collector.signals, [
            .state(.connecting),
            .state(.connected),
            .event(.hello(pending: [Fixtures.request("request_pending.json")])),
            .event(.updated(updated)),
            .event(.created(Fixtures.request("request_notification.json"))),
            .state(.unauthorized),
        ])
        XCTAssertTrue(connection.closed)
    }

    // MARK: Backoff

    func testBackoffPolicy() {
        let policy = BackoffPolicy()
        XCTAssertEqual((0..<8).map(policy.delay(forAttempt:)), [1, 2, 4, 8, 16, 30, 30, 30])
        XCTAssertEqual(policy.delay(forAttempt: -3), 1)
        XCTAssertEqual(policy.delay(forAttempt: 100_000), 30)
        XCTAssertEqual(BackoffPolicy(initial: 0.5, multiplier: 3, maximum: 10).delay(forAttempt: 2), 4.5)
        XCTAssertEqual(BackoffPolicy(initial: 0.5, multiplier: 3, maximum: 10).delay(forAttempt: 3), 10)
    }

    func testReconnectsWithExponentialBackoffWhenConnectFails() async {
        let connector = FakeConnector(Array(repeating: .fail(URLError(.cannotConnectToHost)), count: 7))
        let sleeper = RecordingSleeper()
        let collector = SignalCollector()
        await makeClient(connector, sleeper: sleeper).run(handler: collector.handler())

        XCTAssertEqual(sleeper.delays, [1, 2, 4, 8, 16, 30, 30])
        XCTAssertEqual(connector.connectCount, 8)
        XCTAssertEqual(Array(collector.signals.prefix(4)), [
            .state(.connecting), .state(.waiting(retryIn: 1, attempt: 1)),
            .state(.connecting), .state(.waiting(retryIn: 2, attempt: 2)),
        ])
        XCTAssertEqual(collector.signals.last, .state(.unauthorized))
    }

    func testBackoffResetsAfterAMessageIsReceived() async {
        let connector = FakeConnector([
            .fail(URLError(.cannotConnectToHost)),
            .fail(URLError(.cannotConnectToHost)),
            .open(FakeConnection().push(Fixtures.string("event_hello.json")).fail()),
            .fail(URLError(.cannotConnectToHost)),
        ])
        let sleeper = RecordingSleeper()
        await makeClient(connector, sleeper: sleeper).run(handler: { _ in })
        XCTAssertEqual(sleeper.delays, [1, 2, 1, 2])
    }

    func testBackoffKeepsGrowingWhenConnectionsDropBeforeAnyMessage() async {
        let connector = FakeConnector([
            .open(FakeConnection().fail()),
            .open(FakeConnection().push("garbage").fail()),
            .open(FakeConnection().fail()),
        ])
        let sleeper = RecordingSleeper()
        let collector = SignalCollector()
        await makeClient(connector, sleeper: sleeper).run(handler: collector.handler())
        XCTAssertEqual(sleeper.delays, [1, 2, 4])
        XCTAssertFalse(collector.signals.contains(.state(.connected)))
    }

    // MARK: Auth failure

    func testUnauthorizedOnConnectStopsWithoutRetry() async {
        let connector = FakeConnector([.fail(RelayError.unauthorized), .open(FakeConnection())])
        let sleeper = RecordingSleeper()
        let collector = SignalCollector()
        let client = makeClient(connector, sleeper: sleeper)
        await client.run(handler: collector.handler())

        XCTAssertEqual(collector.signals, [.state(.connecting), .state(.unauthorized)])
        XCTAssertEqual(connector.connectCount, 1)
        XCTAssertEqual(sleeper.delays, [])
        XCTAssertTrue(client.isStopped)
    }

    func testUnauthorizedOnFirstReceiveStopsWithoutRetry() async {
        // URLSession は upgrade の拒否を最初の receive で報告する。
        let connection = FakeConnection().fail(RelayError.unauthorized)
        let connector = FakeConnector([.open(connection), .open(FakeConnection())])
        let sleeper = RecordingSleeper()
        let collector = SignalCollector()
        await makeClient(connector, sleeper: sleeper).run(handler: collector.handler())

        XCTAssertEqual(collector.signals, [.state(.connecting), .state(.unauthorized)])
        XCTAssertEqual(connector.connectCount, 1)
        XCTAssertEqual(sleeper.delays, [])
        XCTAssertTrue(connection.closed)
    }

    func testOtherRelayErrorsAreRetried() async {
        let connector = FakeConnector([.fail(RelayError.forbidden), .fail(RelayError.server(message: nil))])
        let sleeper = RecordingSleeper()
        await makeClient(connector, sleeper: sleeper).run(handler: { _ in })
        XCTAssertEqual(sleeper.delays, [1, 2])
        XCTAssertEqual(connector.connectCount, 3)
    }

    // MARK: Stop

    func testStopClosesConnectionAndDoesNotReconnect() async {
        let connection = FakeConnection().push(Fixtures.string("event_hello.json"))
        let connector = FakeConnector([.open(connection), .open(FakeConnection())])
        let sleeper = RecordingSleeper()
        let collector = SignalCollector()
        let client = makeClient(connector, sleeper: sleeper)
        client.start(handler: collector.handler())

        let gotHello = await eventually { collector.signals.count == 3 }
        XCTAssertTrue(gotHello)
        client.stop()
        let closed = await eventually { connection.closed }
        XCTAssertTrue(closed)

        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(connector.connectCount, 1, "stop 後は再接続しない")
        XCTAssertEqual(sleeper.delays, [])
        XCTAssertEqual(collector.signals.count, 3, "stop 後は handler を呼ばない")
        XCTAssertTrue(client.isStopped)
    }

    func testStopDuringBackoffDoesNotReconnect() async {
        let connector = FakeConnector([.fail(URLError(.cannotConnectToHost)), .open(FakeConnection())])
        let sleeper = RecordingSleeper()
        sleeper.blockFromCall = 0
        let client = makeClient(connector, sleeper: sleeper)
        client.start(handler: { _ in })

        let sleeping = await eventually { sleeper.delays == [1] }
        XCTAssertTrue(sleeping)
        client.stop()
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(connector.connectCount, 1)
    }

    func testStartAfterStopAndDoubleStartAreIgnored() async {
        let connection = FakeConnection()
        let connector = FakeConnector([.open(connection), .open(FakeConnection())])
        let client = makeClient(connector)
        client.start(handler: { _ in })
        client.start(handler: { _ in })
        let connected = await eventually { connector.connectCount == 1 }
        XCTAssertTrue(connected)
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(connector.connectCount, 1)

        client.stop()
        client.start(handler: { _ in })
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(connector.connectCount, 1)
    }

    func testStopBeforeStartNeverConnects() async {
        let connector = FakeConnector([.open(FakeConnection())])
        let client = makeClient(connector)
        client.stop()
        await client.run(handler: { _ in })
        XCTAssertEqual(connector.connectCount, 0)
    }

    // MARK: Ping

    func testSendsApplicationLevelPing() async {
        let connection = FakeConnection().push(Fixtures.string("event_hello.json"))
        let connector = FakeConnector([.open(connection)])
        let sleeper = RecordingSleeper()
        sleeper.blockFromCall = 2 // 2回 ping を送ったあとは待ち続ける
        let client = makeClient(connector, sleeper: sleeper, ping: 25)
        client.start(handler: { _ in })

        let pinged = await eventually { connection.sent.count == 2 }
        XCTAssertTrue(pinged)
        XCTAssertEqual(connection.sent, [#"{"type":"ping"}"#, #"{"type":"ping"}"#])
        XCTAssertEqual(Array(sleeper.delays.prefix(2)), [25, 25])
        client.stop()
    }
}
