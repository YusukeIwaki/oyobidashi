package me.oyobidashi.android.core

import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

@OptIn(ExperimentalCoroutinesApi::class)
class FcmRecipientTest {
    private val alert = mapOf("request_id" to "r", "body" to "private question", "recipient_device_id" to "dev-current")

    @Test fun `old account recipient is ignored for alerts calls and terminal cancellation pushes`() {
        for (payload in listOf(
            alert,
            alert + mapOf("delivery_mode" to "call", "call_id" to "call-1"),
            alert + mapOf("status" to "answered", "silent" to "true"),
        )) {
            assertNull(FcmPayloadParser.parseForDevice(payload, "dev-other-account"))
        }
    }

    @Test fun `current recipient is accepted before notification call and cancellation handling`() {
        val current = FcmPayloadParser.parseForDevice(alert, "dev-current")!!
        assertEquals("private question", current.body)
        assertEquals("dev-current", current.recipientDeviceId)
        val call = FcmPayloadParser.parseForDevice(alert + mapOf("delivery_mode" to "call", "call_id" to "call-1"), "dev-current")!!
        assertTrue(call.isCall)
        val terminal = FcmPayloadParser.parseForDevice(alert + mapOf("status" to "answered"), "dev-current")!!
        assertTrue(terminal.isTerminalPush)
    }

    @Test fun `legacy LAN push without recipient remains compatible`() {
        val legacy = alert - "recipient_device_id"
        assertEquals(FcmPayloadParser.parse(legacy), FcmPayloadParser.parseForDevice(legacy, "dev-current"))
        assertNotNull(FcmPayloadParser.parseForDevice(legacy, null))
    }

    @Test fun `specified recipient fails closed without a known current device identity`() {
        assertNull(FcmPayloadParser.parseForDevice(alert, null))
        assertNull(FcmPayloadParser.parseForDevice(alert, ""))
        assertNull(FcmPayloadParser.parseForDevice(alert, " "))
    }

    @Test fun `recipient comparison is exact and malformed present values are not legacy`() {
        for (recipient in listOf("", " ", " dev-current", "dev-current ", "DEV-CURRENT", null)) {
            assertNull(FcmPayloadParser.parseForDevice(alert + ("recipient_device_id" to recipient), "dev-current"))
        }
        assertNull(FcmPayloadParser.parseForDevice(alert + ("recipient_device_id" to ""), ""))
    }

    @Test fun `intent serialization preserves recipient so old account notification taps cannot seed new inbox`() {
        val content = FcmPayloadParser.parseForDevice(alert, "dev-current")!!
        val restored = OyobidashiJson.decodeFromString(NotificationContent.serializer(), OyobidashiJson.encodeToString(NotificationContent.serializer(), content))
        assertTrue(restored.isForDevice("dev-current"))
        assertFalse(restored.isForDevice("dev-after-account-switch"))
        assertFalse(restored.isForDevice(null))
        assertFalse(restored.copy(deliveryMode = DeliveryMode.TEXT, callId = null).isForDevice("dev-after-account-switch"))
    }

    @Test fun `notification action for old recipient cannot send an answer in new account`() = runTest {
        val api = FakeApi()
        val notifier = FakeNotifier()
        val handler = DirectReplyHandler(api = { api }, notifier = notifier, currentDeviceId = { "dev-new" })
        val content = FcmPayloadParser.parse(alert)!!
        assertEquals(DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT), handler.handle(content, "private answer", null))
        assertTrue(api.answerCalls.isEmpty())
        assertTrue(notifier.shown.isEmpty())
        assertTrue(notifier.failures.isEmpty())
    }

    @Test fun `account switch while a notification reply is in flight cannot apply old result to new inbox`() = runTest {
        val old = FakeApi()
        var current: RelayApi? = old
        var recipient = "dev-current"
        val finish = CompletableDeferred<Request>()
        old.onAnswer = { _, _ -> finish.await() }
        val notifier = FakeNotifier()
        val answered = mutableListOf<Request>()
        val handler = DirectReplyHandler(api = { current }, notifier = notifier,
            onAnswered = { answered += it }, currentDeviceId = { recipient })
        val waiting = async { handler.handle(FcmPayloadParser.parse(alert)!!, "yes", null) }
        runCurrent()
        current = FakeApi()
        recipient = "dev-new"
        finish.complete(request("r", RequestStatus.ANSWERED))
        assertEquals(DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT), waiting.await())
        assertTrue(answered.isEmpty())
        assertTrue(notifier.cancelled.isEmpty())
        assertTrue(notifier.failures.isEmpty())
    }

    @Test fun `old account errors cannot sign out the new account or save private reply in its drafts`() = runTest {
        for (error in listOf(apiError(401, ErrorCode.UNAUTHORIZED), networkError())) {
            val old = FakeApi()
            var current: RelayApi? = old
            val finish = CompletableDeferred<Unit>()
            old.onAnswer = { _, _ -> finish.await(); throw error }
            val notifier = FakeNotifier()
            var signedOut = false
            val savedDrafts = mutableListOf<String>()
            val handler = DirectReplyHandler(api = { current }, notifier = notifier,
                onUnauthorized = { signedOut = true }, saveDraft = { _, text -> savedDrafts += text },
                currentDeviceId = { "dev-current" })
            val waiting = async { handler.handle(FcmPayloadParser.parse(alert)!!, "private answer", null) }
            runCurrent()
            current = FakeApi()
            finish.complete(Unit)
            assertEquals(DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT), waiting.await())
            assertFalse(signedOut)
            assertTrue(savedDrafts.isEmpty())
            assertTrue(notifier.failures.isEmpty())
        }
    }

    @Test fun `account switch during conflict refetch cannot apply another account request`() = runTest {
        val old = FakeApi()
        var current: RelayApi? = old
        val finish = CompletableDeferred<Request>()
        old.onAnswer = { _, _ -> throw apiError(409, ErrorCode.ALREADY_RESOLVED) }
        old.onGet = { finish.await() }
        val notifier = FakeNotifier()
        val answered = mutableListOf<Request>()
        val handler = DirectReplyHandler(api = { current }, notifier = notifier,
            onAnswered = { answered += it }, currentDeviceId = { "dev-current" })
        val waiting = async { handler.handle(FcmPayloadParser.parse(alert)!!, "yes", null) }
        runCurrent()
        current = FakeApi()
        finish.complete(request("r", RequestStatus.ANSWERED))
        assertEquals(DirectReplyResult.Failed(ReplyFailure.SIGNED_OUT), waiting.await())
        assertTrue(answered.isEmpty())
        assertTrue(notifier.failures.isEmpty())
    }
}
