import XCTest
@testable import OyobidashiKit

@MainActor
final class AnswerViewModelTests: XCTestCase {
    private var stub: StubTransport!
    private var notifications: FakeNotifications!
    private var credentialStore: InMemoryCredentialStore!
    private var model: AppModel!
    private var viewModel: AnswerViewModel!

    private let pending = Fixtures.request("request_pending.json")
    private let answered = Fixtures.request("request_answered.json")
    private var answerPath: String { "/v1/requests/\(pending.id)/answer" }

    override func setUp() async throws {
        stub = StubTransport()
        notifications = FakeNotifications()
        credentialStore = InMemoryCredentialStore(
            Credentials(endpoint: try RelayEndpoint("http://192.168.1.10:8787"), deviceToken: "kd_token", deviceID: "dev_01")
        )
        model = AppModel(
            credentialStore: credentialStore, transport: stub,
            configuration: AppModelConfiguration(deviceName: "iPhone", pushEnvironment: .development),
            notifications: notifications, streamFactory: { _, _ in FakeStream() }
        )
        model.store.upsert(pending)
        viewModel = AnswerViewModel(requestID: pending.id, submitter: model, drafts: model.drafts)
    }

    private var answerRequests: [URLRequest] { stub.requests("POST", answerPath) }

    // MARK: Success

    func testTypedTextIsSentAsTextAndMarksAnswered() async {
        stub.on("POST", answerPath, status: 200, body: requestEnvelope(answered))
        viewModel.userEdited("  あとでやります \n")
        XCTAssertTrue(viewModel.canSubmitText)
        await viewModel.submitText()

        XCTAssertEqual(viewModel.phase, .answered)
        XCTAssertTrue(viewModel.isFinished)
        XCTAssertEqual(viewModel.draft, "")
        assertJSONEqual(answerRequests[0].httpBody, Data(#"{"text":"あとでやります","input_method":"text"}"#.utf8))
        XCTAssertEqual(model.store.pending, [])
        XCTAssertEqual(model.store.history, [answered])
        XCTAssertEqual(notifications.removed, [pending.id])
        XCTAssertEqual(model.drafts.drafts, [:])
    }

    func testChoiceIsSentWithIndexAndMatchesFixture() async {
        stub.on("POST", answerPath, status: 200, body: requestEnvelope(answered))
        viewModel.userEdited("書きかけ")
        await viewModel.submitChoice(index: 0, choices: pending.effectiveChoices)

        XCTAssertEqual(viewModel.phase, .answered)
        assertJSONEqual(answerRequests[0].httpBody, Fixtures.data("answer_request.json"))
    }

    func testSecondChoice() async {
        stub.on("POST", answerPath, status: 200, body: requestEnvelope(answered))
        await viewModel.submitChoice(index: 1, choices: pending.effectiveChoices)
        assertJSONEqual(answerRequests[0].httpBody, Data(#"{"text":"いいえ","choice_index":1,"input_method":"choice"}"#.utf8))
    }

    // MARK: Input method

    func testDictatedTextIsSentAsVoiceEvenAfterManualEdits() async {
        stub.on("POST", answerPath, status: 200, body: requestEnvelope(answered))
        viewModel.applyDictation("ログイン画面のバグ修正を先にやって")
        XCTAssertTrue(viewModel.draftUsedVoice)
        viewModel.userEdited("ログイン画面のバグ修正を先にやってください")
        XCTAssertEqual(viewModel.textInputMethod, .voice)
        await viewModel.submitText()
        assertJSONEqual(answerRequests[0].httpBody, Data(#"{"text":"ログイン画面のバグ修正を先にやってください","input_method":"voice"}"#.utf8))
    }

    func testClearingTheDraftResetsVoiceFlag() async {
        stub.on("POST", answerPath, status: 200, body: requestEnvelope(answered))
        viewModel.applyDictation("音声")
        viewModel.userEdited("")
        XCTAssertFalse(viewModel.draftUsedVoice)
        viewModel.userEdited("手入力")
        await viewModel.submitText()
        assertJSONEqual(answerRequests[0].httpBody, Data(#"{"text":"手入力","input_method":"text"}"#.utf8))
    }

    func testEmptyDictationDoesNotMarkVoice() {
        viewModel.applyDictation("")
        XCTAssertFalse(viewModel.draftUsedVoice)
        viewModel.userEdited("typed")
        viewModel.applyDictation("typed")
        XCTAssertTrue(viewModel.draftUsedVoice)
    }

    // MARK: Validation

    func testBlankOrTooLongDraftIsNotSent() async {
        await viewModel.submitText()
        viewModel.userEdited("   \n\t ")
        XCTAssertFalse(viewModel.canSubmitText)
        await viewModel.submitText()

        viewModel.userEdited(String(repeating: "あ", count: 10_001))
        XCTAssertTrue(viewModel.isDraftTooLong)
        XCTAssertFalse(viewModel.canSubmitText)
        await viewModel.submitText()

        XCTAssertTrue(stub.requests.isEmpty)
        XCTAssertEqual(viewModel.phase, .editing)

        viewModel.userEdited(String(repeating: "あ", count: 10_000))
        XCTAssertTrue(viewModel.canSubmitText)
    }

    func testOutOfRangeChoiceIsNotSent() async {
        await viewModel.submitChoice(index: 2, choices: pending.effectiveChoices)
        await viewModel.submitChoice(index: -1, choices: pending.effectiveChoices)
        await viewModel.submitChoice(index: 0, choices: [])
        XCTAssertTrue(stub.requests.isEmpty)
        XCTAssertEqual(viewModel.phase, .editing)
    }

    // MARK: 409

    func testAlreadyResolvedMarksItemResolvedAndShowsErrorState() async {
        stub.on("POST", answerPath, status: 409, body: Fixtures.data("error_already_resolved.json"))
        guard case .updated(let cancelled) = RelayEvent.decode(text: Fixtures.string("event_request_updated.json")) else { return XCTFail() }
        stub.on("GET", "/v1/requests/\(pending.id)", status: 200, body: requestEnvelope(cancelled))
        viewModel.userEdited("遅かった回答")
        await viewModel.submitText()

        XCTAssertEqual(viewModel.phase, .resolvedElsewhere)
        XCTAssertTrue(viewModel.isFinished)
        XCTAssertFalse(viewModel.canSubmitText)
        XCTAssertFalse(viewModel.canSubmitChoice)
        XCTAssertEqual(viewModel.draft, "遅かった回答", "画面上の入力は消さない")
        XCTAssertEqual(model.store.pending, [])
        XCTAssertEqual(model.store.history.map(\.status), [.cancelled], "サーバー上の最終状態を取り直す")
        XCTAssertTrue(notifications.removed.contains(pending.id))
        XCTAssertEqual(model.drafts.drafts, [:])

        // 以後は送信しない
        await viewModel.submitText()
        await viewModel.submitChoice(index: 0, choices: pending.effectiveChoices)
        XCTAssertEqual(answerRequests.count, 1)
    }

    func testAlreadyResolvedStillLeavesPendingListWhenFinalStateCannotBeFetched() async {
        stub.on("POST", answerPath, status: 409, body: Fixtures.data("error_already_resolved.json"))
        stub.on("GET", "/v1/requests/\(pending.id)") { _ in throw URLError(.networkConnectionLost) }
        await viewModel.submitChoice(index: 0, choices: pending.effectiveChoices)

        XCTAssertEqual(viewModel.phase, .resolvedElsewhere)
        XCTAssertEqual(model.store.pending, [])
        XCTAssertEqual(model.store.history.map(\.id), [pending.id])
        XCTAssertEqual(model.store.locallyResolvedIDs, [pending.id])
    }

    func testNotFoundIsTreatedAsResolved() async {
        stub.on("POST", answerPath, status: 404, body: errorBody("not_found"))
        viewModel.userEdited("x")
        await viewModel.submitText()
        XCTAssertEqual(viewModel.phase, .resolvedElsewhere)
        XCTAssertEqual(model.store.requests, [])
    }

    // MARK: Failures keep the draft

    func testOffLANKeepsDraftAsUnreachableAndRetrySucceedsAfterRecovery() async {
        stub.on("POST", answerPath) { _ in throw URLError(.cannotConnectToHost) }
        viewModel.applyDictation("音声で入れた回答")
        await viewModel.submitText()

        XCTAssertEqual(viewModel.phase, .unreachable)
        XCTAssertEqual(viewModel.draft, "音声で入れた回答")
        XCTAssertTrue(viewModel.draftUsedVoice)
        XCTAssertTrue(viewModel.canSubmitText)
        XCTAssertEqual(model.drafts.draft(for: pending.id), AnswerDraft(text: "音声で入れた回答", usedVoice: true))
        XCTAssertEqual(model.store.reachability, .unreachable)
        XCTAssertEqual(model.store.pending, [pending])
        XCTAssertTrue(model.isPaired)

        // 画面を開き直しても下書きが残っている
        let reopened = AnswerViewModel(requestID: pending.id, submitter: model, drafts: model.drafts)
        XCTAssertEqual(reopened.draft, "音声で入れた回答")
        XCTAssertTrue(reopened.draftUsedVoice)

        // LAN に戻って再送
        stub.on("POST", answerPath, status: 200, body: requestEnvelope(answered))
        await viewModel.submitText()
        XCTAssertEqual(viewModel.phase, .answered)
        XCTAssertEqual(model.store.reachability, .reachable)
        assertJSONEqual(answerRequests.last?.httpBody, Data(#"{"text":"音声で入れた回答","input_method":"voice"}"#.utf8))
        XCTAssertEqual(model.drafts.drafts, [:])
    }

    func testTimeoutIsAlsoUnreachable() async {
        stub.on("POST", answerPath) { _ in throw URLError(.timedOut) }
        viewModel.userEdited("x")
        await viewModel.submitText()
        XCTAssertEqual(viewModel.phase, .unreachable)
        XCTAssertEqual(viewModel.draft, "x")
    }

    func testServerErrorKeepsDraftAsFailedAndEditingClearsTheError() async {
        stub.on("POST", answerPath, status: 500, body: errorBody("internal", "boom"))
        viewModel.userEdited("回答")
        await viewModel.submitText()
        XCTAssertEqual(viewModel.phase, .failed(.server(message: "boom")))
        XCTAssertEqual(viewModel.draft, "回答")
        XCTAssertEqual(model.store.pending, [pending])

        viewModel.userEdited("回答2")
        XCTAssertEqual(viewModel.phase, .editing)
    }

    func testChoiceFailureKeepsTypedDraft() async {
        stub.on("POST", answerPath) { _ in throw URLError(.cannotConnectToHost) }
        viewModel.userEdited("書きかけ")
        await viewModel.submitChoice(index: 0, choices: pending.effectiveChoices)
        XCTAssertEqual(viewModel.phase, .unreachable)
        XCTAssertEqual(viewModel.draft, "書きかけ")
        XCTAssertTrue(viewModel.canSubmitChoice)
    }

    // MARK: Unauthorized

    func testUnauthorizedSignsOut() async {
        stub.on("POST", answerPath, status: 401, body: Fixtures.data("error_unauthorized.json"))
        viewModel.userEdited("x")
        await viewModel.submitText()

        XCTAssertEqual(viewModel.phase, .signedOut)
        XCTAssertEqual(model.phase, .unpaired)
        XCTAssertEqual(model.signedOutReason, .unauthorized)
        XCTAssertNil(credentialStore.current)
        XCTAssertEqual(model.store.requests, [])
    }

    // MARK: Concurrency

    func testDoubleSubmitSendsOnce() async {
        stub.on("POST", answerPath, status: 200, body: requestEnvelope(answered))
        viewModel.userEdited("一度だけ")
        async let first: Void = viewModel.submitText()
        async let second: Void = viewModel.submitText()
        _ = await (first, second)
        XCTAssertEqual(answerRequests.count, 1)
        XCTAssertEqual(viewModel.phase, .answered)
    }
}
