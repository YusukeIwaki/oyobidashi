import XCTest
@testable import OyobidashiKit

@MainActor
final class RequestListStoreTests: XCTestCase {
    private var notifications: FakeNotifications!
    private var drafts: DraftStore!
    private var store: RequestListStore!

    override func setUp() async throws {
        notifications = FakeNotifications()
        drafts = DraftStore()
        store = RequestListStore(notifications: notifications, drafts: drafts)
    }

    func testHelloReplacesPendingList() {
        let a = makeRequest(id: "a", created: "2026-11-15T14:00:00.000Z")
        let b = makeRequest(id: "b", created: "2026-11-15T14:01:00.000Z")
        let done = makeRequest(id: "done", status: .answered, created: "2026-11-15T13:00:00.000Z")
        store.merge([a, b, done])
        drafts.set(AnswerDraft(text: "下書き"), for: "a")
        drafts.set(AnswerDraft(text: "残る"), for: "b")
        XCTAssertEqual(store.pending.map(\.id), ["b", "a"])

        let c = makeRequest(id: "c", created: "2026-11-15T14:02:00.000Z")
        store.apply(.hello(pending: [b, c]))

        XCTAssertEqual(store.pending.map(\.id), ["c", "b"], "hello に無い a は未回答から消える")
        XCTAssertEqual(store.history.map(\.id), ["done"], "履歴はそのまま")
        // "done" は取り込み時 (回答済みなので通知不要)、"a" は hello で消えたとき
        XCTAssertEqual(notifications.removed, ["done", "a"])
        XCTAssertNil(drafts.draft(for: "a"))
        XCTAssertEqual(drafts.draft(for: "b")?.text, "残る")
        XCTAssertEqual(notifications.presented, [], "hello では通知を出さない")
    }

    func testHomeNoticeClearsWithoutChangingRequestsOrDrafts() throws {
        let request = makeRequest(id: "a", created: "2026-11-15T14:00:00.000Z")
        let hello = try XCTUnwrap(RelayEvent.decode(text: """
            {"type":"hello","pending":[],"home_notice":{"type":"voice_plan_consent_required","providers":{"free":"meta","plus":"gemini"}}}
            """))
        store.apply(hello)
        XCTAssertEqual(store.homeNotice?.requiresVoicePlanConsent, true)
        XCTAssertEqual(store.homeNotice?.providers["plus"], "gemini")
        store.merge([request])
        drafts.set(AnswerDraft(text: "入力中"), for: request.id)
        let cleared = try XCTUnwrap(RelayEvent.decode(text: #"{"type":"home_notice.updated","notice":null}"#))
        store.apply(cleared)
        XCTAssertNil(store.homeNotice)
        XCTAssertEqual(store.pending.map(\.id), [request.id])
        XCTAssertEqual(drafts.draft(for: request.id)?.text, "入力中")
        XCTAssertTrue(notifications.presented.isEmpty)
    }

    func testEmptyHelloClearsPending() {
        store.merge([makeRequest(id: "a"), makeRequest(id: "n", kind: .notification, status: .notified)])
        store.apply(.hello(pending: []))
        XCTAssertEqual(store.pending, [])
        XCTAssertEqual(store.history.map(\.id), ["n"])
    }

    func testCreatedInsertsSortedAndPresentsOnce() {
        let old = makeRequest(id: "old", created: "2026-11-15T14:00:00.000Z")
        let new = makeRequest(id: "new", created: "2026-11-15T14:05:00.000Z")
        store.apply(.created(new))
        store.apply(.created(old))
        XCTAssertEqual(store.requests.map(\.id), ["new", "old"])
        XCTAssertEqual(notifications.presented, ["new", "old"])

        // 重複イベント
        store.apply(.created(new))
        store.apply(.created(new))
        XCTAssertEqual(store.requests.map(\.id), ["new", "old"])
        XCTAssertEqual(notifications.presented, ["new", "old"])
    }

    func testCreatedNotificationGoesToHistoryAndIsPresentedButNotRemoved() {
        let n = Fixtures.request("request_notification.json")
        store.apply(.created(n))
        XCTAssertEqual(store.pending, [])
        XCTAssertEqual(store.history, [n])
        XCTAssertEqual(notifications.presented, [n.id])
        XCTAssertEqual(notifications.removed, [], "お知らせの通知は消さない")
    }

    func testCancelledOneWayNotificationIsRemoved() {
        var notice = makeRequest(id: "notice", kind: .notification, status: .notified)
        store.apply(.created(notice))
        XCTAssertEqual(notifications.removed, [])
        notice.status = .cancelled
        store.apply(.updated(notice))
        XCTAssertEqual(notifications.removed, [notice.id])
        store.apply(.updated(notice))
        XCTAssertEqual(notifications.removed, [notice.id], "duplicate cancellation must not restore a notification")
    }

    func testFetchedCancelledOneWayNotificationRemovesUnknownDeliveredNotice() {
        // APNs can have displayed a notice without the app having fetched it yet.
        let cancelled = makeRequest(id: "remote-notice", kind: .notification, status: .cancelled)
        store.merge([cancelled])
        XCTAssertEqual(notifications.removed, [cancelled.id])
        XCTAssertEqual(notifications.presented, [])
    }

    func testCreatedForAlreadyKnownRequestDoesNotPresentAgain() {
        let r = makeRequest(id: "a")
        store.merge([r]) // Push 経由の取得などで既に知っている
        store.apply(.created(r))
        XCTAssertEqual(notifications.presented, [])
    }

    func testCreatedWithUnknownKindIsStoredButNotPresented() {
        let r = makeRequest(id: "p", kind: .unknown("poll"))
        store.apply(.created(r))
        XCTAssertEqual(store.history.map(\.id), ["p"])
        XCTAssertEqual(store.pending, [])
        XCTAssertEqual(notifications.presented, [])
    }

    func testUpdatedResolvesPendingAndRemovesNotificationAndDraft() {
        let pending = Fixtures.request("request_pending.json")
        store.apply(.created(pending))
        drafts.set(AnswerDraft(text: "書きかけ"), for: pending.id)
        guard case .updated(let cancelled) = RelayEvent.decode(text: Fixtures.string("event_request_updated.json")) else { return XCTFail() }

        store.apply(.updated(cancelled))
        XCTAssertEqual(store.pending, [])
        XCTAssertEqual(store.history, [cancelled])
        XCTAssertEqual(notifications.removed, [pending.id])
        XCTAssertNil(drafts.draft(for: pending.id))

        // 重複しても変わらない
        store.apply(.updated(cancelled))
        XCTAssertEqual(store.history, [cancelled])
        XCTAssertEqual(notifications.removed, [pending.id])
    }

    func testUpdatedForUnknownRequestIsInsertedWithoutPresenting() {
        let answered = Fixtures.request("request_answered.json")
        store.apply(.updated(answered))
        XCTAssertEqual(store.history, [answered])
        XCTAssertEqual(notifications.presented, [])
    }

    func testStaleEventsNeverReopenAResolvedRequest() {
        let answered = Fixtures.request("request_answered.json")
        let pending = Fixtures.request("request_pending.json")
        store.upsert(answered)
        XCTAssertEqual(store.upsert(pending), .ignoredStale)
        store.apply(.created(pending))
        store.apply(.hello(pending: [pending]))
        XCTAssertEqual(store.request(id: answered.id)?.status, .answered)
        XCTAssertEqual(store.pending, [])
        XCTAssertEqual(notifications.presented, [])
    }

    func testUpsertResultsAndUpdatedAtOrdering() {
        let v1 = makeRequest(id: "a", updated: "2026-11-15T14:00:10.000Z")
        var v2 = v1
        v2.question = "edited"
        v2.updatedAt = date("2026-11-15T14:00:20.000Z")
        XCTAssertEqual(store.upsert(v1), .inserted)
        XCTAssertEqual(store.upsert(v1), .unchanged)
        XCTAssertEqual(store.upsert(v2), .updated)
        XCTAssertEqual(store.upsert(v1), .ignoredStale, "古い updated_at は無視")
        XCTAssertEqual(store.request(id: "a")?.question, "edited")

        // 終端への遷移は updated_at が古くても採用する (時計のずれ対策)
        var resolved = v1
        resolved.status = .expired
        resolved.updatedAt = date("2026-11-15T14:00:05.000Z")
        XCTAssertEqual(store.upsert(resolved), .updated)
        XCTAssertEqual(store.request(id: "a")?.status, .expired)
    }

    func testSortOrderIsCreatedAtDescendingThenID() {
        store.merge([
            makeRequest(id: "a", created: "2026-11-15T14:00:00.000Z"),
            makeRequest(id: "c", created: "2026-11-15T14:00:00.000Z"),
            makeRequest(id: "b", created: "2026-11-15T14:00:00.500Z"),
        ])
        XCTAssertEqual(store.requests.map(\.id), ["b", "c", "a"])
    }

    func testMarkResolvedLocallyHidesFromPendingUntilRealStateArrives() {
        let pending = Fixtures.request("request_pending.json")
        store.upsert(pending)
        drafts.set(AnswerDraft(text: "x"), for: pending.id)
        store.markResolvedLocally(id: pending.id)

        XCTAssertEqual(store.pending, [])
        XCTAssertEqual(store.history.map(\.id), [pending.id])
        XCTAssertEqual(store.locallyResolvedIDs, [pending.id])
        XCTAssertEqual(notifications.removed, [pending.id])
        XCTAssertNil(drafts.draft(for: pending.id))

        store.upsert(Fixtures.request("request_answered.json"))
        XCTAssertEqual(store.locallyResolvedIDs, [])
        XCTAssertEqual(store.history.first?.status, .answered)

        store.markResolvedLocally(id: "unknown-id")
        XCTAssertEqual(store.locallyResolvedIDs, [])
    }

    func testRemoveAndReset() {
        store.merge([makeRequest(id: "a"), makeRequest(id: "b")])
        store.remove(id: "a")
        XCTAssertEqual(store.requests.map(\.id), ["b"])
        XCTAssertEqual(notifications.removed, ["a"])
        store.reachability = .unreachable
        store.reset()
        XCTAssertEqual(store.requests, [])
        XCTAssertEqual(store.reachability, .unknown)
        XCTAssertEqual(store.connection, .disconnected)
    }

    func testPongAndUnknownEventsDoNothing() {
        store.upsert(makeRequest(id: "a"))
        store.apply(.pong)
        store.apply(.unknown(type: "x"))
        XCTAssertEqual(store.requests.map(\.id), ["a"])
        XCTAssertEqual(notifications.removed, [])
    }

    // MARK: Drafts

    func testDraftStorePersistsAndTreatsBlankAsNoDraft() {
        let persistence = InMemoryDraftPersistence()
        let first = DraftStore(persistence: persistence)
        first.set(AnswerDraft(text: "あとで送る", usedVoice: true), for: "r1")
        first.set(AnswerDraft(text: "   "), for: "r2")
        XCTAssertNil(first.draft(for: "r2"))

        let reloaded = DraftStore(persistence: persistence)
        XCTAssertEqual(reloaded.draft(for: "r1"), AnswerDraft(text: "あとで送る", usedVoice: true))

        reloaded.set(AnswerDraft(text: ""), for: "r1")
        XCTAssertEqual(DraftStore(persistence: persistence).drafts, [:])
    }

    func testUserDefaultsDraftPersistence() throws {
        let suite = "oyobidashi-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let persistence = UserDefaultsDraftPersistence(defaults: defaults)
        XCTAssertEqual(persistence.load(), [:])
        persistence.save(["r": AnswerDraft(text: "t", usedVoice: true)])
        XCTAssertEqual(persistence.load(), ["r": AnswerDraft(text: "t", usedVoice: true)])
        defaults.set(Data("garbage".utf8), forKey: "oyobidashi.answer-drafts")
        XCTAssertEqual(persistence.load(), [:], "壊れたデータは空として扱う")
        persistence.save([:])
        XCTAssertNil(defaults.data(forKey: "oyobidashi.answer-drafts"))
    }
    func testEndedCallPresentsTextFallbackOnce() {
        let notifications = FakeNotifications()
        let store = RequestListStore(notifications: notifications)
        var request = makeRequest(id: "call-fallback")
        request.deliveryMode = .call
        request.call = CallSession(id: "call", requestID: request.id, state: .ringing, startedAt: request.createdAt)
        store.apply(.created(request))
        request.deliveryMode = .text
        request.call?.state = .ended
        request.call?.outcome = .declined
        store.apply(.updated(request))
        store.apply(.updated(request))
        XCTAssertEqual(notifications.presented.filter { $0 == request.id }.count, 2, "one created signal and one text fallback; duplicate update does not alert again")
    }

}
