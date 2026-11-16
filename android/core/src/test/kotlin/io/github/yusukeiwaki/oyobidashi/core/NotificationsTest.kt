package io.github.yusukeiwaki.oyobidashi.core

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FcmPayloadParserTest {
    private val full = mapOf(
        "request_id" to "req_1", "kind" to "question", "title" to "claude-code からの質問", "body" to "本文",
        "urgency" to "high", "choices" to """["はい","いいえ"]""",
    )

    @Test
    fun `full payload`() {
        assertEquals(
            NotificationContent("req_1", RequestKind.QUESTION, "claude-code からの質問", "本文", Urgency.HIGH, listOf("はい", "いいえ")),
            FcmPayloadParser.parse(full),
        )
    }

    @Test
    fun `missing, empty or blank request_id yields null`() {
        assertNull(FcmPayloadParser.parse(emptyMap()))
        assertNull(FcmPayloadParser.parse(full - "request_id"))
        assertNull(FcmPayloadParser.parse(full + ("request_id" to "")))
        assertNull(FcmPayloadParser.parse(full + ("request_id" to "  ")))
        assertNull(FcmPayloadParser.parse(full + ("request_id" to null)))
    }

    @Test
    fun `only request_id present falls back to defaults`() {
        assertEquals(
            NotificationContent("req_1", RequestKind.QUESTION, "エージェントからの質問", "", Urgency.NORMAL, emptyList()),
            FcmPayloadParser.parse(mapOf("request_id" to "req_1")),
        )
    }

    @Test
    fun `notification kind`() {
        val c = FcmPayloadParser.parse(mapOf("request_id" to "r", "kind" to "notification", "body" to "完了", "choices" to "[]"))!!
        assertEquals(RequestKind.NOTIFICATION, c.kind)
        assertEquals("エージェントからのお知らせ", c.title)
        assertFalse(c.isQuestion)
        assertEquals(NotificationActions(emptyList(), false), NotificationActions.plan(c))
    }

    @Test
    fun `unknown kind is treated as a one-way notification`() {
        val c = FcmPayloadParser.parse(full + ("kind" to "poll"))!!
        assertEquals(RequestKind.UNKNOWN, c.kind)
        assertFalse(c.isQuestion)
        assertEquals(NotificationActions(emptyList(), false), NotificationActions.plan(c))
    }

    @Test
    fun `unknown or missing urgency is normal`() {
        assertEquals(Urgency.NORMAL, FcmPayloadParser.parse(full + ("urgency" to "critical"))!!.urgency)
        assertEquals(Urgency.NORMAL, FcmPayloadParser.parse(full - "urgency")!!.urgency)
    }

    @Test
    fun `bad choices json becomes an empty list`() {
        for (bad in listOf(null, "", "   ", "[", "not json", "{}", "\"はい\"", "null", "42", """{"0":"はい"}""", "[\"a\"", "]")) {
            assertEquals("choices=$bad", emptyList<String>(), FcmPayloadParser.parse(full + ("choices" to bad))!!.choices)
        }
        assertEquals(emptyList<String>(), FcmPayloadParser.parse(full - "choices")!!.choices)
    }

    @Test
    fun `non-string and empty choice elements are dropped`() {
        assertEquals(listOf("a", "b"), FcmPayloadParser.parseChoices("""["a",1,null,true,["x"],{"k":"v"},"","b"]"""))
    }

    @Test
    fun `blank title falls back to default`() {
        assertEquals("エージェントからの質問", FcmPayloadParser.parse(full + ("title" to " "))!!.title)
    }

    @Test
    fun `content built from a request matches the push wording of the contract`() {
        assertEquals("claude-code からの質問", NotificationContent.fromRequest(Fixtures.request("request_pending.json")).title)
        assertEquals("エージェントからの質問", NotificationContent.fromRequest(Fixtures.request("request_minimal_voice_answered.json")).title)
        assertEquals("codex からのお知らせ", NotificationContent.fromRequest(Fixtures.request("request_notification.json")).title)
        assertEquals("エージェントからのお知らせ", NotificationContent.defaultTitle(RequestKind.NOTIFICATION, " "))
        val long = request("a", question = "あ".repeat(4000))
        assertEquals(1000, NotificationContent.fromRequest(long).body.length)
    }

    @Test
    fun `notification content survives a json round trip for intent extras`() {
        val c = FcmPayloadParser.parse(full)!!
        val json = OyobidashiJson.encodeToString(NotificationContent.serializer(), c)
        assertEquals(c, OyobidashiJson.decodeFromString(NotificationContent.serializer(), json))
    }
}

class NotificationActionsTest {
    private fun content(n: Int) = NotificationContent("r", RequestKind.QUESTION, "t", "b", choices = List(n) { "c$it" })

    @Test
    fun `never more than three actions`() {
        assertEquals(NotificationActions(emptyList(), true), NotificationActions.plan(content(0)))
        assertEquals(NotificationActions(listOf(0), true), NotificationActions.plan(content(1)))
        assertEquals(NotificationActions(listOf(0, 1), true), NotificationActions.plan(content(2)))
        assertEquals(NotificationActions(listOf(0, 1, 2), false), NotificationActions.plan(content(3)))
        assertEquals(NotificationActions(emptyList(), true), NotificationActions.plan(content(4)))
        assertEquals(NotificationActions(emptyList(), true), NotificationActions.plan(content(8)))
        for (n in 0..8) {
            val plan = NotificationActions.plan(content(n))
            assertTrue(plan.choiceIndices.size + (if (plan.directReply) 1 else 0) <= 3)
        }
    }
}

class DirectReplyHandlerTest {
    private val api = FakeApi()
    private val notifier = FakeNotifier()
    private val answered = mutableListOf<Request>()
    private val savedDrafts = mutableListOf<Pair<String, String>>()
    private var unauthorized = 0
    private var paired = true
    private val handler = DirectReplyHandler(
        api = { if (paired) api else null }, notifier = notifier,
        onAnswered = { answered += it }, onUnauthorized = { unauthorized++ },
        saveDraft = { id, text -> savedDrafts += id to text },
    )
    private val content = NotificationContent("req_1", RequestKind.QUESTION, "t", "b", choices = listOf("はい", "いいえ"))

    @Test
    fun `text reply success posts the answer and cancels the notification`() = runTest {
        val result = handler.handle(content, "  了解 ", null)
        assertTrue(result is DirectReplyResult.Success)
        assertEquals(listOf("req_1" to AnswerBody("了解", null, InputMethod.TEXT)), api.answerCalls)
        assertEquals(listOf("req_1"), notifier.cancelled)
        assertTrue(notifier.failures.isEmpty())
        assertEquals(RequestStatus.ANSWERED, answered.single().status)
        assertTrue(savedDrafts.isEmpty())
    }

    @Test
    fun `choice action success sends choice text and index`() = runTest {
        assertTrue(handler.handle(content, null, 1) is DirectReplyResult.Success)
        assertEquals(listOf("req_1" to AnswerBody("いいえ", 1, InputMethod.CHOICE)), api.answerCalls)
        assertEquals(listOf("req_1"), notifier.cancelled)
    }

    @Test
    fun `409 updates the notification as already resolved and syncs the latest state`() = runTest {
        api.onAnswer = { _, _ -> throw apiError(409, ErrorCode.ALREADY_RESOLVED) }
        api.onGet = { request("req_1", RequestStatus.CANCELLED) }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.ALREADY_RESOLVED), handler.handle(content, "x", null))
        assertEquals(listOf(content to ReplyFailure.ALREADY_RESOLVED), notifier.failures)
        assertEquals(RequestStatus.CANCELLED, answered.single().status)
        assertTrue(savedDrafts.isEmpty())
    }

    @Test
    fun `409 with failing refetch still updates the notification`() = runTest {
        api.onAnswer = { _, _ -> throw apiError(409, ErrorCode.ALREADY_RESOLVED) }
        api.onGet = { throw networkError() }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.ALREADY_RESOLVED), handler.handle(content, "x", null))
        assertEquals(1, notifier.failures.size)
        assertTrue(answered.isEmpty())
    }

    @Test
    fun `off-LAN network failure shows an unsent error and keeps the typed text as a draft`() = runTest {
        api.onAnswer = { _, _ -> throw networkError() }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.UNREACHABLE), handler.handle(content, " 外出先からの回答 ", null))
        assertEquals(listOf(content to ReplyFailure.UNREACHABLE), notifier.failures)
        assertTrue("notification must stay so the user can retry", notifier.cancelled.isEmpty())
        assertEquals(listOf("req_1" to "外出先からの回答"), savedDrafts)
        assertEquals(0, unauthorized)
    }

    @Test
    fun `timeout is unreachable too`() = runTest {
        api.onAnswer = { _, _ -> throw RelayException.Network(true, java.net.SocketTimeoutException()) }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.UNREACHABLE), handler.handle(content, "x", null))
        assertEquals(listOf("req_1" to "x"), savedDrafts)
    }

    @Test
    fun `direct-reply failure draft lands in the repository and survives a new process`() = runTest {
        val store = InMemoryDraftStore()
        val repo = RequestsRepository(api, notifier, {}, store)
        repo.applyRequest(request("req_1"))
        val h = DirectReplyHandler({ api }, notifier, saveDraft = { id, text -> repo.editDraft(id, text) })
        api.onAnswer = { _, _ -> throw networkError() }
        h.handle(content, "あとで送る", null)
        assertEquals(Draft("あとで送る"), repo.state.value.draft("req_1"))
        assertTrue(repo.state.value.find("req_1")!!.isPending)
        assertEquals("あとで送る", RequestsRepository(api, notifier, {}, store).state.value.draft("req_1").text)
        // LAN に戻って送信
        api.onAnswer = FakeApi().onAnswer
        assertTrue(repo.submitDraft("req_1") is AnswerOutcome.Success)
        assertEquals("あとで送る", api.answerCalls.last().second.text)
        assertTrue(store.loadAll().isEmpty())
    }

    @Test
    fun `choice action failure is retryable but has no text to save`() = runTest {
        api.onAnswer = { _, _ -> throw networkError() }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.UNREACHABLE), handler.handle(content, null, 0))
        assertTrue(savedDrafts.isEmpty())
    }

    @Test
    fun `500 and broken responses are retryable and keep the draft`() = runTest {
        api.onAnswer = { _, _ -> throw apiError(500, ErrorCode.INTERNAL) }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.RETRYABLE), handler.handle(content, "x", null))
        api.onAnswer = { _, _ -> throw RelayException.Protocol("html") }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.RETRYABLE), handler.handle(content, "y", null))
        assertEquals(listOf("req_1" to "x", "req_1" to "y"), savedDrafts)
    }

    @Test
    fun `401 signs out and tells the user`() = runTest {
        api.onAnswer = { _, _ -> throw apiError(401, ErrorCode.UNAUTHORIZED) }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT), handler.handle(content, "x", null))
        assertEquals(1, unauthorized)
        assertEquals(listOf(content to ReplyFailure.SIGNED_OUT), notifier.failures)
    }

    @Test
    fun `not paired`() = runTest {
        paired = false
        assertEquals(DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT), handler.handle(content, "x", null))
        assertTrue(api.answerCalls.isEmpty())
    }

    @Test
    fun `empty, blank, missing or over-long reply and bad choice index are rejected without a request`() = runTest {
        for (text in listOf(null, "", "  \n", "x".repeat(10_001))) {
            assertEquals(DirectReplyResult.Failed(ReplyFailure.INVALID_INPUT), handler.handle(content, text, null))
        }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.INVALID_INPUT), handler.handle(content, null, 2))
        assertEquals(DirectReplyResult.Failed(ReplyFailure.INVALID_INPUT), handler.handle(content, null, -1))
        assertTrue(api.answerCalls.isEmpty())
        assertEquals(6, notifier.failures.size)
    }

    @Test
    fun `404 and 400 from the relay`() = runTest {
        api.onAnswer = { _, _ -> throw apiError(404, ErrorCode.NOT_FOUND) }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.ALREADY_RESOLVED), handler.handle(content, "x", null))
        api.onAnswer = { _, _ -> throw apiError(400, ErrorCode.INVALID_REQUEST) }
        assertEquals(DirectReplyResult.Failed(ReplyFailure.INVALID_INPUT), handler.handle(content, "x", null))
    }
}
