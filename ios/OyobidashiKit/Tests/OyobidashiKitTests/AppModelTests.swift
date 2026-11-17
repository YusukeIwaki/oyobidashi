import XCTest
@testable import OyobidashiKit

@MainActor
final class AppModelTests: XCTestCase {
    private var stub: StubTransport!
    private var credentialStore: InMemoryCredentialStore!
    private var notifications: FakeNotifications!
    private var draftPersistence: InMemoryDraftPersistence!
    private var streams: [FakeStream] = []

    private let endpoint = try! RelayEndpoint("http://192.168.1.10:8787")
    private var paired: Credentials { Credentials(endpoint: endpoint, deviceToken: "kd_token", deviceID: "dev_01") }
    private let pending = Fixtures.request("request_pending.json")
    private let answered = Fixtures.request("request_answered.json")

    override func setUp() async throws {
        stub = StubTransport()
        credentialStore = InMemoryCredentialStore()
        notifications = FakeNotifications()
        draftPersistence = InMemoryDraftPersistence()
        streams = []
    }

    private func makeModel(paired isPaired: Bool = true) -> AppModel {
        if isPaired { try! credentialStore.save(paired) }
        return AppModel(
            credentialStore: credentialStore, transport: stub,
            configuration: AppModelConfiguration(deviceName: "iPhone 16", pushEnvironment: .development),
            notifications: notifications, draftPersistence: draftPersistence,
            streamFactory: { [unowned self] _, _ in
                let stream = FakeStream()
                self.streams.append(stream)
                return stream
            }
        )
    }

    private func wait(_ condition: @escaping @MainActor @Sendable () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let ok = await eventually { await condition() }
        XCTAssertTrue(ok, "condition not met", file: file, line: line)
    }

    // MARK: Launch

    func testStartsPairedWhenCredentialsExist() {
        let model = makeModel()
        XCTAssertEqual(model.phase, .paired(paired))
        XCTAssertNil(model.signedOutReason)
    }

    func testStartsUnpairedWhenNoCredentialsOrStoreFails() {
        XCTAssertEqual(makeModel(paired: false).phase, .unpaired)
        try! credentialStore.save(paired)
        credentialStore.failure = KeychainError(status: -25300)
        XCTAssertEqual(makeModel(paired: false).phase, .unpaired)
    }

    // MARK: Pairing

    func testPairSendsContractBodyAndStoresCredentials() async throws {
        let model = makeModel(paired: false)
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        await model.setPushToken("0000000000000000000000000000000000000000000000000000000000000000")
        XCTAssertTrue(stub.requests.isEmpty, "未ペアリング中は何も送らない")

        let ok = await model.pair(try PairingInfo.parse(uri: Fixtures.string("pairing_uri.txt")))

        XCTAssertTrue(ok)
        XCTAssertEqual(stub.requests.count, 1, "pair に push_token を含めたので PUT は不要")
        XCTAssertEqual(stub.requests[0].url?.absoluteString, "http://192.168.1.10:8787/v1/pair")
        assertJSONEqual(stub.requests[0].httpBody, Fixtures.data("pair_request.json"))
        let expected = Credentials(endpoint: endpoint, deviceToken: "test-device-token", deviceID: "dev_01")
        XCTAssertEqual(model.phase, .paired(expected))
        XCTAssertEqual(credentialStore.current, expected)
        XCTAssertEqual(model.pairingState, .idle)
    }

    func testPairWithoutPushTokenThenRegistersTokenOnce() async throws {
        let model = makeModel(paired: false)
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        stub.on("PUT", "/v1/devices/me", status: 200, body: Data(#"{"device":{"id":"dev_01"}}"#.utf8))
        await model.pair(PairingInfo(endpoint: endpoint, code: "c"))
        assertJSONEqual(stub.requests[0].httpBody, Data(#"{"code":"c","device_name":"iPhone 16","platform":"ios","push_environment":"development"}"#.utf8))

        await model.setPushToken("abcd")
        await model.setPushToken("abcd")
        let puts = stub.requests("PUT", "/v1/devices/me")
        XCTAssertEqual(puts.count, 1, "同じトークンは再送しない")
        XCTAssertEqual(puts[0].value(forHTTPHeaderField: "Authorization"), "Bearer test-device-token")
        assertJSONEqual(puts[0].httpBody, Data(#"{"push_token":"abcd","push_environment":"development"}"#.utf8))

        await model.setPushToken("ef01")
        XCTAssertEqual(stub.requests("PUT", "/v1/devices/me").count, 2, "トークンが変わったら送る")
    }

    func testPairFailuresLeaveModelUnpaired() async {
        let cases: [(StubTransport.Handler, RelayError)] = [
            ({ _ in .init(401, errorBody("pairing_code_invalid")) }, .pairingCodeInvalid),
            ({ _ in .init(429, errorBody("rate_limited")) }, .rateLimited),
            ({ _ in .init(400, errorBody("invalid_request", "bad")) }, .invalidRequest(message: "bad")),
            ({ _ in .init(403, errorBody("forbidden")) }, .forbidden),
            ({ _ in throw URLError(.timedOut) }, .timeout),
            ({ _ in .init(200, Data("<html>".utf8)) }, .decoding("")),
        ]
        for (handler, expected) in cases {
            let model = makeModel(paired: false)
            stub.onAny(handler)
            let ok = await model.pair(PairingInfo(endpoint: endpoint, code: "bad"))
            XCTAssertFalse(ok)
            XCTAssertEqual(model.phase, .unpaired)
            XCTAssertNil(credentialStore.current)
            if case .decoding = expected {
                guard case .failed(.decoding) = model.pairingState else { return XCTFail("\(model.pairingState)") }
            } else {
                XCTAssertEqual(model.pairingState, .failed(expected))
            }
            model.clearPairingError()
            XCTAssertEqual(model.pairingState, .idle)
        }
    }

    func testRePairingReplacesCredentialsAndDeletesOldDevice() async {
        let model = makeModel()
        model.store.upsert(pending)
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        stub.on("DELETE", "/v1/devices/me", status: 204)
        let newEndpoint = try! RelayEndpoint("http://192.168.1.99:8787")

        let ok = await model.pair(PairingInfo(endpoint: newEndpoint, code: "c"))

        XCTAssertTrue(ok)
        XCTAssertEqual(model.credentials?.endpoint, newEndpoint)
        XCTAssertEqual(model.store.requests, [], "別サーバーの一覧は捨てる")
        let deletes = stub.requests("DELETE", "/v1/devices/me")
        XCTAssertEqual(deletes.count, 1)
        XCTAssertEqual(deletes[0].url?.host, "192.168.1.10")
        XCTAssertEqual(deletes[0].value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
    }

    func testFailedRePairingKeepsExistingPairing() async {
        let model = makeModel()
        stub.on("POST", "/v1/pair", status: 401, body: errorBody("pairing_code_invalid"))
        let ok = await model.pair(PairingInfo(endpoint: endpoint, code: "bad"))
        XCTAssertFalse(ok)
        XCTAssertEqual(model.phase, .paired(paired))
        XCTAssertEqual(credentialStore.current, paired)
    }

    func testRePairingRegistersTheSameVoipTokenWithTheNewDevice() async throws {
        for newEndpoint in [endpoint, try RelayEndpoint("https://cloud.example")] {
            stub = StubTransport()
            let model = makeModel()
            stub.on("PUT", "/v1/devices/me", status: 200, body: Data(#"{"device":{"id":"dev_01"}}"#.utf8))
            stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
            stub.on("DELETE", "/v1/devices/me", status: 204)
            await model.setVoipToken("voip-test-token")
            XCTAssertEqual(stub.requests("PUT", "/v1/devices/me").count, 1)

            let success = await model.pair(PairingInfo(endpoint: newEndpoint, code: "test-code"))

            XCTAssertTrue(success)
            let puts = stub.requests("PUT", "/v1/devices/me")
            XCTAssertEqual(puts.count, 2, "VoIP registration belongs to a device credential, not just a token string")
            let last = try XCTUnwrap(puts.last)
            XCTAssertEqual(last.url?.host, newEndpoint.baseURL.host)
            XCTAssertEqual(last.value(forHTTPHeaderField: "Authorization"), "Bearer test-device-token")
            assertJSONEqual(last.httpBody, Data(#"{"voip_token":"voip-test-token","push_environment":"development"}"#.utf8))
        }
    }

    func testFailedRePairingKeepsTheExistingVoipRegistration() async {
        let model = makeModel()
        stub.on("PUT", "/v1/devices/me", status: 200, body: Data(#"{"device":{"id":"dev_01"}}"#.utf8))
        stub.on("POST", "/v1/pair", status: 401, body: errorBody("pairing_code_invalid"))
        await model.setVoipToken("voip-test-token")
        let success = await model.pair(PairingInfo(endpoint: endpoint, code: "bad"))
        XCTAssertFalse(success)
        await model.setVoipToken("voip-test-token")
        XCTAssertEqual(stub.requests("PUT", "/v1/devices/me").count, 1)
        XCTAssertEqual(model.credentials, paired)
    }

    func testVoipRegistrationFailureAfterPairingRetriesWithTheNewCredential() async throws {
        let model = makeModel()
        var failNewRegistration = true
        stub.on("PUT", "/v1/devices/me") { request in
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer test-device-token", failNewRegistration {
                failNewRegistration = false
                throw URLError(.networkConnectionLost)
            }
            return .init(200, Data(#"{"device":{"id":"dev_01"}}"#.utf8))
        }
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        stub.on("DELETE", "/v1/devices/me", status: 204)
        await model.setVoipToken("voip-test-token")
        let success = await model.pair(PairingInfo(endpoint: try RelayEndpoint("https://cloud.example"), code: "test-code"))
        XCTAssertTrue(success, "A VoIP registration outage must not discard successful pairing")
        XCTAssertTrue(model.isPaired)
        XCTAssertNil(model.signedOutReason)
        XCTAssertEqual(stub.requests("PUT", "/v1/devices/me").count, 2)
        await model.setVoipToken("voip-test-token")
        let puts = stub.requests("PUT", "/v1/devices/me")
        XCTAssertEqual(puts.count, 3)
        XCTAssertEqual(puts.last?.value(forHTTPHeaderField: "Authorization"), "Bearer test-device-token")
        XCTAssertEqual(puts.last?.url?.host, "cloud.example")
    }

    // MARK: Unpair

    func testUnpairDeletesDeviceAndClearsEverything() async {
        let model = makeModel()
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([pending]))
        stub.on("DELETE", "/v1/devices/me", status: 204)
        model.activate()
        await wait { model.store.requests.count == 1 }
        model.drafts.set(AnswerDraft(text: "d"), for: pending.id)

        await model.unpair()

        XCTAssertEqual(model.phase, .unpaired)
        XCTAssertEqual(model.signedOutReason, .userRequested)
        XCTAssertNil(credentialStore.current)
        XCTAssertEqual(model.store.requests, [])
        XCTAssertEqual(model.drafts.drafts, [:])
        XCTAssertEqual(notifications.removedAllCount, 1)
        XCTAssertTrue(streams[0].isStopped)
        let deletes = stub.requests("DELETE", "/v1/devices/me")
        XCTAssertEqual(deletes.count, 1)
        XCTAssertEqual(deletes[0].value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
    }

    func testUnpairClearsLocallyEvenWhenServerIsUnreachable() async {
        let model = makeModel()
        stub.onAny { _ in throw URLError(.cannotConnectToHost) }
        await model.unpair()
        XCTAssertEqual(model.phase, .unpaired)
        XCTAssertNil(credentialStore.current)
    }

    // MARK: Foreground lifecycle

    func testActivateStartsStreamAndRefreshesList() async {
        let model = makeModel()
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([pending, Fixtures.request("request_notification.json")]))
        model.activate()
        model.activate() // 二重に呼んでもストリームは1本

        XCTAssertEqual(streams.count, 1)
        XCTAssertTrue(streams[0].isStarted)
        XCTAssertEqual(model.store.connection, .connecting)
        await wait { model.store.requests.count == 2 }
        XCTAssertEqual(model.store.pending.map(\.id), [pending.id])
        XCTAssertEqual(model.store.reachability, .reachable)
        let list = stub.requests("GET", "/v1/requests")[0]
        XCTAssertEqual(list.url?.query, "limit=100")
        XCTAssertEqual(list.value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
    }

    func testActivateWhenUnpairedDoesNothing() async {
        let model = makeModel(paired: false)
        model.activate()
        try? await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertTrue(streams.isEmpty)
        XCTAssertTrue(stub.requests.isEmpty)
    }

    func testStreamEventsUpdateStoreAndHelloTriggersRefresh() async {
        let model = makeModel()
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([]))
        model.activate()
        await wait { self.stub.requests("GET", "/v1/requests").count == 1 }

        await streams[0].emit(.state(.connected))
        XCTAssertEqual(model.store.connection, .connected)

        // 切断中に回答済みになっていた、という想定で一覧は answered を返す
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([answered]))
        await streams[0].emit(.event(.hello(pending: [])))
        XCTAssertEqual(stub.requests("GET", "/v1/requests").count, 2)
        XCTAssertEqual(model.store.history.map(\.status), [.answered])

        let other = makeRequest(id: "req_new", created: "2026-11-15T14:30:00.000Z")
        await streams[0].emit(.event(.created(other)))
        XCTAssertEqual(model.store.pending.map(\.id), ["req_new"])
        XCTAssertEqual(notifications.presented, ["req_new"])

        var cancelled = other
        cancelled.status = .cancelled
        cancelled.updatedAt = date("2026-11-15T14:31:00.000Z")
        await streams[0].emit(.event(.updated(cancelled)))
        XCTAssertEqual(model.store.pending, [])
        XCTAssertTrue(notifications.removed.contains("req_new"))
    }

    func testDeactivateStopsStreamAndIgnoresLateSignals() async {
        let model = makeModel()
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([]))
        model.activate()
        await wait { self.stub.requests("GET", "/v1/requests").count == 1 }
        model.deactivate()

        XCTAssertTrue(streams[0].isStopped)
        XCTAssertFalse(model.isStreaming)
        XCTAssertEqual(model.store.connection, .disconnected)
        await streams[0].emit(.event(.created(pending)))
        await streams[0].emit(.state(.unauthorized))
        XCTAssertEqual(model.store.requests, [], "停止済みストリームのシグナルは無視")
        XCTAssertTrue(model.isPaired)

        model.activate()
        XCTAssertEqual(streams.count, 2, "再度フォアグラウンドで新しいストリーム")
        await streams[0].emit(.event(.created(pending)))
        XCTAssertEqual(model.store.requests, [], "古い世代のシグナルは無視")
    }

    // MARK: Unauthorized → signed out

    func testStreamUnauthorizedSignsOut() async {
        let model = makeModel()
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([pending]))
        model.activate()
        await wait { model.store.requests.count == 1 }

        await streams[0].emit(.state(.unauthorized))

        XCTAssertEqual(model.phase, .unpaired)
        XCTAssertEqual(model.signedOutReason, .unauthorized)
        XCTAssertNil(credentialStore.current)
        XCTAssertEqual(model.store.requests, [])
        XCTAssertTrue(streams[0].isStopped)
    }

    func testRefreshUnauthorizedSignsOut() async {
        let model = makeModel()
        model.store.upsert(pending)
        stub.on("GET", "/v1/requests", status: 401, body: Fixtures.data("error_unauthorized.json"))
        await model.refresh()
        XCTAssertEqual(model.phase, .unpaired)
        XCTAssertEqual(model.signedOutReason, .unauthorized)
        XCTAssertNil(credentialStore.current)
        XCTAssertEqual(model.store.requests, [])
    }

    func testPushTokenRegistrationUnauthorizedSignsOut() async {
        let model = makeModel()
        stub.on("PUT", "/v1/devices/me", status: 401, body: Fixtures.data("error_unauthorized.json"))
        await model.setPushToken("abcd")
        XCTAssertEqual(model.signedOutReason, .unauthorized)
    }

    func testNonContract401DoesNotSignOut() async {
        // 同じIPの別サーバー等が返した 401 (契約のエラー形式でない) ではペアリングを捨てない
        let model = makeModel()
        stub.on("GET", "/v1/requests", status: 401, body: Data("<html>login</html>".utf8))
        await model.refresh()
        XCTAssertTrue(model.isPaired)
        XCTAssertEqual(model.store.loadState, .failed(.unexpectedResponse(status: 401, code: nil, message: nil)))
    }

    // MARK: Unreachable (off the LAN) → recovered

    func testRefreshWhileOffLANIsUnreachableNotSignedOutNorGenericError() async {
        let model = makeModel()
        model.store.upsert(pending)
        for failure in [URLError(.cannotConnectToHost), URLError(.timedOut), URLError(.notConnectedToInternet), URLError(.networkConnectionLost)] {
            stub.onAny { _ in throw failure }
            await model.refresh()
            XCTAssertEqual(model.store.reachability, .unreachable)
            XCTAssertEqual(model.store.loadState, .idle, "圏外は読み込みエラー扱いにしない")
            XCTAssertTrue(model.isPaired)
            XCTAssertNil(model.signedOutReason)
            XCTAssertEqual(model.store.pending, [pending], "手元の一覧は保持")
            XCTAssertEqual(credentialStore.current, paired)
        }
    }

    func testUnreachableThenRecoveredOnNextRefresh() async {
        let model = makeModel()
        stub.onAny { _ in throw URLError(.cannotConnectToHost) }
        await model.refresh()
        XCTAssertEqual(model.store.reachability, .unreachable)

        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([pending]))
        await model.refresh()
        XCTAssertEqual(model.store.reachability, .reachable)
        XCTAssertEqual(model.store.pending, [pending])
    }

    func testServerErrorMeansReachableButLoadFailed() async {
        let model = makeModel()
        stub.onAny { _ in throw URLError(.cannotConnectToHost) }
        await model.refresh()
        stub.on("GET", "/v1/requests", status: 500, body: errorBody("internal", "boom"))
        await model.refresh()
        XCTAssertEqual(model.store.reachability, .reachable)
        XCTAssertEqual(model.store.loadState, .failed(.server(message: "boom")))
    }

    func testStreamRetryingMarksUnreachableAndReconnectRecoversAndRetriesPushToken() async {
        let model = makeModel()
        stub.onAny { _ in throw URLError(.cannotConnectToHost) }
        await model.setPushToken("abcd") // 圏外で登録失敗
        XCTAssertEqual(stub.requests("PUT", "/v1/devices/me").count, 1)
        model.activate()
        // フォアグラウンド復帰時にも再試行する (まだ圏外なので失敗)
        await wait { self.stub.requests("PUT", "/v1/devices/me").count == 2 }

        await streams[0].emit(.state(.waiting(retryIn: 2, attempt: 2)))
        XCTAssertEqual(model.store.connection, .reconnecting(retryIn: 2))
        XCTAssertEqual(model.store.reachability, .unreachable)
        XCTAssertTrue(model.isPaired)

        // LAN に戻った: ストリームが自動再接続 → hello
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([pending]))
        stub.on("PUT", "/v1/devices/me", status: 200, body: Data(#"{"device":{"id":"dev_01"}}"#.utf8))
        await streams[0].emit(.state(.connecting))
        await streams[0].emit(.state(.connected))
        await streams[0].emit(.event(.hello(pending: [pending])))

        XCTAssertEqual(model.store.connection, .connected)
        XCTAssertEqual(model.store.reachability, .reachable)
        XCTAssertEqual(model.store.pending, [pending])
        let puts = stub.requests("PUT", "/v1/devices/me")
        XCTAssertEqual(puts.count, 3, "圏外で失敗した Push トークン登録を、再接続時に再試行")
        assertJSONEqual(puts.last?.httpBody, Data(#"{"push_token":"abcd","push_environment":"development"}"#.utf8))
        await model.setPushToken("abcd")
        XCTAssertEqual(stub.requests("PUT", "/v1/devices/me").count, 3, "登録済みなら再送しない")
    }

    func testConnectivityChangedRestartsStreamImmediatelyOnlyWhileActive() async {
        let model = makeModel()
        stub.on("GET", "/v1/requests", status: 200, body: listEnvelope([]))
        model.connectivityChanged()
        XCTAssertTrue(streams.isEmpty, "バックグラウンドでは何もしない")

        model.activate()
        await wait { self.stub.requests("GET", "/v1/requests").count == 1 }
        model.connectivityChanged()
        XCTAssertEqual(streams.count, 2)
        XCTAssertTrue(streams[0].isStopped)
        XCTAssertTrue(streams[1].isStarted)
        await wait { self.stub.requests("GET", "/v1/requests").count == 2 }
    }

    // MARK: Single request refresh

    func testRefreshRequestUpsertsAndHandlesErrors() async {
        let model = makeModel()
        stub.on("GET", "/v1/requests/\(pending.id)", status: 200, body: requestEnvelope(pending))
        let fetched = await model.refreshRequest(id: pending.id)
        XCTAssertEqual(fetched, pending)
        XCTAssertEqual(model.store.pending, [pending])

        stub.on("GET", "/v1/requests/\(pending.id)") { _ in throw URLError(.cannotConnectToHost) }
        let offline = await model.refreshRequest(id: pending.id)
        XCTAssertNil(offline)
        XCTAssertEqual(model.store.pending, [pending], "圏外でも手元の情報は残す")
        XCTAssertEqual(model.store.reachability, .unreachable)

        stub.on("GET", "/v1/requests/\(pending.id)", status: 404, body: errorBody("not_found"))
        let missing = await model.refreshRequest(id: pending.id)
        XCTAssertNil(missing)
        XCTAssertEqual(model.store.requests, [])
    }

    // MARK: Answer

    func testSubmitAnswerOutcomes() async {
        let model = makeModel()
        let path = "/v1/requests/\(pending.id)/answer"
        let body = AnswerBody(text: "はい", choiceIndex: 0, inputMethod: .choice)

        model.store.upsert(pending)
        stub.on("POST", path) { _ in throw URLError(.timedOut) }
        var outcome = await model.submitAnswer(requestID: pending.id, body: body)
        XCTAssertEqual(outcome, .unreachable)
        XCTAssertEqual(model.store.pending, [pending])

        stub.on("POST", path, status: 500, body: errorBody("internal", "x"))
        outcome = await model.submitAnswer(requestID: pending.id, body: body)
        XCTAssertEqual(outcome, .failed(.server(message: "x")))
        XCTAssertEqual(model.store.reachability, .reachable)

        stub.on("POST", path, status: 400, body: errorBody("invalid_request", "choice_index out of range"))
        outcome = await model.submitAnswer(requestID: pending.id, body: body)
        XCTAssertEqual(outcome, .failed(.invalidRequest(message: "choice_index out of range")))
        XCTAssertNil(model.lastAnswerSubmission)

        stub.on("POST", path, status: 200, body: requestEnvelope(answered))
        outcome = await model.submitAnswer(requestID: pending.id, body: body)
        XCTAssertEqual(outcome, .answered(answered))
        XCTAssertEqual(model.store.pending, [])
        XCTAssertEqual(model.store.history, [answered])
        XCTAssertEqual(notifications.removed, [pending.id])
        XCTAssertEqual(model.lastAnswerSubmission?.requestID, pending.id)
        let submission = model.lastAnswerSubmission

        // A live update / failed retry is not another successful submission.
        stub.on("POST", path, status: 409, body: errorBody("already_resolved"))
        _ = await model.submitAnswer(requestID: pending.id, body: body)
        XCTAssertEqual(model.lastAnswerSubmission, submission)
        await model.unpair()
        XCTAssertNil(model.lastAnswerSubmission)
    }

    func testSubmitAnswerNotFoundRemovesRequest() async {
        let model = makeModel()
        model.store.upsert(pending)
        stub.on("POST", "/v1/requests/\(pending.id)/answer", status: 404, body: errorBody("not_found"))
        let outcome = await model.submitAnswer(requestID: pending.id, body: AnswerBody(text: "a", inputMethod: .text))
        XCTAssertEqual(outcome, .notFound)
        XCTAssertEqual(model.store.requests, [])
    }

    func testSubmitAnswerWhenUnpairedSendsNothing() async {
        let model = makeModel(paired: false)
        let outcome = await model.submitAnswer(requestID: "x", body: AnswerBody(text: "a", inputMethod: .text))
        XCTAssertEqual(outcome, .unauthorized)
        XCTAssertTrue(stub.requests.isEmpty)
    }

    // MARK: Reply from notification

    func testNotificationReplySuccessPostsAnswerAsText() async {
        let model = makeModel()
        stub.on("POST", "/v1/requests/\(pending.id)/answer", status: 200, body: requestEnvelope(answered))
        let outcome = await model.submitNotificationReply(requestID: pending.id, text: "  了解です \n")

        XCTAssertEqual(outcome, .answered(answered))
        let sent = stub.requests[0]
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer kd_token")
        assertJSONEqual(sent.httpBody, Data(#"{"text":"了解です","input_method":"text"}"#.utf8))
        XCTAssertTrue(notifications.replyFailures.isEmpty)
        XCTAssertEqual(model.drafts.drafts, [:])
        XCTAssertEqual(model.store.history, [answered])
    }

    func testNotificationReplyWhileOffLANKeepsTextAsDraftAndNotifies() async {
        let model = makeModel()
        stub.onAny { _ in throw URLError(.cannotConnectToHost) }
        let outcome = await model.submitNotificationReply(requestID: pending.id, text: "外出先からの返事")

        XCTAssertEqual(outcome, .unreachable)
        XCTAssertEqual(model.drafts.draft(for: pending.id), AnswerDraft(text: "外出先からの返事", usedVoice: false))
        XCTAssertEqual(draftPersistence.load()[pending.id]?.text, "外出先からの返事", "プロセスが終了しても残る")
        XCTAssertEqual(notifications.replyFailures.map(\.id), [pending.id])
        XCTAssertEqual(notifications.replyFailures.map(\.reason), [.unreachable])
        XCTAssertTrue(model.isPaired)

        // 次に画面を開くと下書きが入っていて、LAN に戻れば送れる
        let viewModel = AnswerViewModel(requestID: pending.id, submitter: model, drafts: model.drafts)
        XCTAssertEqual(viewModel.draft, "外出先からの返事")
        stub.on("POST", "/v1/requests/\(pending.id)/answer", status: 200, body: requestEnvelope(answered))
        await viewModel.submitText()
        XCTAssertEqual(viewModel.phase, .answered)
        XCTAssertEqual(model.drafts.drafts, [:])
        XCTAssertEqual(draftPersistence.load(), [:])
    }

    func testNotificationReplyServerErrorAlsoKeepsDraft() async {
        let model = makeModel()
        stub.onAny { _ in .init(500, errorBody("internal")) }
        let outcome = await model.submitNotificationReply(requestID: pending.id, text: "返事")
        XCTAssertEqual(outcome, .failed(.server(message: "msg")))
        XCTAssertEqual(model.drafts.draft(for: pending.id)?.text, "返事")
        XCTAssertEqual(notifications.replyFailures.map(\.reason), [.failed])
    }

    func testNotificationReplyAlreadyResolvedNotifiesWithoutDraft() async {
        let model = makeModel()
        model.store.upsert(pending)
        stub.on("POST", "/v1/requests/\(pending.id)/answer", status: 409, body: Fixtures.data("error_already_resolved.json"))
        stub.on("GET", "/v1/requests/\(pending.id)", status: 200, body: requestEnvelope(answered))
        let outcome = await model.submitNotificationReply(requestID: pending.id, text: "返事")
        XCTAssertEqual(outcome, .alreadyResolved)
        XCTAssertEqual(model.drafts.drafts, [:])
        XCTAssertEqual(notifications.replyFailures.map(\.reason), [.alreadyResolved])
        XCTAssertEqual(model.store.history, [answered])
    }

    func testNotificationReplyUnauthorizedAndUnpaired() async {
        let model = makeModel()
        stub.onAny { _ in .init(401, Fixtures.data("error_unauthorized.json")) }
        var outcome = await model.submitNotificationReply(requestID: pending.id, text: "返事")
        XCTAssertEqual(outcome, .unauthorized)
        XCTAssertEqual(model.signedOutReason, .unauthorized)
        XCTAssertEqual(notifications.replyFailures.map(\.reason), [.signedOut])

        let count = stub.requests.count
        outcome = await model.submitNotificationReply(requestID: pending.id, text: "返事")
        XCTAssertEqual(outcome, .unauthorized)
        XCTAssertEqual(stub.requests.count, count, "未ペアリングでは送信しない")
        XCTAssertEqual(notifications.replyFailures.map(\.reason), [.signedOut, .signedOut])
    }

    func testEmptyNotificationReplyIsNotSent() async {
        let model = makeModel()
        let outcome = await model.submitNotificationReply(requestID: pending.id, text: "  \n ")
        guard case .failed(.invalidRequest) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertTrue(stub.requests.isEmpty)
        XCTAssertTrue(notifications.replyFailures.isEmpty)
        XCTAssertEqual(model.drafts.drafts, [:])
    }
    func testOwnResolvedVoiceWaitsForAcknowledgementBeforeClosingCall() async {
        let model = makeModel()
        var live = makeRequest(id: "voice-request")
        live.call = CallSession(id: "call-voice", requestID: live.id, state: .active, deviceID: "dev_01", startedAt: live.createdAt)
        model.store.upsert(live)
        model.callReconciler.markReported(callID: "call-voice", requestID: live.id)
        model.fallbackCallRequest = live
        var resolved = live
        resolved.status = .answered
        resolved.call?.state = .ended
        resolved.call?.outcome = .resolved
        let payload = Data("{\"request\":".utf8) + encodeJSON(resolved) + Data(",\"reply\":\"承知しました\",\"resolved\":true}".utf8)
        stub.on("POST", "/v1/requests/voice-request/call", status: 200, body: payload)
        guard case .success = await model.sendCallTurn(requestID: live.id, text: "はい") else { return XCTFail("turn failed") }
        XCTAssertNotNil(model.fallbackCallRequest, "Keep the call UI while the final reply is spoken")
        model.reconcileCalls(for: resolved) // duplicate WebSocket delivery after HTTP response
        XCTAssertNotNil(model.fallbackCallRequest)
        model.finishVoiceCall(requestID: live.id)
        XCTAssertNil(model.fallbackCallRequest)
        XCTAssertTrue(model.callReconciler.hasEnded(callID: "call-voice"))
    }

    func testFailedVoiceTurnPreservesRecognizedTextAsDraft() async {
        let model = makeModel()
        let request = makeRequest(id: "failed-voice")
        model.store.upsert(request)
        stub.on("POST", "/v1/requests/failed-voice/call", status: 503, body: errorBody("conversation_failed"))
        _ = await model.sendCallTurn(requestID: request.id, text: "明日の10時に開始してください")
        XCTAssertEqual(model.drafts.draft(for: request.id), AnswerDraft(text: "明日の10時に開始してください", usedVoice: true))
    }

}
