package me.oyobidashi.android.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class NotificationEnricherTest {
    private val hint = NotificationContent(
        "r", RequestKind.QUESTION, "エージェントからの質問", "新しい質問が届いています。アプリでご確認ください。",
        deliveryMode = DeliveryMode.ACTIONS, recipientDeviceId = "dev-current",
    )

    @Test fun `cloud fallback cannot expose answer buttons before authenticated content arrives`() {
        val fallback = NotificationEnrichmentPolicy.fallback(hint.copy(choices = listOf("untrusted preview choice")))
        assertEquals(hint.requestId, fallback.requestId)
        assertEquals(hint.recipientDeviceId, fallback.recipientDeviceId)
        assertTrue(fallback.choices.isEmpty())
        assertEquals(DeliveryMode.TEXT, fallback.deliveryMode)
        assertEquals(NotificationActions(emptyList(), false), NotificationActions.plan(fallback))
    }

    @Test fun `LAN fallback keeps its existing question and reply actions`() {
        val legacy = hint.copy(recipientDeviceId = null, choices = listOf("yes", "no"))
        assertEquals(legacy, NotificationEnrichmentPolicy.fallback(legacy))
        assertEquals(listOf(0, 1), NotificationActions.plan(NotificationEnrichmentPolicy.fallback(legacy)).choiceIndices)
    }

    @Test fun `authoritative fetch replaces the same notification with full question and choices`() = runTest {
        val api = FakeApi()
        val notifier = FakeNotifier()
        notifier.show(NotificationEnrichmentPolicy.fallback(hint))
        val full = request("r", question = "本番の更新を進めてよいですか？", choices = listOf("はい", "あとで", "いいえ"), deliveryMode = DeliveryMode.ACTIONS)
        api.onGet = { full }
        var stored: Request? = null
        NotificationEnricher(api, notifier, { true }, { "dev-current" }, { stored = it }, { stored }).enrich(hint)
        assertEquals(full, stored)
        assertEquals(listOf("r", "r"), notifier.shown.map { it.requestId })
        val enriched = notifier.shown.last()
        assertEquals(full.question, enriched.body)
        assertEquals(full.choices, enriched.choices)
        assertEquals("dev-current", enriched.recipientDeviceId)
        assertEquals(listOf(0, 1, 2), NotificationActions.plan(enriched).choiceIndices)
        assertTrue(enriched.isForDevice("dev-current"))
        assertFalse(enriched.isForDevice("dev-other"))
        assertTrue(notifier.cancelled.isEmpty())
    }

    @Test fun `timeout is bounded to three seconds and cancels the device HTTP exchange`() = runTest {
        val api = FakeApi()
        val notifier = FakeNotifier()
        val fallback = NotificationEnrichmentPolicy.fallback(hint)
        notifier.show(fallback)
        var cancelled = false
        api.onGet = { try { awaitCancellation() } finally { cancelled = true } }
        NotificationEnricher(api, notifier, { true }, { "dev-current" }, { error("no result") }, { null }).enrich(hint)
        assertEquals(3_000L, testScheduler.currentTime)
        assertTrue(cancelled)
        assertEquals(listOf(fallback), notifier.shown)
        assertTrue(notifier.cancelled.isEmpty())
    }

    @Test fun `network and provider failures retain visible fallback without invented content`() = runTest {
        for (failure in listOf(networkError(), apiError(503, ErrorCode.INTERNAL), RelayException.Protocol("invalid body"))) {
            val api = FakeApi().apply { onGet = { throw failure } }
            val notifier = FakeNotifier()
            val fallback = NotificationEnrichmentPolicy.fallback(hint)
            notifier.show(fallback)
            NotificationEnricher(api, notifier, { true }, { "dev-current" }, { error("failed fetch") }, { null }).enrich(hint)
            assertEquals(listOf(fallback), notifier.shown)
            assertTrue(notifier.cancelled.isEmpty())
        }
    }

    @Test fun `caller cancellation remains cancellation and cannot update notification`() = runTest {
        val api = FakeApi().apply { onGet = { awaitCancellation() } }
        val notifier = FakeNotifier()
        val waiting = async {
            NotificationEnricher(api, notifier, { true }, { "dev-current" }, { error("cancelled") }, { null }).enrich(hint)
        }
        runCurrent()
        waiting.cancelAndJoin()
        assertTrue(waiting.isCancelled)
        assertTrue(notifier.shown.isEmpty())
        assertTrue(notifier.cancelled.isEmpty())
    }

    @Test fun `account switch while fetching discards old content before repository or notification changes`() = runTest {
        val finish = CompletableDeferred<Request>()
        val api = FakeApi().apply { onGet = { finish.await() } }
        var current = true
        val notifier = FakeNotifier()
        val applied = mutableListOf<Request>()
        val waiting = async {
            NotificationEnricher(api, notifier, { current }, { "dev-current" }, { applied += it }, { null }).enrich(hint)
        }
        runCurrent()
        current = false
        finish.complete(request("r", question = "old private question"))
        waiting.await()
        assertTrue(applied.isEmpty())
        assertTrue(notifier.shown.isEmpty())
        assertTrue(notifier.cancelled.isEmpty())
    }

    @Test fun `old recipient is ignored before making a device API request`() = runTest {
        val api = FakeApi()
        val notifier = FakeNotifier()
        NotificationEnricher(api, notifier, { true }, { "dev-new" }, { error("wrong account") }, { null }).enrich(hint)
        assertTrue(api.getCalls.isEmpty())
        assertTrue(notifier.shown.isEmpty())
    }

    @Test fun `recipient change while fetching also prevents full question visibility`() = runTest {
        var device = "dev-current"
        val finish = CompletableDeferred<Request>()
        val api = FakeApi().apply { onGet = { finish.await() } }
        val notifier = FakeNotifier()
        val waiting = async {
            NotificationEnricher(api, notifier, { true }, { device }, { error("recipient changed") }, { null }).enrich(hint)
        }
        runCurrent()
        device = "dev-new"
        finish.complete(request("r", question = "private question"))
        waiting.await()
        assertTrue(notifier.shown.isEmpty())
    }

    @Test fun `terminal authoritative request removes fallback instead of restoring stale buttons`() = runTest {
        for (status in listOf(RequestStatus.ANSWERED, RequestStatus.CANCELLED, RequestStatus.EXPIRED, RequestStatus.UNKNOWN)) {
            val api = FakeApi().apply { onGet = { request("r", status) } }
            val notifier = FakeNotifier()
            NotificationEnricher(api, notifier, { true }, { "dev-current" }, {}, { null }).enrich(hint)
            assertEquals(listOf("r"), notifier.cancelled)
            assertTrue(notifier.shown.isEmpty())
        }
    }

    @Test fun `one-way notification remains visible after authenticated enrichment`() = runTest {
        val full = request("r", RequestStatus.NOTIFIED, kind = RequestKind.NOTIFICATION, question = "更新が完了しました")
        val api = FakeApi().apply { onGet = { full } }
        val notifier = FakeNotifier()
        NotificationEnricher(api, notifier, { true }, { "dev-current" }, {}, { null }).enrich(hint.copy(kind = RequestKind.NOTIFICATION))
        assertEquals("更新が完了しました", notifier.shown.single().body)
        assertEquals(NotificationActions(emptyList(), false), NotificationActions.plan(notifier.shown.single()))
        assertTrue(notifier.cancelled.isEmpty())
    }

    @Test fun `newer WebSocket answer wins over stale pending enrichment result`() = runTest {
        val api = FakeApi()
        val notifier = FakeNotifier()
        val repository = RequestsRepository(api, notifier)
        val old = request("r", question = "stale question")
        repository.applyRequest(old)
        val finish = CompletableDeferred<Request>()
        api.onGet = { finish.await() }
        val waiting = async {
            NotificationEnricher(api, notifier, { true }, { "dev-current" }, repository::applyRequest,
                { repository.state.value.find(it) }).enrich(hint)
        }
        runCurrent()
        repository.applyRequest(request("r", RequestStatus.ANSWERED, updatedAt = "2026-11-15T14:01:00.000Z"))
        finish.complete(old)
        waiting.await()
        assertEquals(RequestStatus.ANSWERED, repository.state.value.find("r")!!.status)
        assertTrue(notifier.shown.isEmpty())
        assertTrue(notifier.cancelled.contains("r"))
    }

    @Test fun `call and terminal pushes bypass ordinary enrichment without delaying their existing handling`() = runTest {
        val api = FakeApi()
        val notifier = FakeNotifier()
        val enricher = NotificationEnricher(api, notifier, { true }, { "dev-current" }, {}, { null })
        enricher.enrich(hint.copy(deliveryMode = DeliveryMode.CALL, callId = "c"))
        enricher.enrich(hint.copy(status = RequestStatus.ANSWERED))
        assertTrue(api.getCalls.isEmpty())
        assertTrue(notifier.shown.isEmpty())
        assertEquals(0L, testScheduler.currentTime)
    }

    @Test fun `ordinary notification reprioritized into a live call is removed from ordinary channel`() = runTest {
        val full = request("r", call = ringingCall(requestId = "r"), deliveryMode = DeliveryMode.CALL)
        val api = FakeApi().apply { onGet = { full } }
        val notifier = FakeNotifier()
        var applied: Request? = null
        NotificationEnricher(api, notifier, { true }, { "dev-current" }, { applied = it }, { applied }).enrich(hint)
        assertEquals(full, applied)
        assertEquals(listOf("r"), notifier.cancelled)
        assertTrue(notifier.shown.isEmpty())
    }

    @Test fun `wrong response request ID cannot enrich or replace a different notification`() = runTest {
        val api = FakeApi().apply { onGet = { request("different", question = "wrong request") } }
        val notifier = FakeNotifier()
        NotificationEnricher(api, notifier, { true }, { "dev-current" }, { error("wrong ID") }, { null }).enrich(hint)
        assertTrue(notifier.shown.isEmpty())
        assertTrue(notifier.cancelled.isEmpty())
    }

    @Test fun `401 only expires the still-current session`() = runTest {
        val api = FakeApi().apply { onGet = { throw apiError(401, ErrorCode.UNAUTHORIZED) } }
        var current = true
        var unauthorized = 0
        val enricher = NotificationEnricher(api, FakeNotifier(), { current }, { "dev-current" }, {}, { null }, { unauthorized++ })
        enricher.enrich(hint)
        assertEquals(1, unauthorized)
        current = false
        enricher.enrich(hint)
        assertEquals(1, unauthorized)
    }

    @Test fun `incoming call reporting wins the shared notification tag during reprioritization`() = runTest {
        val actions = mutableListOf<String>()
        val full = request("r", call = ringingCall(requestId = "r"), deliveryMode = DeliveryMode.CALL)
        val api = FakeApi().apply { onGet = { full } }
        val notifier = object : RequestNotifier {
            override fun show(content: NotificationContent) { actions += "show" }
            override fun cancel(requestId: String) { actions += "cancel-ordinary" }
            override fun showReplyFailure(content: NotificationContent, failure: ReplyFailure) { error("unexpected") }
            override fun cancelAll() { error("unexpected") }
        }
        NotificationEnricher(api, notifier, { true }, { "dev-current" }, {
            actions += "apply-request"
            actions += "report-Telecom-incoming"
        }, { full }).enrich(hint)
        assertEquals(listOf("cancel-ordinary", "apply-request", "report-Telecom-incoming"), actions)
    }

    @Test fun `a newer live call is not removed by a stale ordinary notification HTTP response`() = runTest {
        val api = FakeApi().apply { onGet = { request("r", updatedAt = "2026-11-15T14:00:00.000Z") } }
        val full = request("r", call = ringingCall(requestId = "r"), deliveryMode = DeliveryMode.CALL, updatedAt = "2026-11-15T14:01:00.000Z")
        val notifier = FakeNotifier()
        val repository = RequestsRepository(api, notifier)
        repository.applyRequest(full)
        NotificationEnricher(api, notifier, { true }, { "dev-current" }, repository::applyRequest,
            { repository.state.value.find(it) }).enrich(hint)
        assertTrue(repository.state.value.find("r")!!.isLiveCall)
        assertTrue(notifier.cancelled.isEmpty())
        assertTrue(notifier.shown.isEmpty())
    }
}
