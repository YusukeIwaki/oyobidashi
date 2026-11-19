import XCTest
@testable import OyobidashiKit

final class ExtensionsTests: XCTestCase {
    private func decodeRequest(_ json: String) throws -> AgentRequest {
        try OyobidashiJSON.makeDecoder().decode(AgentRequest.self, from: Data(json.utf8))
    }

    func testOldFixtureDefaults() throws {
        // フィクスチャ自体は新契約 (actions) を含む場合がある。欠落時のデフォルトは下のケースで担保する。
        let r = try Fixtures.decode(AgentRequest.self, "request_pending.json")
        XCTAssertEqual(r.priority, .normal)
        XCTAssertEqual(r.requestedMode, .auto)
        XCTAssertNil(r.call)
        // 欠落フィールドは後方互換デフォルトで埋まる
        let legacy = try decodeRequest(#"{"id":"old","question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z"}"#)
        XCTAssertEqual(legacy.priority, .normal)
        XCTAssertEqual(legacy.deliveryMode, .text)
        XCTAssertEqual(legacy.requestedMode, .auto)
        XCTAssertNil(legacy.call)
    }

    func testNewFieldsDecode() throws {
        let r = try decodeRequest("""
        {"id":"r1","kind":"question","question":"q","status":"pending","priority":"urgent","delivery_mode":"call","requested_mode":"call",
         "created_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z",
         "call":{"id":"11111111-1111-1111-1111-111111111111","request_id":"r1","state":"ringing","outcome":null,"device_id":null,
                 "started_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z",
                 "transcript":[{"role":"assistant","text":"hello"},{"role":"user","text":"hi"}]}}
        """)
        XCTAssertEqual(r.priority, .urgent)
        XCTAssertEqual(r.deliveryMode, .call)
        XCTAssertEqual(r.requestedMode, .call)
        XCTAssertEqual(r.call?.state, .ringing)
        XCTAssertTrue(r.call?.isRinging ?? false)
        XCTAssertEqual(r.call?.transcript.count, 2)
        XCTAssertEqual(r.call?.transcript.first?.role, .assistant)
        XCTAssertTrue(r.hasLiveCall)
    }

    func testCallNullAndUnknownValues() throws {
        let r = try decodeRequest("""
        {"id":"r","question":"q","status":"pending","priority":"critical","delivery_mode":"hologram","requested_mode":"auto","call":null,"created_at":"2026-11-15T14:00:00.000Z"}
        """)
        XCTAssertEqual(r.priority, .unknown("critical"))
        XCTAssertEqual(r.deliveryMode, .unknown("hologram"))
        XCTAssertNil(r.call)
        // round-trip preserves unknown raw values
        let re = try OyobidashiJSON.makeDecoder().decode(AgentRequest.self, from: encodeJSON(r))
        XCTAssertEqual(re, r)
    }

    func testDeviceUpdateVoipIndependent() {
        assertJSONEqual(encodeJSON(DeviceUpdateBody(voipToken: .set("v1"))), Data(#"{"voip_token":"v1"}"#.utf8))
        assertJSONEqual(encodeJSON(DeviceUpdateBody(pushToken: .set("p"), voipToken: .set("v"))), Data(#"{"push_token":"p","voip_token":"v"}"#.utf8))
        assertJSONEqual(encodeJSON(DeviceUpdateBody(voipToken: .clear)), Data(#"{"voip_token":null}"#.utf8))
        assertJSONEqual(encodeJSON(DeviceUpdateBody()), Data("{}".utf8))
    }

    func testPresenceBodyEncoding() {
        let body = PresenceUpdateBody(availability: .busy, until: .set(date("2026-11-15T14:30:00.000Z")), note: .set("会議中"))
        let json = String(decoding: encodeJSON(body), as: UTF8.self)
        XCTAssertTrue(json.contains("\"availability\":\"busy\""))
        XCTAssertTrue(json.contains("2026-11-15T14:30:00.000Z"))
        let clear = PresenceUpdateBody(availability: .available, until: .clear, note: .clear)
        assertJSONEqual(encodeJSON(clear), Data(#"{"availability":"available","until":null,"note":null}"#.utf8))
    }

    func testPresenceResponseDecodeAndExpiry() throws {
        let json = """
        {"devices":[{"device_id":"dev_01","availability":"busy","until":"2026-11-15T14:30:00.000Z","note":"x","updated_at":"2026-11-15T14:00:00.000Z","last_seen_at":"2026-11-15T14:00:00.000Z"}],
         "recent_events":[{"request_id":"r1","device_id":"dev_01","event":"declined","at":"2026-11-15T14:01:00.000Z"}],
         "now":"2026-11-15T14:00:00.000Z"}
        """
        let resp = try OyobidashiJSON.makeDecoder().decode(PresenceResponse.self, from: Data(json.utf8))
        XCTAssertEqual(resp.devices.first?.availability, .busy)
        XCTAssertEqual(resp.devices.first?.effectiveAvailability(now: date("2026-11-15T14:00:00.000Z")), .busy)
        XCTAssertEqual(resp.devices.first?.effectiveAvailability(now: date("2026-11-15T15:00:00.000Z")), .available)
        XCTAssertEqual(resp.recentEvents.first?.event, "declined")
    }

    func testCallEventBodyEncoding() {
        assertJSONEqual(encodeJSON(CallEventBody(event: .answer)), Data(#"{"event":"answer"}"#.utf8))
        assertJSONEqual(encodeJSON(CallEventBody(event: .turn, text: "はい")), Data(#"{"event":"turn","text":"はい"}"#.utf8))
        assertJSONEqual(encodeJSON(CallEventBody(event: .decline)), Data(#"{"event":"decline"}"#.utf8))
    }

    func testVoIPPayloadParsing() {
        XCTAssertNotNil(VoIPPayload(userInfo: ["request_id": "r", "call_id": "c", "question": "q"]))
        XCTAssertNil(VoIPPayload(userInfo: ["request_id": "r"]))
        XCTAssertNil(VoIPPayload(userInfo: ["call_id": "c"]))
        let p = PushPayload(userInfo: ["request_id": "r", "call_id": "c9", "question": "qq"])
        XCTAssertEqual(p?.callID, "c9")
    }

    // MARK: Call reconciler

    private func callRequest(state: String, outcome: String? = nil, deviceID: String? = nil, status: String = "pending") -> AgentRequest {
        let outcomeJSON = outcome.map { "\"\($0)\"" } ?? "null"
        let deviceJSON = deviceID.map { "\"\($0)\"" } ?? "null"
        return try! decodeRequest("""
        {"id":"req1","question":"q","status":"\(status)","priority":"high","delivery_mode":"call","requested_mode":"call",
         "created_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z",
         "call":{"id":"call-1","request_id":"req1","state":"\(state)","outcome":\(outcomeJSON),"device_id":\(deviceJSON),
                 "started_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z","transcript":[]}}
        """)
    }

    func testRingingReportedOnce() {
        let rec = CallReconciler()
        let req = callRequest(state: "ringing")
        guard case .reportRinging = rec.reconcile(request: req, myDeviceID: "dev_01") else { return XCTFail("expected report") }
        rec.markReported(callID: "call-1", requestID: "req1")
        XCTAssertEqual(rec.reconcile(request: req, myDeviceID: "dev_01"), .none)
    }

    func testRemoteEndedEndsCall() {
        let rec = CallReconciler()
        rec.markReported(callID: "call-1", requestID: "req1")
        let ended = callRequest(state: "ended", outcome: "cancelled")
        guard case .endCall(let cid, _, let reason) = rec.reconcile(request: ended, myDeviceID: "dev_01") else { return XCTFail() }
        XCTAssertEqual(cid, "call-1")
        XCTAssertEqual(reason, .cancelled)
        // second time no-op
        XCTAssertEqual(rec.reconcile(request: ended, myDeviceID: "dev_01"), .none)
    }

    func testAnsweredElsewhereStopsRinging() {
        let rec = CallReconciler()
        rec.markReported(callID: "call-1", requestID: "req1")
        let active = callRequest(state: "active", deviceID: "dev_other")
        guard case .endCall(_, _, .answeredElsewhere) = rec.reconcile(request: active, myDeviceID: "dev_01") else { return XCTFail() }
    }

    func testOwnActiveDoesNotEnd() {
        let rec = CallReconciler()
        rec.markReported(callID: "call-1", requestID: "req1")
        XCTAssertEqual(rec.reconcile(request: callRequest(state: "active", deviceID: "dev_01"), myDeviceID: "dev_01"), .none)
    }

    func testOwnActiveSnapshotAfterRestartRestoresWithoutIncomingRing() {
        let rec = CallReconciler()
        let request = callRequest(state: "active", deviceID: "dev_01")
        guard case .restoreActive(let call, _) = rec.reconcile(request: request, myDeviceID: "dev_01") else { return XCTFail("expected restore") }
        rec.markReported(callID: call.id, requestID: request.id)
        XCTAssertEqual(rec.reconcile(request: request, myDeviceID: "dev_01"), .none)
        let fresh = CallReconciler()
        XCTAssertEqual(fresh.reconcile(request: request, myDeviceID: "dev_other"), .none)
        XCTAssertEqual(fresh.reconcile(request: request, myDeviceID: nil), .none)
    }

    func testTerminalStatusEndsRinging() {
        let rec = CallReconciler()
        rec.markReported(callID: "call-1", requestID: "req1")
        guard case .endCall = rec.reconcile(request: callRequest(state: "ringing", status: "cancelled"), myDeviceID: "dev_01") else { return XCTFail() }
    }

    func testConversationPolicyNeverSendsPartial() {
        XCTAssertFalse(ConversationPolicy.shouldSendTurn(text: "はい", isFinal: false))
        XCTAssertFalse(ConversationPolicy.shouldSendTurn(text: "  ", isFinal: true))
        XCTAssertTrue(ConversationPolicy.shouldSendTurn(text: "はい", isFinal: true))
        XCTAssertFalse(ConversationPolicy.shouldEndAfterSpeaking(resolved: false))
        XCTAssertFalse(ConversationPolicy.shouldEndAfterSpeaking(resolved: nil))
        XCTAssertTrue(ConversationPolicy.shouldEndAfterSpeaking(resolved: true))
    }

    func testSpokenConsentRequiresAnExplicitFinalAnswer() {
        XCTAssertTrue(ConversationPolicy.grantsSpokenConsent(text: "同意します。", isFinal: true))
        XCTAssertFalse(ConversationPolicy.grantsSpokenConsent(text: "同意します", isFinal: false))
        XCTAssertFalse(ConversationPolicy.grantsSpokenConsent(text: "同意しません", isFinal: true))
        XCTAssertFalse(ConversationPolicy.grantsSpokenConsent(text: "同意しますか？", isFinal: true))
        XCTAssertFalse(ConversationPolicy.grantsSpokenConsent(text: "はい", isFinal: true))
    }

    func testNotificationPolicy() {
        XCTAssertEqual(NotificationPolicy.interruption(for: .low), .passive)
        XCTAssertEqual(NotificationPolicy.interruption(for: .normal), .active)
        XCTAssertEqual(NotificationPolicy.interruption(for: .high), .timeSensitive)
        XCTAssertEqual(NotificationPolicy.interruption(for: .urgent), .timeSensitive)
        // matching by userInfo when APNs identifier is arbitrary
        let delivered: [(identifier: String, userInfo: [AnyHashable: Any])] = [
            ("apns-xyz", ["request_id": "r1"]),
            ("apns-abc", ["request_id": "r2"]),
            ("r1", [:]),
        ]
        XCTAssertEqual(Set(NotificationPolicy.matchingIdentifiers(delivered: delivered, requestIDs: ["r1"])), Set(["apns-xyz", "r1"]))
        XCTAssertTrue(NotificationPolicy.matchingIdentifiers(delivered: delivered, requestIDs: []).isEmpty)
    }

    func testRelayClientCallAndPresence() async throws {
        let stub = StubTransport()
        let client = RelayClient(endpoint: try RelayEndpoint("https://relay.example"), deviceToken: "t", transport: stub)
        stub.on("POST", "/v1/requests/req1/call", status: 200, body: Data("""
        {"request":{"id":"req1","question":"q","status":"pending","created_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z","call":{"id":"call-1","request_id":"req1","state":"active","started_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z","transcript":[]}},
         "call":{"id":"call-1","request_id":"req1","state":"active","started_at":"2026-11-15T14:00:00.000Z","updated_at":"2026-11-15T14:00:00.000Z","transcript":[]},"reply":"質問です","resolved":false}
        """.utf8))
        let resp = try await client.answerCall(requestID: "req1")
        XCTAssertEqual(resp.reply, "質問です")
        XCTAssertEqual(resp.resolved, false)
        XCTAssertEqual(resp.call?.state, .active)
        assertJSONEqual(stub.requests.last?.httpBody, Data(#"{"event":"answer"}"#.utf8))

        stub.on("PUT", "/v1/presence", status: 200, body: Data(#"{"devices":[],"recent_events":[],"now":"2026-11-15T14:00:00.000Z"}"#.utf8))
        _ = try await client.updatePresence(PresenceUpdateBody(availability: .away, until: .clear, note: .clear))
        let put = stub.requests.last
        XCTAssertEqual(put?.httpMethod, "PUT")
        XCTAssertEqual(put?.url?.path, "/v1/presence")
    }

    func testActionsEligibility() throws {
        var r = try decodeRequest(#"{"id":"r","question":"q","status":"pending","delivery_mode":"actions","choices":["a","b","c"],"created_at":"2026-11-15T14:00:00.000Z"}"#)
        XCTAssertTrue(r.isActionsEligible)
        r.deliveryMode = .text
        XCTAssertFalse(r.isActionsEligible)
    }
}
