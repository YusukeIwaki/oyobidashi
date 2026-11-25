package me.oyobidashi.android.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RequestsRepositoryTest {
    private val api = FakeApi()
    private val notifier = FakeNotifier()
    private val drafts = InMemoryDraftStore()
    private var signedOutCalls = 0
    private val repo = RequestsRepository(api, notifier, { signedOutCalls++ }, drafts)
    private val state get() = repo.state.value

    private val t0 = "2026-11-15T14:00:00.000Z"
    private val t1 = "2026-11-15T14:01:00.000Z"
    private val t2 = "2026-11-15T14:02:00.000Z"

    // ---- hello / created / updated ----

    @Test
    fun `home notice clears independently from questions and drafts`() {
        val hello = RelayEvent.parse(
            """{"type":"hello","pending":[],"home_notice":{"type":"voice_plan_consent_required","providers":{"free":"meta","plus":"gemini"}}}"""
        )!!
        repo.onEvent(hello)
        assertTrue(state.homeNotice?.requiresVoicePlanConsent == true)
        assertEquals("gemini", state.homeNotice?.providers?.get("plus"))
        repo.applyRequest(request("a"))
        repo.editDraft("a", "入力中")
        repo.onEvent(RelayEvent.parse("""{"type":"home_notice.updated","notice":null}""")!!)
        assertNull(state.homeNotice)
        assertEquals(listOf("a"), state.pending.map { it.id })
        assertEquals("入力中", state.draft("a").text)
    }

    @Test
    fun `hello replaces the pending list`() {
        repo.onEvent(RelayEvent.Hello(listOf(request("a"), request("b", createdAt = t1))))
        assertEquals(listOf("b", "a"), state.pending.map { it.id }) // created_at 降順
        repo.onEvent(RelayEvent.Hello(listOf(request("b", createdAt = t1), request("c", createdAt = t2))))
        assertEquals(listOf("c", "b"), state.pending.map { it.id })
        assertNull(state.find("a"))
        assertEquals(listOf("a"), notifier.cancelled) // 手元で pending のまま消えたものは通知も消す
    }

    @Test
    fun `hello keeps history and does not post notifications`() {
        repo.applyRequest(request("old", RequestStatus.ANSWERED))
        repo.onEvent(RelayEvent.Hello(listOf(request("a"))))
        assertEquals(listOf("a", "old"), state.requests.map { it.id })
        assertEquals(listOf("old"), state.history.map { it.id })
        assertTrue(notifier.shown.isEmpty())
        repo.onEvent(RelayEvent.Hello(emptyList()))
        assertTrue(state.pending.isEmpty())
        assertEquals(listOf("old"), state.history.map { it.id })
    }

    @Test
    fun `hello fixture`() {
        repo.onEvent(RelayEvent.parse(Fixtures.text("event_hello.json"))!!)
        assertEquals(listOf(Fixtures.request("request_pending.json")), state.pending)
    }

    @Test
    fun `created adds a pending request and posts a local notification`() {
        val r = request("a", choices = listOf("はい", "いいえ"), question = "よい?")
        repo.onEvent(RelayEvent.RequestCreated(r))
        assertEquals(listOf(r), state.pending)
        assertEquals(
            listOf(
                NotificationContent(
                    "a", RequestKind.QUESTION, "claude-code からの質問", "よい?", Urgency.NORMAL, listOf("はい", "いいえ"),
                    status = RequestStatus.PENDING,
                )
            ),
            notifier.shown,
        )
    }

    @Test
    fun `created notification kind goes to history and notifies as お知らせ`() {
        repo.onEvent(RelayEvent.RequestCreated(Fixtures.request("request_notification.json")))
        assertTrue(state.pending.isEmpty())
        assertEquals(1, state.history.size)
        assertEquals("codex からのお知らせ", notifier.shown.single().title)
        assertEquals(RequestKind.NOTIFICATION, notifier.shown.single().kind)
    }

    @Test
    fun `authoritative notified request keeps its notification until cancelled`() {
        val notice = request("notice", RequestStatus.NOTIFIED, kind = RequestKind.NOTIFICATION, updatedAt = t1)
        repo.onEvent(RelayEvent.RequestCreated(notice))
        repo.applyRequest(notice) // FCM配信後のHTTP取得でも同じ照合を通る。
        assertTrue("未取消のお知らせを消さない", notifier.cancelled.isEmpty())

        repo.applyRequest(notice.copy(status = RequestStatus.CANCELLED, updatedAt = t2))
        assertEquals(listOf("notice"), notifier.cancelled)
    }

    @Test
    fun `hello does not dismiss a notified notice`() {
        val notice = request("notice", RequestStatus.NOTIFIED, kind = RequestKind.NOTIFICATION)
        repo.onEvent(RelayEvent.Hello(listOf(notice)))
        assertTrue(notifier.cancelled.isEmpty())
    }

    @Test
    fun `duplicate created and updated events are idempotent`() {
        val r = request("a")
        repeat(3) { repo.onEvent(RelayEvent.RequestCreated(r)) }
        assertEquals(1, state.requests.size)
        assertEquals("notified only once", 1, notifier.shown.size)
        val answered = request("a", RequestStatus.ANSWERED, updatedAt = t1)
        val before = run { repo.onEvent(RelayEvent.RequestUpdated(answered)); state }
        repo.onEvent(RelayEvent.RequestUpdated(answered))
        assertEquals(before, state)
        assertEquals(listOf(answered), state.requests)
    }

    @Test
    fun `updated moves a request from pending to history and dismisses its notification`() {
        repo.onEvent(RelayEvent.RequestCreated(request("a")))
        repo.onEvent(RelayEvent.RequestUpdated(request("a", RequestStatus.CANCELLED, updatedAt = t2)))
        assertTrue(state.pending.isEmpty())
        assertEquals(RequestStatus.CANCELLED, state.find("a")?.status)
        assertEquals(listOf("a"), notifier.cancelled)
    }

    @Test
    fun `updated for an unknown request is inserted`() {
        repo.onEvent(RelayEvent.parse(Fixtures.text("event_request_updated.json"))!!)
        assertEquals(RequestStatus.CANCELLED, state.find("req_01JCXYZ")?.status)
    }

    @Test
    fun `late or stale events never move a resolved request back to pending`() {
        repo.onEvent(RelayEvent.RequestUpdated(request("a", RequestStatus.ANSWERED, updatedAt = t1)))
        repo.onEvent(RelayEvent.RequestCreated(request("a", RequestStatus.PENDING, updatedAt = t0)))
        repo.onEvent(RelayEvent.Hello(listOf(request("a", RequestStatus.PENDING, updatedAt = t2))))
        assertEquals(RequestStatus.ANSWERED, state.find("a")?.status)
        assertTrue(notifier.shown.isEmpty())
    }

    @Test
    fun `older updated_at does not overwrite a newer copy`() {
        repo.applyRequest(request("a", updatedAt = t2, question = "new"))
        repo.applyRequest(request("a", updatedAt = t1, question = "old"))
        assertEquals("new", state.find("a")?.question)
    }

    @Test
    fun `pending first, then history, each newest first`() {
        repo.applyRequest(request("h1", RequestStatus.ANSWERED, createdAt = t2))
        repo.applyRequest(request("p1", createdAt = t0))
        repo.applyRequest(request("h2", RequestStatus.EXPIRED, createdAt = t1))
        repo.applyRequest(request("p2", createdAt = t1))
        repo.applyRequest(request("n", RequestStatus.NOTIFIED, createdAt = "garbage", kind = RequestKind.NOTIFICATION))
        assertEquals(listOf("p2", "p1", "h1", "h2", "n"), state.requests.map { it.id })
    }

    // ---- refresh ----

    @Test
    fun `refresh keeps notified notices and dismisses cancelled notices`() = runTest {
        val notice = request("notice", RequestStatus.NOTIFIED, kind = RequestKind.NOTIFICATION, updatedAt = t1)
        api.onList = { listOf(notice) }
        repo.refresh()
        assertTrue(notifier.cancelled.isEmpty())

        api.onList = { listOf(notice.copy(status = RequestStatus.CANCELLED, updatedAt = t2)) }
        repo.refresh()
        assertEquals(listOf("notice"), notifier.cancelled)
    }

    @Test
    fun `refresh merges the server list and clears notifications of resolved ones`() = runTest {
        repo.onEvent(RelayEvent.RequestCreated(request("a")))
        api.onList = { listOf(request("a", RequestStatus.EXPIRED, updatedAt = t2), request("b", createdAt = t1)) }
        repo.refresh()
        assertEquals(listOf("b"), state.pending.map { it.id })
        assertEquals(RequestStatus.EXPIRED, state.find("a")?.status)
        assertTrue("a" in notifier.cancelled)
        assertFalse(state.refreshing)
        assertNull(state.refreshError)
    }

    @Test
    fun `refresh server error keeps data and is not treated as unreachable`() = runTest {
        repo.applyRequest(request("a"))
        api.onList = { throw apiError(500, ErrorCode.INTERNAL) }
        repo.refresh()
        assertEquals(RefreshError.SERVER, state.refreshError)
        assertFalse(state.relayUnreachable)
        assertEquals(1, state.requests.size)
        api.onList = { throw RelayException.Protocol("bad body") }
        repo.refresh()
        assertEquals(RefreshError.SERVER, state.refreshError)
    }

    @Test
    fun `refresh 401 signs out`() = runTest {
        repo.applyRequest(request("a"))
        api.onList = { throw apiError(401, ErrorCode.UNAUTHORIZED) }
        repo.refresh()
        assertTrue(state.signedOut)
        assertTrue(state.requests.isEmpty())
        assertEquals(1, signedOutCalls)
        assertEquals(1, notifier.cancelAllCount)
        repo.refresh() // サインアウト後は何もしない
        assertEquals(1, api.listCalls)
    }

    // ---- relay unreachable (圏外) ----

    @Test
    fun `refresh network failure marks the relay unreachable, keeps data, and recovers on the next success`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "下書き")
        api.onList = { throw networkError() }
        repo.refresh()
        assertTrue(state.relayUnreachable)
        assertFalse(state.signedOut)
        assertEquals(RefreshError.NETWORK, state.refreshError)
        assertEquals(listOf("a"), state.pending.map { it.id })
        assertEquals("下書き", state.draft("a").text)
        assertEquals(0, signedOutCalls)

        api.onList = { listOf(request("a")) }
        repo.refresh()
        assertFalse(state.relayUnreachable)
        assertNull(state.refreshError)
        assertEquals("下書き", state.draft("a").text)
    }

    @Test
    fun `websocket state drives unreachable and recovered`() {
        repo.onConnectionState(ConnectionState.CONNECTING)
        assertFalse(state.relayUnreachable)
        repo.onConnectionState(ConnectionState.WAITING_TO_RECONNECT)
        assertTrue(state.relayUnreachable)
        repo.onConnectionState(ConnectionState.CONNECTING) // 再接続を試行中もまだ圏外表示
        assertTrue(state.relayUnreachable)
        repo.onConnectionState(ConnectionState.STOPPED)
        assertTrue(state.relayUnreachable)
        repo.onConnectionState(ConnectionState.CONNECTED)
        assertFalse(state.relayUnreachable)
    }

    @Test
    fun `answer while unreachable keeps the draft and the pending request, then succeeds after recovery`() = runTest {
        repo.applyRequest(request("a"))
        repo.dictateDraft("a", "音声の回答")
        api.onAnswer = { _, _ -> throw RelayException.Network(true, java.net.SocketTimeoutException("timeout")) }
        assertEquals(AnswerOutcome.Failed(AnswerError.NETWORK), repo.submitDraft("a"))
        assertTrue(state.relayUnreachable)
        assertEquals(AnswerError.NETWORK, state.answerErrors["a"])
        assertEquals(Draft("音声の回答", dictated = true), state.draft("a"))
        assertEquals(Draft("音声の回答", dictated = true), drafts.loadAll()["a"])
        assertTrue(state.find("a")!!.isPending)
        assertTrue(state.submitting.isEmpty())
        assertFalse(state.signedOut)
        assertTrue(notifier.cancelled.isEmpty())

        // 接続が戻った: 圏外表示と圏外由来のエラーは消えるが、下書きはそのまま
        repo.onConnectionState(ConnectionState.CONNECTED)
        assertFalse(state.relayUnreachable)
        assertNull(state.answerErrors["a"])
        assertEquals("音声の回答", state.draft("a").text)

        api.onAnswer = FakeApi().onAnswer
        assertTrue(repo.submitDraft("a") is AnswerOutcome.Success)
        assertEquals(InputMethod.VOICE, api.answerCalls.last().second.inputMethod)
        assertEquals(Draft(), state.draft("a"))
        assertTrue(drafts.loadAll().isEmpty())
    }

    @Test
    fun `an api error response proves the relay is reachable again`() = runTest {
        repo.onConnectionState(ConnectionState.WAITING_TO_RECONNECT)
        api.onList = { throw apiError(500, ErrorCode.INTERNAL) }
        repo.refresh()
        assertFalse(state.relayUnreachable)
    }

    @Test
    fun `recovery does not clear non-network answer errors`() = runTest {
        repo.applyRequest(request("a")); repo.applyRequest(request("b"))
        repo.editDraft("a", "x"); repo.editDraft("b", "y")
        api.onAnswer = { _, _ -> throw apiError(500, ErrorCode.INTERNAL) }
        repo.submitDraft("a")
        api.onAnswer = { _, _ -> throw networkError() }
        repo.submitDraft("b")
        repo.onConnectionState(ConnectionState.CONNECTED)
        assertEquals(mapOf("a" to AnswerError.SERVER), state.answerErrors)
    }

    @Test
    fun `drafts saved by a previous process are restored`() {
        val store = InMemoryDraftStore(mapOf("a" to Draft("通知から入力した回答")))
        val restored = RequestsRepository(api, notifier, {}, store)
        assertEquals("通知から入力した回答", restored.state.value.draft("a").text)
    }

    @Test
    fun `a question known only from a push can be read, drafted off-LAN and is replaced by real data later`() = runTest {
        val content = NotificationContent("p1", RequestKind.QUESTION, "claude-code からの質問", "外出中の質問", Urgency.HIGH, listOf("はい", "いいえ"))
        repo.onPushReceived(content)
        repo.onPushReceived(content) // 冪等
        val placeholder = state.pending.single()
        assertEquals("外出中の質問", placeholder.question)
        assertEquals(listOf("はい", "いいえ"), placeholder.choices)
        assertTrue(placeholder.isAnswerable)
        assertTrue(notifier.shown.isEmpty()) // 通知は呼び出し側が出す

        api.onAnswer = { _, _ -> throw networkError() }
        repo.editDraft("p1", "帰ったら送る")
        assertEquals(AnswerOutcome.Failed(AnswerError.NETWORK), repo.submitDraft("p1"))
        assertEquals("帰ったら送る", state.draft("p1").text)

        val real = request("p1", choices = listOf("はい", "いいえ"), question = "外出中の質問 (全文)")
        repo.onEvent(RelayEvent.Hello(listOf(real)))
        assertEquals(listOf(real), state.pending)
        assertEquals("帰ったら送る", state.draft("p1").text)
    }

    @Test
    fun `push for a known or resolved request, or a notification kind, adds nothing`() {
        repo.applyRequest(request("a", RequestStatus.ANSWERED))
        repo.onPushReceived(NotificationContent("a", RequestKind.QUESTION, "t", "b"))
        repo.onPushReceived(NotificationContent("n", RequestKind.NOTIFICATION, "t", "b"))
        assertEquals(RequestStatus.ANSWERED, state.find("a")?.status)
        assertNull(state.find("n"))
        // hello に含まれない仮の質問は解決済みとして消える
        repo.onPushReceived(NotificationContent("gone", RequestKind.QUESTION, "t", "b"))
        repo.onEvent(RelayEvent.Hello(emptyList()))
        assertNull(state.find("gone"))
    }

    // ---- 回答 ----

    @Test
    fun `text answer success resolves the request, clears the draft and dismisses the notification`() = runTest {
        repo.onEvent(RelayEvent.RequestCreated(request("a")))
        repo.editDraft("a", "  了解です \n")
        val outcome = repo.submitDraft("a")
        assertTrue(outcome is AnswerOutcome.Success)
        assertEquals(listOf("a" to AnswerBody("了解です", null, InputMethod.TEXT)), api.answerCalls)
        assertEquals(RequestStatus.ANSWERED, state.find("a")?.status)
        assertEquals("了解です", state.find("a")?.answer?.text)
        assertEquals(Draft(), state.draft("a"))
        assertTrue(state.answerErrors.isEmpty())
        assertTrue(state.submitting.isEmpty())
        assertEquals(listOf("a"), notifier.cancelled)
    }

    @Test
    fun `choice answer sends choice text, index and input_method choice`() = runTest {
        repo.applyRequest(request("a", choices = listOf("はい", "いいえ")))
        repo.editDraft("a", "書きかけ")
        assertTrue(repo.submitChoice("a", 1) is AnswerOutcome.Success)
        assertEquals(listOf("a" to AnswerBody("いいえ", 1, InputMethod.CHOICE)), api.answerCalls)
    }

    @Test
    fun `invalid choice index or unknown request is rejected locally`() = runTest {
        repo.applyRequest(request("a", choices = listOf("はい")))
        assertEquals(AnswerOutcome.Failed(AnswerError.INVALID), repo.submitChoice("a", 5))
        assertEquals(AnswerOutcome.Failed(AnswerError.INVALID), repo.submitChoice("a", -1))
        assertEquals(AnswerOutcome.Failed(AnswerError.INVALID), repo.submitChoice("zzz", 0))
        assertTrue(api.answerCalls.isEmpty())
    }

    @Test
    fun `empty, blank and over-long drafts are rejected locally`() = runTest {
        repo.applyRequest(request("a"))
        assertEquals(AnswerOutcome.Failed(AnswerError.INVALID), repo.submitDraft("a"))
        repo.editDraft("a", "   \n")
        assertEquals(AnswerOutcome.Failed(AnswerError.INVALID), repo.submitDraft("a"))
        repo.editDraft("a", "x".repeat(10_001))
        assertEquals(AnswerOutcome.Failed(AnswerError.INVALID), repo.submitDraft("a"))
        assertTrue(api.answerCalls.isEmpty())
        repo.editDraft("a", "x".repeat(10_000))
        assertTrue(repo.submitDraft("a") is AnswerOutcome.Success)
    }

    @Test
    fun `409 marks the request resolved using the refetched state and sets an error`() = runTest {
        repo.onEvent(RelayEvent.RequestCreated(request("a")))
        repo.editDraft("a", "遅かった")
        api.onAnswer = { _, _ -> throw apiError(409, ErrorCode.ALREADY_RESOLVED) }
        val other = request("a", RequestStatus.ANSWERED, updatedAt = t1, answer = Answer("別端末の回答", null, InputMethod.TEXT, "dev_02", t1))
        api.onGet = { other }
        assertEquals(AnswerOutcome.Failed(AnswerError.ALREADY_RESOLVED), repo.submitDraft("a"))
        assertEquals(other, state.find("a"))
        assertTrue(state.pending.isEmpty())
        assertEquals(AnswerError.ALREADY_RESOLVED, state.answerErrors["a"])
        assertEquals("遅かった", state.draft("a").text)
        assertTrue("a" in notifier.cancelled)
        assertFalse(state.relayUnreachable)
        assertTrue(state.submitting.isEmpty())
    }

    @Test
    fun `409 with a failing refetch still marks the request as resolved`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "x")
        api.onAnswer = { _, _ -> throw apiError(409, ErrorCode.ALREADY_RESOLVED) }
        api.onGet = { throw networkError() }
        assertEquals(AnswerOutcome.Failed(AnswerError.ALREADY_RESOLVED), repo.submitDraft("a"))
        assertFalse(state.find("a")!!.isPending)
        assertFalse(state.find("a")!!.isAnswerable)
        assertEquals(RequestStatus.UNKNOWN, state.find("a")!!.status)
        // 後から本当の状態が届けば置き換わる
        repo.onEvent(RelayEvent.RequestUpdated(request("a", RequestStatus.EXPIRED, updatedAt = t2)))
        assertEquals(RequestStatus.EXPIRED, state.find("a")!!.status)
    }

    @Test
    fun `409 when the refetch still says pending is not trusted`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "x")
        api.onAnswer = { _, _ -> throw apiError(409, ErrorCode.ALREADY_RESOLVED) }
        api.onGet = { request("a") }
        repo.submitDraft("a")
        assertFalse(state.find("a")!!.isPending)
    }

    @Test
    fun `401 on answer signs out`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "x")
        api.onAnswer = { _, _ -> throw apiError(401, ErrorCode.UNAUTHORIZED) }
        assertEquals(AnswerOutcome.SignedOut, repo.submitDraft("a"))
        assertTrue(state.signedOut)
        assertEquals(1, signedOutCalls)
        assertEquals(1, notifier.cancelAllCount)
        assertTrue(drafts.loadAll().isEmpty())
        assertEquals(AnswerOutcome.SignedOut, repo.submitDraft("a"))
        assertEquals(1, api.answerCalls.size)
    }

    @Test
    fun `handleUnauthorized is idempotent`() {
        repo.handleUnauthorized(); repo.handleUnauthorized()
        assertEquals(1, signedOutCalls)
        assertEquals(1, notifier.cancelAllCount)
    }

    @Test
    fun `401 pairing_code_invalid or 403 on answer does not sign out`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "x")
        api.onAnswer = { _, _ -> throw apiError(403, ErrorCode.FORBIDDEN) }
        assertEquals(AnswerOutcome.Failed(AnswerError.SERVER), repo.submitDraft("a"))
        assertFalse(state.signedOut)
        assertEquals("x", state.draft("a").text)
    }

    @Test
    fun `400, 413, 404 and 500 map to distinct errors and keep the draft`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "x")
        for ((error, expected) in listOf(
            apiError(400, ErrorCode.INVALID_REQUEST) to AnswerError.INVALID,
            apiError(413, ErrorCode.PAYLOAD_TOO_LARGE) to AnswerError.INVALID,
            apiError(404, ErrorCode.NOT_FOUND) to AnswerError.NOT_FOUND,
            apiError(500, ErrorCode.INTERNAL) to AnswerError.SERVER,
            RelayException.Protocol("html") to AnswerError.SERVER,
        )) {
            api.onAnswer = { _, _ -> throw error }
            assertEquals(AnswerOutcome.Failed(expected), repo.submitDraft("a"))
            assertEquals(expected, state.answerErrors["a"])
            assertEquals("x", state.draft("a").text)
            assertTrue(state.find("a")!!.isPending)
        }
    }

    @Test
    fun `a second submit while one is in flight is ignored`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "x")
        val gate = CompletableDeferred<Unit>()
        val default = api.onAnswer
        api.onAnswer = { id, body -> gate.await(); default(id, body) }
        val first = async { repo.submitDraft("a") }
        runCurrent()
        assertEquals(setOf("a"), state.submitting)
        assertEquals(AnswerOutcome.Ignored, repo.submitDraft("a"))
        gate.complete(Unit)
        assertTrue(first.await() is AnswerOutcome.Success)
        assertEquals(1, api.answerCalls.size)
        assertTrue(state.submitting.isEmpty())
    }

    @Test
    fun `retrying after a failure clears the previous error`() = runTest {
        repo.applyRequest(request("a"))
        repo.editDraft("a", "x")
        api.onAnswer = { _, _ -> throw networkError() }
        repo.submitDraft("a")
        api.onAnswer = FakeApi().onAnswer
        assertTrue(repo.submitDraft("a") is AnswerOutcome.Success)
        assertTrue(state.answerErrors.isEmpty())
        assertFalse(state.relayUnreachable)
    }

    // ---- 下書きと input_method ----

    @Test
    fun `draft input method - typed is text, dictated is voice even after manual edits, cleared resets`() {
        assertEquals(InputMethod.TEXT, Draft().edited("abc").inputMethod)
        assertEquals(InputMethod.VOICE, Draft().dictated("こんにちは").inputMethod)
        assertEquals(InputMethod.VOICE, Draft().dictated("こんにちは").edited("こんにちは!").inputMethod)
        assertEquals(InputMethod.VOICE, Draft().edited("abc").dictated("abc def").inputMethod)
        assertEquals(Draft(), Draft().dictated("こんにちは").edited(""))
        assertEquals(InputMethod.TEXT, Draft().dictated("こんにちは").edited("").edited("typed").inputMethod)
        assertEquals(Draft(), Draft().dictated(""))
    }

    @Test
    fun `drafts are per request and removed when emptied`() {
        repo.editDraft("a", "1"); repo.dictateDraft("b", "2")
        assertEquals(Draft("1"), state.draft("a"))
        assertEquals(Draft("2", true), state.draft("b"))
        repo.editDraft("a", "")
        assertEquals(setOf("b"), state.drafts.keys)
        assertEquals(setOf("b"), drafts.loadAll().keys)
    }

    @Test
    fun `clearAnswerError removes only that error`() = runTest {
        repo.applyRequest(request("a"))
        repo.submitDraft("a")
        assertEquals(AnswerError.INVALID, state.answerErrors["a"])
        repo.clearAnswerError("a")
        assertTrue(state.answerErrors.isEmpty())
    }
}
