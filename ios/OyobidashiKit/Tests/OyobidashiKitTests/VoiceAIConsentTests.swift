import XCTest
@testable import OyobidashiKit

/// 音声会話の内容をAIへ送ることへの同意。ペアリングのときに1回だけ受け取り、通話中には尋ねない。
@MainActor
final class VoiceAIConsentTests: XCTestCase {
    private let lan = try! RelayEndpoint("http://192.168.1.10:8787")
    private let cloud = try! RelayEndpoint("https://api.example.test")
    private var stub: StubTransport!
    private var credentialStore: InMemoryCredentialStore!
    private var consentStore: InMemoryVoiceAIConsentStore!

    override func setUp() async throws {
        stub = StubTransport()
        credentialStore = InMemoryCredentialStore()
        consentStore = InMemoryVoiceAIConsentStore()
    }

    private func makeModel() -> AppModel {
        AppModel(credentialStore: credentialStore, transport: stub,
                 configuration: AppModelConfiguration(deviceName: "phone", pushEnvironment: .development),
                 voiceAIConsentStore: consentStore)
    }

    private func health(provider: String?) {
        let voiceAI = provider.map { #","voice_ai":{"provider":"\#($0)"}"# } ?? ""
        stub.on("GET", "/healthz", status: 200, body: Data(#"{"ok":true,"version":"0.3.0"\#(voiceAI)}"#.utf8))
    }

    private func consent(_ endpoint: RelayEndpoint, provider: String?, version: Int = VoiceAIConsent.currentVersion) -> VoiceAIConsent {
        VoiceAIConsent(endpoint: endpoint, disclosure: VoiceAIDisclosure(provider: provider), acceptedAt: Date(), version: version)
    }

    // MARK: 説明

    func testDisclosureNamesTheRecipientAndWhatIsSent() {
        XCTAssertEqual(VoiceAIDisclosure(provider: "anthropic").recipientName, "Anthropic")
        XCTAssertEqual(VoiceAIDisclosure(provider: "meta").recipientName, "Meta")
        XCTAssertEqual(VoiceAIDisclosure(provider: "gemini").recipientName, "Google（Gemini）")
        XCTAssertTrue(VoiceAIDisclosure(provider: "claude-code").recipientName.contains("Claude Code"))
        // 知らない送信先の名前を推測で出さない。
        XCTAssertEqual(VoiceAIDisclosure(provider: "someone-new").recipientName, VoiceAIDisclosure.unknown.recipientName)
        let text = VoiceAIDisclosure(provider: "meta").paragraphs.joined()
        for required in ["Meta", "文字に変換", "質問", "履歴", "音声そのものは送信しません"] {
            XCTAssertTrue(text.contains(required), required)
        }
        // 同意の対象でない文字・選択肢での回答には触れない。
        XCTAssertFalse(text.contains("選択肢での回答"))
    }

    func testHealthCarriesTheRecipientOnlyWhenTheServerStatesIt() async throws {
        health(provider: "meta")
        let model = makeModel()
        let stated = await model.voiceAIDisclosure(for: cloud)
        XCTAssertEqual(stated, VoiceAIDisclosure(provider: "meta"))
        health(provider: nil)
        let silent = await model.voiceAIDisclosure(for: cloud)
        XCTAssertEqual(silent, .unknown)
        stub.on("GET", "/healthz", status: 503)
        let unreachable = await model.voiceAIDisclosure(for: cloud)
        XCTAssertEqual(unreachable, .unknown)
    }

    // MARK: 同意の記録が何を覆うか

    func testConsentCoversOnlyItsEndpointVersionAndRecipient() {
        let record = consent(cloud, provider: "anthropic")
        XCTAssertTrue(record.covers(cloud))
        XCTAssertFalse(record.covers(lan))
        XCTAssertFalse(consent(cloud, provider: "anthropic", version: VoiceAIConsent.currentVersion + 1).covers(cloud))
        XCTAssertTrue(record.covers(cloud, disclosure: VoiceAIDisclosure(provider: "anthropic")))
        XCTAssertFalse(record.covers(cloud, disclosure: VoiceAIDisclosure(provider: "meta")))
        XCTAssertFalse(record.covers(cloud, disclosure: VoiceAIDisclosure(provider: "gemini")))
        // 送信先を確認できないだけなら、受け取った同意は有効のまま。
        XCTAssertTrue(record.covers(cloud, disclosure: .unknown))
        // 送信先を示さない接続先で同意した後に送信先が示されたら、取り直す。
        XCTAssertFalse(consent(cloud, provider: nil).covers(cloud, disclosure: VoiceAIDisclosure(provider: "meta")))
    }

    func testUserDefaultsStoreRoundTripsAndClears() {
        let suite = "oyobidashi.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = UserDefaultsVoiceAIConsentStore(defaults: defaults)
        XCTAssertNil(store.load())
        let record = consent(cloud, provider: "meta")
        store.save(record)
        XCTAssertEqual(store.load()?.endpoint, record.endpoint)
        XCTAssertEqual(store.load()?.provider, "meta")
        store.save(nil)
        XCTAssertNil(store.load())
    }

    // MARK: ペアリング時

    func testPairingRecordsTheConsentGivenOnThePairingScreen() async {
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        let model = makeModel()
        XCTAssertFalse(model.hasVoiceAIConsent)
        let paired = await model.pair(PairingInfo(endpoint: cloud, code: "c"), voiceAIConsent: VoiceAIDisclosure(provider: "meta"))
        XCTAssertTrue(paired)
        XCTAssertTrue(model.hasVoiceAIConsent)
        XCTAssertNil(model.voiceAIReview)
        XCTAssertEqual(consentStore.load()?.provider, "meta")
        XCTAssertEqual(consentStore.load()?.covers(cloud), true)
    }

    func testFailedPairingRecordsNothingAndKeepsTheCurrentConsent() async {
        try! credentialStore.save(Credentials(endpoint: lan, deviceToken: "kd_token", deviceID: "dev_01"))
        consentStore.save(consent(lan, provider: "claude-code"))
        stub.on("POST", "/v1/pair", status: 401, body: Data(#"{"error":{"code":"pairing_code_invalid"}}"#.utf8))
        let model = makeModel()
        let paired = await model.pair(PairingInfo(endpoint: cloud, code: "bad"), voiceAIConsent: VoiceAIDisclosure(provider: "meta"))
        XCTAssertFalse(paired)
        XCTAssertTrue(model.hasVoiceAIConsent)
        XCTAssertEqual(consentStore.load()?.covers(lan), true)
    }

    func testConsentForOneServerNeverCarriesOverToAnother() async {
        try! credentialStore.save(Credentials(endpoint: lan, deviceToken: "kd_token", deviceID: "dev_01"))
        consentStore.save(consent(lan, provider: "claude-code"))
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        stub.on("DELETE", "/v1/devices/me", status: 204)
        let model = makeModel()
        XCTAssertTrue(model.hasVoiceAIConsent)
        // 同意を伴わないペアリングは、前の接続先の同意を引き継がない。
        let paired = await model.pair(PairingInfo(endpoint: cloud, code: "c"))
        XCTAssertTrue(paired)
        XCTAssertFalse(model.hasVoiceAIConsent)
        XCTAssertNil(consentStore.load())
    }

    func testUnpairingForgetsTheConsent() async {
        stub.on("POST", "/v1/pair", status: 201, body: Fixtures.data("pair_response.json"))
        stub.on("DELETE", "/v1/devices/me", status: 204)
        let model = makeModel()
        _ = await model.pair(PairingInfo(endpoint: cloud, code: "c"), voiceAIConsent: VoiceAIDisclosure(provider: "meta"))
        await model.unpair()
        XCTAssertFalse(model.hasVoiceAIConsent)
        XCTAssertNil(consentStore.load())
    }

    // MARK: 通話時: 尋ねない。同意がなければ送らない。

    func testWithoutConsentNoUtteranceLeavesTheDevice() async {
        try! credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        let model = makeModel()
        let outcome = await model.sendCallTurn(requestID: "req_1", text: "はい")
        XCTAssertEqual(outcome, .failed(.voiceAIConsentRequired))
        XCTAssertTrue(stub.requests.isEmpty)
        XCTAssertTrue(RelayError.voiceAIConsentRequired.userMessage.contains("文字で返信"))
    }

    func testWithConsentTheUtteranceIsSentWithoutAnyFurtherQuestion() async {
        try! credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        consentStore.save(consent(cloud, provider: "meta"))
        stub.onAny { _ in .init(409, Data(#"{"error":{"code":"call_ended"}}"#.utf8)) }
        let model = makeModel()
        _ = await model.sendCallTurn(requestID: "req_1", text: "はい")
        // 送信されるのは発話そのものだけで、送信先の確認などは挟まらない。
        XCTAssertEqual(stub.requests.map { $0.url?.path }, ["/v1/requests/req_1/call"])
        XCTAssertEqual(stub.requests.first?.value(forHTTPHeaderField: "X-Oyobidashi-Voice-Provider"), "meta")
    }

    func testProviderChangeOffersTextWithoutDiscardingThePairing() async throws {
        try credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        consentStore.save(consent(cloud, provider: "meta"))
        stub.on("GET", "/v1/voice/disclosure", status: 200, body: Data(#"{"provider":"gemini"}"#.utf8))
        let model = makeModel()
        await model.reviewVoiceAIConsent()
        XCTAssertEqual(model.voiceAIReview?.recipientName, "Google（Gemini）")
        XCTAssertFalse(model.hasVoiceAIConsent)
        model.deferVoiceAIConsent()
        await model.reviewVoiceAIConsent()
        XCTAssertNil(model.voiceAIReview)
        XCTAssertTrue(model.isPaired)
        let refused = await model.sendCallTurn(requestID: "req_1", text: "はい")
        XCTAssertEqual(refused, .failed(.voiceAIConsentRequired))
        XCTAssertFalse(stub.requests.contains { $0.httpMethod == "POST" })
        await model.reviewVoiceAIConsent(force: true)
        XCTAssertEqual(model.voiceAIReview?.provider, "gemini")
    }

    func testCloudConsentCoversBothPlansAndCanBeWithdrawnOnTheAccount() async throws {
        try credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        let model = makeModel()
        func setConsent(provider: String, accepted: Bool) {
            let data = Data(#"{"provider":"\#(provider)","consented":\#(accepted)}"#.utf8)
            stub.on("GET", "/v1/voice/disclosure", status: 200, body: data)
        }
        setConsent(provider: "meta", accepted: true)
        await model.reviewVoiceAIConsent()
        XCTAssertTrue(model.hasVoiceAIConsent)
        XCTAssertTrue(model.usesAccountVoiceConsent)
        XCTAssertNil(model.voiceAIReview)
        XCTAssertNil(consentStore.load())
        XCTAssertEqual(stub.requests.first?.value(forHTTPHeaderField: "X-Oyobidashi-Voice-Plan-Consent"), "1")

        setConsent(provider: "gemini", accepted: true)
        stub.on("POST", "/v1/requests/req_1/call", status: 409,
                body: Data(#"{"error":{"code":"call_ended"}}"#.utf8))
        _ = await model.answerCall(requestID: "req_1")
        XCTAssertTrue(model.hasVoiceAIConsent)
        XCTAssertNil(model.voiceAIReview)
        XCTAssertEqual(stub.requests.last?.httpMethod, "POST")
        XCTAssertNil(stub.requests.last?.value(forHTTPHeaderField: "X-Oyobidashi-Voice-Provider"))

        setConsent(provider: "gemini", accepted: false)
        await model.reviewVoiceAIConsent()
        XCTAssertFalse(model.hasVoiceAIConsent)
        XCTAssertNil(model.voiceAIReview)
        let refused = await model.sendCallTurn(requestID: "req_1", text: "はい")
        XCTAssertEqual(refused, .failed(.voiceAIConsentRequired))
        XCTAssertTrue(model.isPaired)
    }

    func testAnswerChecksAccountConsentOnColdStart() async throws {
        try credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        stub.on("GET", "/v1/voice/disclosure", status: 200, body: Data(#"{"provider":"gemini","consented":true}"#.utf8))
        stub.on("POST", "/v1/requests/req_1/call", status: 409,
                body: Data(#"{"error":{"code":"call_ended"}}"#.utf8))
        let model = makeModel()
        XCTAssertFalse(model.hasVoiceAIConsent)

        _ = await model.answerCall(requestID: "req_1")

        XCTAssertTrue(model.hasVoiceAIConsent)
        XCTAssertNil(model.voiceAIReview)
        XCTAssertEqual(stub.requests.map { $0.url?.path }, ["/v1/voice/disclosure", "/v1/requests/req_1/call"])
    }

    func testHandoffFetchesTheRequestAndKeepsTheAnswersAlreadySaved() async throws {
        try credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        consentStore.save(consent(cloud, provider: "gemini"))
        stub.on("POST", "/v1/requests/req_1/call", status: 409,
                body: Data(#"{"error":{"code":"voice_handoff"}}"#.utf8))
        stub.on("GET", "/v1/requests/req_1", status: 200, body: Data("""
            {"request":{"id":"req_1","question":"配送確認","status":"pending","created_at":"2026-11-25T00:00:00.000Z",
            "delivery_mode":"text","items":[{"id":"route","question":"配送方法"},{"id":"day","question":"発送日"}],
            "item_answers":[{"item_id":"route","status":"answered","text":"通常便","input_method":"voice"}],
            "call":{"id":"call_1","state":"ended","end_call":true}}}
            """.utf8))
        let model = makeModel()
        let outcome = await model.sendCallTurn(requestID: "req_1", text: "金曜日")
        XCTAssertEqual(outcome, .failed(.voiceHandoff))
        XCTAssertEqual(model.voiceHandoffRequestID, "req_1")
        XCTAssertEqual(model.store.request(id: "req_1")?.itemAnswers?.first?.text, "通常便")
        XCTAssertEqual(stub.requests.first?.value(forHTTPHeaderField: "X-Oyobidashi-Voice-Provider"), "gemini")
    }

    // MARK: 起動時: 既存のペアリングと、送信先の変更

    func testAnInstallPairedBeforeThisVersionIsAskedOnce() async {
        try! credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        health(provider: "anthropic")
        let model = makeModel()
        XCTAssertFalse(model.hasVoiceAIConsent)
        await model.reviewVoiceAIConsent()
        XCTAssertEqual(model.voiceAIReview, VoiceAIDisclosure(provider: "anthropic"))
        model.acceptVoiceAI(model.voiceAIReview!)
        XCTAssertTrue(model.hasVoiceAIConsent)
        XCTAssertNil(model.voiceAIReview)
        // 次の起動では尋ねない。
        let relaunched = makeModel()
        XCTAssertTrue(relaunched.hasVoiceAIConsent)
        await relaunched.reviewVoiceAIConsent()
        XCTAssertNil(relaunched.voiceAIReview)
    }

    func testAChangedRecipientAsksAgainAndAnUnreachableServerDoesNot() async {
        try! credentialStore.save(Credentials(endpoint: cloud, deviceToken: "kd_token", deviceID: "dev_01"))
        consentStore.save(consent(cloud, provider: "anthropic"))
        let model = makeModel()
        stub.on("GET", "/healthz", status: 503)
        await model.reviewVoiceAIConsent()
        XCTAssertTrue(model.hasVoiceAIConsent)
        XCTAssertNil(model.voiceAIReview)
        health(provider: "anthropic")
        await model.reviewVoiceAIConsent()
        XCTAssertTrue(model.hasVoiceAIConsent)
        health(provider: "meta")
        await model.reviewVoiceAIConsent()
        XCTAssertFalse(model.hasVoiceAIConsent)
        XCTAssertEqual(model.voiceAIReview, VoiceAIDisclosure(provider: "meta"))
        XCTAssertNil(consentStore.load())
    }

    func testAnUnpairedAppIsNeverAsked() async {
        let model = makeModel()
        await model.reviewVoiceAIConsent()
        XCTAssertNil(model.voiceAIReview)
        XCTAssertTrue(stub.requests.isEmpty)
    }
}
