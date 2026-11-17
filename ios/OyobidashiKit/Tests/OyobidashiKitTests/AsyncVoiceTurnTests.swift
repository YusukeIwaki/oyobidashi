import Foundation
import XCTest
@testable import OyobidashiKit

private final class TurnTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 0
    private var delays: [TimeInterval] = []
    var now: TimeInterval { lock.withLock { value } }
    var sleeps: [TimeInterval] { lock.withLock { delays } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
    func policy(timeout: TimeInterval = 95, posts: Int = 3) -> VoiceTurnPolicy {
        VoiceTurnPolicy(overallTimeout: timeout, maxPostAttempts: posts, now: { self.now }, sleep: { seconds in
            try Task.checkCancellation()
            self.lock.withLock { self.value += seconds; self.delays.append(seconds) }
            await Task.yield()
        })
    }
}

private struct TurnEnvelope: Encodable {
    var request: AgentRequest
    var call: CallSession?
    var turn: CallTurn?
    var reply: String?
    var resolved: Bool?
}

final class AsyncVoiceTurnTests: XCTestCase {
    private let id = "a1129c66-9ca3-4c35-8735-4458b75cab03"
    private let path = "/v1/requests/r/call"
    private var poll: String { "/v1/requests/r/turns/\(id)" }
    private let stub = StubTransport()
    private let clock = TurnTestClock()

    private func client(timeout: TimeInterval = 95, posts: Int = 3) throws -> RelayClient {
        RelayClient(endpoint: try RelayEndpoint("https://relay.example"), deviceToken: "kd_test", transport: stub, voiceTurnPolicy: clock.policy(timeout: timeout, posts: posts))
    }

    private func envelope(_ state: CallTurnState, reply: String? = nil, resolved: Bool = false, turnID: String? = nil, requestID: String = "r") -> Data {
        var request = makeRequest(id: requestID, status: resolved ? .answered : .pending)
        let turn = CallTurn(id: turnID ?? id, state: state, reply: reply, resolved: resolved)
        let call = CallSession(id: "c", requestID: requestID, state: resolved ? .ended : .active, outcome: resolved ? .resolved : nil, deviceID: "dev", startedAt: request.createdAt, turn: turn)
        request.call = call
        return encodeJSON(TurnEnvelope(request: request, call: call, turn: turn))
    }

    private func send(_ client: RelayClient? = nil, recovering: Bool = false) async throws -> CallActionResponse {
        try await (client ?? self.client()).sendCallTurn(requestID: "r", text: "はい", turnID: id, recovering: recovering)
    }

    private func assertError(_ expected: RelayError, _ block: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await block(); XCTFail("expected \(expected)", file: file, line: line) }
        catch { XCTAssertEqual(RelayError.wrap(error), expected, file: file, line: line) }
    }

    func testLegacySynchronousTurnStillWorksAndAdvertisesAsyncWithOneID() async throws {
        stub.on("POST", path, status: 200, body: encodeJSON(TurnEnvelope(request: makeRequest(id: "r"), reply: "承知しました", resolved: false)))
        let response = try await send()
        XCTAssertEqual(response.reply, "承知しました")
        XCTAssertNil(response.turn)
        XCTAssertEqual(stub.requests.count, 1)
        assertJSONEqual(stub.requests.first?.httpBody, Data("{\"event\":\"turn\",\"text\":\"はい\",\"turn_id\":\"\(id)\",\"async\":true}".utf8))
        XCTAssertLessThanOrEqual(stub.requests[0].timeoutInterval, 95)
    }

    func testQueuedRunningCompletedReturnsFinalReplyAndNeverStartsAnotherPost() async throws {
        stub.on("POST", path, status: 202, body: envelope(.queued))
        var reads = 0
        stub.on("GET", poll) { _ in
            reads += 1
            return .init(200, self.envelope(reads == 1 ? .running : .completed, reply: reads == 1 ? nil : "お伝えします", resolved: reads > 1))
        }
        let response = try await send()
        XCTAssertEqual(response.reply, "お伝えします")
        XCTAssertEqual(response.resolved, true)
        XCTAssertEqual(response.turn?.state, .completed)
        XCTAssertEqual(response.request.status, .answered)
        XCTAssertEqual(stub.requests("POST", path).count, 1)
        XCTAssertEqual(clock.sleeps, [0.25, 0.5])
    }

    func testLostPostAfterCommitRecoversByGetWithoutRepeatingModelWork() async throws {
        stub.on("POST", path) { _ in throw URLError(.networkConnectionLost) }
        stub.on("GET", poll, status: 200, body: envelope(.completed, reply: "受け取りました", resolved: true))
        let response = try await send()
        XCTAssertEqual(response.reply, "受け取りました")
        XCTAssertEqual(stub.requests("POST", path).count, 1)
        XCTAssertEqual(stub.requests("GET", "/healthz").count, 0)
    }

    func testLostPostBeforeCommitReusesSameIDOnlyAfterCloudCapabilityCheck() async throws {
        var posts = 0
        stub.on("POST", path) { _ in
            posts += 1
            if posts == 1 { throw URLError(.networkConnectionLost) }
            return .init(202, self.envelope(.queued))
        }
        var reads = 0
        stub.on("GET", poll) { _ in
            reads += 1
            return reads == 1 ? .init(404, errorBody("not_found")) : .init(200, self.envelope(.completed, reply: "了解", resolved: true))
        }
        stub.on("GET", "/healthz", status: 200, body: Data(#"{"ok":true,"capabilities":{"async_turns":true,"turn_idempotency":true}}"#.utf8))
        _ = try await send()
        let attempts = stub.requests("POST", path)
        XCTAssertEqual(attempts.count, 2)
        XCTAssertEqual(attempts[0].httpBody, attempts[1].httpBody)
        XCTAssertEqual(stub.requests.map { $0.httpMethod! }, ["POST", "GET", "GET", "POST", "GET"])
    }

    func testLegacyLostPostIsNotResubmittedBecauseItMayHaveAlreadyCompleted() async throws {
        stub.on("POST", path) { _ in throw URLError(.networkConnectionLost) }
        stub.on("GET", poll, status: 404, body: errorBody("not_found"))
        stub.on("GET", "/healthz", status: 200, body: Data(#"{"ok":true,"version":"0.2.0"}"#.utf8))
        await assertError(.turnPending) { _ = try await self.send() }
        XCTAssertEqual(stub.requests("POST", path).count, 1)
    }

    func testIncompleteCapabilityAdvertisementNeverAllowsDuplicatePost() async throws {
        stub.on("POST", path) { _ in throw URLError(.networkConnectionLost) }
        stub.on("GET", poll, status: 404, body: errorBody("not_found"))
        stub.on("GET", "/healthz", status: 200, body: Data(#"{"ok":true,"capabilities":{"async_turns":true}}"#.utf8))
        await assertError(.turnPending) { _ = try await self.send() }
        XCTAssertEqual(stub.requests("POST", path).count, 1)
    }

    func testPollingDisconnectRetriesGetAndNeverPost() async throws {
        stub.on("POST", path, status: 202, body: envelope(.queued))
        var reads = 0
        stub.on("GET", poll) { _ in
            reads += 1
            if reads == 1 { throw URLError(.networkConnectionLost) }
            if reads == 2 { return .init(503, errorBody("unavailable")) }
            return .init(200, self.envelope(.completed, reply: "確認しました"))
        }
        let response = try await send()
        XCTAssertEqual(response.reply, "確認しました")
        XCTAssertEqual(stub.requests("POST", path).count, 1)
        XCTAssertEqual(clock.sleeps, [0.25, 0.5, 1])
    }

    func testInfrastructureOutageStopsAfterBoundedFailures() async throws {
        stub.onAny { _ in .init(503, errorBody("unavailable")) }
        await assertError(.turnPending) { _ = try await self.send() }
        XCTAssertEqual(stub.requests.count, 3)
        XCTAssertEqual(stub.requests("POST", path).count, 1)
        XCTAssertEqual(clock.sleeps, [0.25, 0.5])
    }

    func testPostRetryCountIsBoundedAndRetainsID() async throws {
        stub.on("POST", path) { _ in throw URLError(.networkConnectionLost) }
        stub.on("GET", poll, status: 404, body: errorBody("not_found"))
        stub.on("GET", "/healthz", status: 200, body: Data(#"{"ok":true,"capabilities":{"async_turns":true,"turn_idempotency":true}}"#.utf8))
        await assertError(.turnPending) { _ = try await self.send(self.client(posts: 2)) }
        XCTAssertEqual(stub.requests("POST", path).count, 2)
    }

    func testOverallDeadlineUsesBoundedBackoffAndNoBusyLoop() async throws {
        stub.onAny { _ in .init(202, self.envelope(.queued)) }
        await assertError(.turnPending) { _ = try await self.send(self.client(timeout: 1)) }
        XCTAssertEqual(clock.sleeps, [0.25, 0.5, 0.25])
        XCTAssertEqual(stub.requests.count, 3)
        XCTAssertTrue(stub.requests.allSatisfy { $0.timeoutInterval <= 1 })
    }

    func testResponseArrivingAfterDeadlineDoesNotRestartConversation() async throws {
        stub.on("POST", path) { _ in
            self.clock.advance(96)
            return .init(200, self.envelope(.completed, reply: "late", resolved: true))
        }
        await assertError(.turnPending) { _ = try await self.send() }
        XCTAssertEqual(stub.requests.count, 1)
    }

    func testFailureAndCancellationAreNeverReportedAsAnswer() async throws {
        for (state, error) in [(CallTurnState.failed, RelayError.turnFailed), (.cancelled, .turnCancelled)] {
            stub.on("POST", path, status: 200, body: envelope(state))
            await assertError(error) { _ = try await self.send() }
        }
    }

    func testCompletedUnresolvedTurnCannotRestartARequestClosedBeforePolling() async throws {
        for status in ["cancelled", "expired", "answered", "pending"] {
            var root = try JSONSerialization.jsonObject(with: envelope(.completed, reply: "old reply")) as! [String: Any]
            var request = root["request"] as! [String: Any]
            request["status"] = status
            if status == "pending" {
                var call = root["call"] as! [String: Any]
                call["state"] = "ended"
                root["call"] = call
                request["call"] = call
            }
            root["request"] = request
            stub.on("POST", path, status: 202, body: envelope(.queued))
            stub.on("GET", poll, status: 200, body: try JSONSerialization.data(withJSONObject: root))
            await assertError(.turnCancelled) { _ = try await self.send() }
        }
        // A turn which itself resolved the request still returns its final reply
        // so the existing speech guard can finish acknowledgement before hangup.
        stub.on("POST", path, status: 200, body: envelope(.completed, reply: "final acknowledgement", resolved: true))
        let resolved = try await send()
        XCTAssertEqual(resolved.resolved, true)
        XCTAssertEqual(resolved.reply, "final acknowledgement")
    }

    func testQueuedResponseMissingTurnFailsClosed() async throws {
        stub.on("POST", path, status: 202, body: encodeJSON(TurnEnvelope(request: makeRequest(id: "r"), reply: "unused", resolved: true)))
        do { _ = try await send(); XCTFail("missing turn must fail") }
        catch { guard case .decoding = RelayError.wrap(error) else { return XCTFail("\(error)") } }
        XCTAssertTrue(clock.sleeps.isEmpty)
    }

    func testMismatchedRequestOrTurnAndUnknownStateFailClosed() async throws {
        let unknown = String(decoding: envelope(.queued), as: UTF8.self).replacingOccurrences(of: "queued", with: "future_success")
        for body in [envelope(.completed, reply: "ok", turnID: UUID().uuidString), envelope(.completed, reply: "ok", requestID: "other"), Data(unknown.utf8), envelope(.completed, reply: " "), envelope(.queued, reply: "not yet")] {
            stub.on("POST", path, status: 202, body: body)
            do { _ = try await send(); XCTFail("invalid result accepted") }
            catch { guard case .decoding = RelayError.wrap(error) else { return XCTFail("\(error)") } }
        }
        XCTAssertEqual(stub.requests.count, 5)
    }

    func testRevokedPairingStopsPollingWithoutRetry() async throws {
        stub.on("POST", path, status: 202, body: envelope(.queued))
        stub.on("GET", poll, status: 401, body: errorBody("unauthorized"))
        await assertError(.unauthorized) { _ = try await self.send() }
        XCTAssertEqual(stub.requests.count, 2)
    }

    func testAcceptedTurnDisappearingDoesNotCreateAnotherPost() async throws {
        stub.on("POST", path, status: 202, body: envelope(.queued))
        stub.on("GET", poll, status: 404, body: errorBody("not_found"))
        await assertError(.notFound) { _ = try await self.send() }
        XCTAssertEqual(stub.requests("POST", path).count, 1)
    }

    func testExplicitRecoveryReadsPersistedIDBeforeAnyPost() async throws {
        stub.on("GET", poll, status: 200, body: envelope(.completed, reply: "前の結果"))
        let response = try await send(recovering: true)
        XCTAssertEqual(response.reply, "前の結果")
        XCTAssertEqual(stub.requests.count, 1)
        XCTAssertEqual(stub.requests.first?.httpMethod, "GET")
    }

    func testCancellationDuringBackoffStopsPollingButDoesNotCancelServerJob() async throws {
        stub.on("POST", path, status: 202, body: envelope(.queued))
        let sleeping = expectation(description: "poll backoff")
        let policy = VoiceTurnPolicy(sleep: { _ in
            sleeping.fulfill()
            try await Task.sleep(for: .seconds(3600))
        })
        let client = RelayClient(endpoint: try RelayEndpoint("https://relay.example"), deviceToken: "kd_test", transport: stub, voiceTurnPolicy: policy)
        let task = Task { try await self.send(client) }
        await fulfillment(of: [sleeping], timeout: 1)
        task.cancel()
        await assertError(.cancelled) { _ = try await task.value }
        XCTAssertEqual(stub.requests.count, 1)
    }

    func testPreCancelledTaskSendsNoRequest() async throws {
        let task = Task { () throws -> Void in
            withUnsafeCurrentTask { $0?.cancel() }
            _ = try await self.send()
        }
        await assertError(.cancelled) { try await task.value }
        XCTAssertTrue(stub.requests.isEmpty)
    }

    func testInvalidTurnIDIsRejectedBeforeNetwork() async throws {
        await assertError(.invalidRequest(message: "invalid turn ID")) {
            _ = try await self.client().sendCallTurn(requestID: "r", text: "hi", turnID: "not-a-uuid")
        }
        XCTAssertTrue(stub.requests.isEmpty)
    }

    func testDraftPersistsTurnIdentityAndReadsOldDrafts() throws {
        let draft = AnswerDraft(text: "はい", usedVoice: true, voiceTurnID: id, voiceCallID: "c")
        XCTAssertEqual(try JSONDecoder().decode(AnswerDraft.self, from: JSONEncoder().encode(draft)), draft)
        let old = try JSONDecoder().decode(AnswerDraft.self, from: Data(#"{"text":"旧下書き","usedVoice":true}"#.utf8))
        XCTAssertNil(old.voiceTurnID)
        XCTAssertEqual(old.text, "旧下書き")
    }
}

@MainActor
private final class VoicePollObservation {
    var model: AppModel?
    var resolved: AgentRequest?
    var observed = false
    func deliverResolution() {
        guard !observed, let model, let resolved else { return }
        observed = true
        model.store.upsert(resolved)
        model.reconcileCalls(for: resolved)
    }
}

@MainActor
final class AsyncVoiceAppModelTests: XCTestCase {
    private let endpoint = try! RelayEndpoint("https://relay.example")
    private var credentials: Credentials { Credentials(endpoint: endpoint, deviceToken: "kd_test", deviceID: "dev") }
    private let stub = StubTransport()
    private let clock = TurnTestClock()
    private let persistence = InMemoryDraftPersistence()
    private let credentialStore = InMemoryCredentialStore()

    private func model(policy: VoiceTurnPolicy? = nil) throws -> AppModel {
        try credentialStore.save(credentials)
        return AppModel(credentialStore: credentialStore, transport: stub,
                        configuration: AppModelConfiguration(deviceName: "test", pushEnvironment: .development),
                        draftPersistence: persistence, voiceTurnPolicy: policy ?? clock.policy())
    }

    private func liveRequest() -> AgentRequest {
        var live = makeRequest(id: "r")
        live.call = CallSession(id: "c", requestID: "r", state: .active, deviceID: "dev", startedAt: live.createdAt)
        return live
    }

    private func response(_ live: AgentRequest, id: String, completed: Bool) -> Data {
        var request = live
        let turn = CallTurn(id: id, state: completed ? .completed : .queued, reply: completed ? "お伝えします" : nil, resolved: completed)
        request.call?.turn = turn
        if completed { request.status = .answered; request.call?.state = .ended; request.call?.outcome = .resolved }
        return encodeJSON(TurnEnvelope(request: request, call: request.call, turn: turn))
    }

    func testUncertainTurnIDSurvivesModelRecreationAndExplicitRetryRecoversIt() async throws {
        let first = try model()
        let live = liveRequest()
        first.store.upsert(live)
        stub.on("POST", "/v1/requests/r/call") { _ in throw URLError(.networkConnectionLost) }
        stub.onAny { _ in .init(404, errorBody("not_found")) }
        stub.on("GET", "/healthz", status: 200, body: Data(#"{"ok":true}"#.utf8))
        guard case .failed(.turnPending) = await first.sendCallTurn(requestID: "r", text: "はい") else { return XCTFail("expected uncertain delivery") }
        let saved = try XCTUnwrap(first.drafts.draft(for: "r"))
        let id = try XCTUnwrap(saved.voiceTurnID)
        XCTAssertEqual(saved.voiceCallID, "c")
        XCTAssertEqual(saved.text, "はい")

        let restored = try model()
        restored.store.upsert(live)
        XCTAssertEqual(restored.drafts.draft(for: "r")?.voiceTurnID, id)
        stub.on("GET", "/v1/requests/r/turns/\(id)", status: 200, body: response(live, id: id, completed: true))
        guard case .success(let result) = await restored.sendCallTurn(requestID: "r", text: "はい") else { return XCTFail("recovery failed") }
        XCTAssertEqual(result.reply, "お伝えします")
        XCTAssertNil(restored.drafts.draft(for: "r"))
        XCTAssertEqual(stub.requests("POST", "/v1/requests/r/call").count, 1, "Recovery never submits a new utterance")
    }

    func testResolutionOverWebSocketDuringPollingWaitsForFinalReplyAndDuplicateEventsDoNotEndEarly() async throws {
        let observation = VoicePollObservation()
        let policy = VoiceTurnPolicy(sleep: { _ in await observation.deliverResolution() })
        let model = try model(policy: policy)
        let live = liveRequest()
        model.store.upsert(live)
        model.callReconciler.markReported(callID: "c", requestID: "r")
        model.fallbackCallRequest = live
        var resolved = live
        resolved.status = .answered; resolved.call?.state = .ended; resolved.call?.outcome = .resolved
        observation.model = model; observation.resolved = resolved
        var id = ""
        stub.on("POST", "/v1/requests/r/call") { request in
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            id = body["turn_id"] as! String
            return .init(202, self.response(live, id: id, completed: false))
        }
        stub.onAny { _ in .init(200, self.response(live, id: id, completed: true)) }
        guard case .success(let reply) = await model.sendCallTurn(requestID: "r", text: "はい") else { return XCTFail("polling failed") }
        XCTAssertTrue(observation.observed)
        XCTAssertEqual(reply.reply, "お伝えします")
        XCTAssertNotNil(model.fallbackCallRequest)
        model.reconcileCalls(for: resolved)
        XCTAssertNotNil(model.fallbackCallRequest)
        model.finishVoiceCall(requestID: "r")
        XCTAssertNil(model.fallbackCallRequest)
    }

    func testRevokedPairingDuringPollingSignsOutAndClearsPendingUtterance() async throws {
        let model = try model()
        let live = liveRequest()
        model.store.upsert(live)
        stub.on("POST", "/v1/requests/r/call") { request in
            let body = try JSONSerialization.jsonObject(with: request.httpBody!) as! [String: Any]
            return .init(202, self.response(live, id: body["turn_id"] as! String, completed: false))
        }
        stub.onAny { _ in .init(401, errorBody("unauthorized")) }
        let outcome = await model.sendCallTurn(requestID: "r", text: "はい")
        XCTAssertEqual(outcome, .unauthorized)
        XCTAssertFalse(model.isPaired)
        XCTAssertTrue(model.drafts.drafts.isEmpty)
        XCTAssertTrue(persistence.load().isEmpty)
    }

    func testActiveCallRestoresExplicitResumeUIWithoutStartingNetworkOrAudio() throws {
        let model = try model()
        let live = liveRequest()
        model.store.upsert(live)
        model.reconcileCalls(for: [live])
        XCTAssertEqual(model.fallbackCallRequest?.id, live.id)
        XCTAssertTrue(model.callReconciler.isReported(callID: "c"))
        XCTAssertTrue(stub.requests.isEmpty)
        model.reconcileCalls(for: [live])
        XCTAssertEqual(model.fallbackCallRequest?.id, live.id)
        XCTAssertTrue(stub.requests.isEmpty)
    }
}
