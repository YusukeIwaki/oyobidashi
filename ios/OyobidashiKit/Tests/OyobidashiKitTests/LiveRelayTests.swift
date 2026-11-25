import XCTest
@testable import OyobidashiKit

/// 本物の relay に対する結合テスト。`integration/` のハーネスが環境変数を渡して起動する。
/// 環境変数が無ければスキップされる (通常の `swift test` では実行されない)。
///
/// - OYOBIDASHI_LIVE_PAIRING_URI: `relay pair` が出力した oyobidashi://pair?...
/// - OYOBIDASHI_LIVE_REQUEST_ID: ハーネスが作成済みの pending な質問の id
final class LiveRelayTests: XCTestCase {
    private actor Signals {
        var events: [RelayEvent] = []
        func add(_ event: RelayEvent) { events.append(event) }
        func first(where predicate: @Sendable (RelayEvent) -> Bool) -> RelayEvent? { events.first(where: predicate) }
    }

    private func waitFor(_ signals: Signals, timeout: Double = 5, _ predicate: @escaping @Sendable (RelayEvent) -> Bool) async -> RelayEvent? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let event = await signals.first(where: predicate) { return event }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return nil
    }

    func testPairListReceiveAnswerAndUnpair() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let uri = env["OYOBIDASHI_LIVE_PAIRING_URI"], !uri.isEmpty,
              let requestID = env["OYOBIDASHI_LIVE_REQUEST_ID"], !requestID.isEmpty else {
            throw XCTSkip("live relay env not set")
        }

        let info = try PairingInfo.parse(uri: uri)

        // ペアリング
        let anonymous = RelayClient(endpoint: info.endpoint, deviceToken: nil)
        let paired = try await anonymous.pair(PairRequestBody(code: info.code, deviceName: "live-ios", platform: .ios, pushEnvironment: .development))
        XCTAssertFalse(paired.deviceToken.isEmpty)
        let client = RelayClient(endpoint: info.endpoint, deviceToken: paired.deviceToken)

        // 使用済みコードは pairingCodeInvalid
        do {
            _ = try await anonymous.pair(PairRequestBody(code: info.code, deviceName: "again"))
            XCTFail("reused code must fail")
        } catch let error as RelayError {
            XCTAssertEqual(error, .pairingCodeInvalid)
        }

        // healthz
        _ = try await client.health()

        // 一覧に pending の質問がある
        let pending = try await client.listRequests(status: .pending)
        let target = try XCTUnwrap(pending.first { $0.id == requestID })
        XCTAssertEqual(target.status, .pending)
        XCTAssertEqual(target.kind, .question)
        if let subject = env["OYOBIDASHI_LIVE_SUBJECT"] {
            XCTAssertEqual(target.subject, subject)
            XCTAssertEqual(target.incomingCallerName, "apps-e2e：\(subject)")
        }

        // WebSocket: hello に同じ質問が入っている
        let signals = Signals()
        let stream = EventStreamClient(endpoint: info.endpoint, deviceToken: paired.deviceToken)
        stream.start { signal in
            if case .event(let event) = signal { await signals.add(event) }
        }
        let hello = await waitFor(signals) { if case .hello = $0 { return true } else { return false } }
        guard case .hello(let helloPending, _)? = hello else { return XCTFail("hello must arrive") }
        XCTAssertTrue(helloPending.contains { $0.id == requestID })
        if let subject = env["OYOBIDASHI_LIVE_SUBJECT"] {
            XCTAssertEqual(helloPending.first { $0.id == requestID }?.subject, subject)
        }

        // 音声で回答 → answered、WebSocket に updated
        let answered = try await client.answer(requestID: requestID, body: AnswerBody(text: "iOSから回答", inputMethod: .voice))
        XCTAssertEqual(answered.status, .answered)
        XCTAssertEqual(answered.answer?.text, "iOSから回答")
        XCTAssertEqual(answered.answer?.inputMethod, .voice)
        XCTAssertEqual(answered.answer?.deviceID, paired.device.id)
        let updated = await waitFor(signals) {
            if case .updated(let request) = $0 { return request.id == requestID && request.status == .answered }
            return false
        }
        XCTAssertNotNil(updated, "request.updated must arrive")

        // 二重回答は alreadyResolved
        do {
            _ = try await client.answer(requestID: requestID, body: AnswerBody(text: "もう一度", inputMethod: .text))
            XCTFail("second answer must fail")
        } catch let error as RelayError {
            XCTAssertEqual(error, .alreadyResolved)
        }
        let fetched = try await client.getRequest(id: requestID)
        XCTAssertEqual(fetched.status, .answered)
        if let subject = env["OYOBIDASHI_LIVE_SUBJECT"] {
            XCTAssertEqual(fetched.subject, subject)
        }

        // 存在しない id は notFound
        do {
            _ = try await client.getRequest(id: "req_does_not_exist")
            XCTFail("must be not found")
        } catch let error as RelayError {
            XCTAssertEqual(error, .notFound)
        }

        // ペアリング解除後は unauthorized
        stream.stop()
        try await client.deleteDevice()
        do {
            _ = try await client.listRequests()
            XCTFail("must be unauthorized after unpair")
        } catch let error as RelayError {
            XCTAssertEqual(error, .unauthorized)
        }
    }
}
