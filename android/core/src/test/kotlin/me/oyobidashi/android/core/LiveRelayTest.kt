package me.oyobidashi.android.core

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * 本物の relay に対する結合テスト。`integration/` のハーネスが環境変数を渡して起動する。
 * 環境変数が無ければスキップされる (通常の `./gradlew test` では実行されない)。
 *
 * - OYOBIDASHI_LIVE_PAIRING_URI: `relay pair` が出力した oyobidashi://pair?...
 * - OYOBIDASHI_LIVE_REQUEST_ID: ハーネスが作成済みの pending な質問の id
 */
class LiveRelayTest {
    @Test
    fun pairListReceiveAnswerAndUnpair() = runBlocking {
        val uri = System.getenv("OYOBIDASHI_LIVE_PAIRING_URI")
        val requestId = System.getenv("OYOBIDASHI_LIVE_REQUEST_ID")
        assumeTrue("live relay env not set", !uri.isNullOrEmpty() && !requestId.isNullOrEmpty())

        val info = (PairingUri.parse(uri!!) as PairingParseResult.Success).info
        val http = OkHttpClient()

        // ペアリング
        val paired = RelayClient(http, info.url).pair(
            PairRequest(code = info.code, deviceName = "live-android", platform = "android")
        )
        assertTrue(paired.deviceToken.isNotEmpty())
        val client = RelayClient(http, info.url, paired.deviceToken)

        // 使用済みコードは pairing_code_invalid
        try {
            RelayClient(http, info.url).pair(PairRequest(info.code, "again", "android"))
            fail("reused code must fail")
        } catch (e: RelayException.Api) {
            assertEquals(ErrorCode.PAIRING_CODE_INVALID, e.code)
        }

        // 一覧に pending の質問がある
        val pending = client.listRequests(RequestStatus.PENDING)
        val target = pending.firstOrNull { it.id == requestId }
        assertNotNull("pending list must contain $requestId", target)
        assertEquals(RequestStatus.PENDING, target!!.status)
        assertEquals(RequestKind.QUESTION, target.kind)
        System.getenv("OYOBIDASHI_LIVE_SUBJECT")?.let { assertEquals(it, target.subject) }

        // WebSocket: hello に同じ質問が入っている
        val events = LinkedBlockingQueue<RelayEvent>()
        val socket = OkHttpEventSocketConnector(http, info.url, paired.deviceToken).connect(object : EventSocketListener {
            override fun onOpen() {}
            override fun onText(text: String) { RelayEvent.parse(text)?.let { events.add(it) } }
            override fun onClosed(httpStatus: Int?, cause: Throwable?) {}
        })
        val hello = events.poll(5, TimeUnit.SECONDS)
        assertTrue("first event must be hello but was $hello", hello is RelayEvent.Hello)
        assertTrue((hello as RelayEvent.Hello).pending.any { it.id == requestId })
        System.getenv("OYOBIDASHI_LIVE_SUBJECT")?.let { subject ->
            assertEquals(subject, hello.pending.first { it.id == requestId }.subject)
        }

        // 音声で回答 → answered、WebSocket に request.updated
        val answered = client.answer(requestId!!, AnswerBody(text = "Androidから回答", inputMethod = InputMethod.VOICE))
        assertEquals(RequestStatus.ANSWERED, answered.status)
        assertEquals("Androidから回答", answered.answer?.text)
        assertEquals(InputMethod.VOICE, answered.answer?.inputMethod)
        var updated: RelayEvent.RequestUpdated? = null
        while (updated == null) {
            val ev = events.poll(5, TimeUnit.SECONDS) ?: break
            if (ev is RelayEvent.RequestUpdated && ev.request.id == requestId) updated = ev
        }
        assertNotNull("request.updated must arrive", updated)
        assertEquals(RequestStatus.ANSWERED, updated!!.request.status)
        System.getenv("OYOBIDASHI_LIVE_SUBJECT")?.let { assertEquals(it, updated.request.subject) }

        // ping → pong
        assertTrue(socket.send(RelayEvent.PING_FRAME))
        var pong = false
        while (!pong) {
            val ev = events.poll(5, TimeUnit.SECONDS) ?: break
            if (ev is RelayEvent.Pong) pong = true
        }
        assertTrue("pong must arrive", pong)

        // 二重回答は already_resolved
        try {
            client.answer(requestId, AnswerBody(text = "もう一度", inputMethod = InputMethod.TEXT))
            fail("second answer must fail")
        } catch (e: RelayException.Api) {
            assertTrue(e.isAlreadyResolved)
        }
        assertEquals(RequestStatus.ANSWERED, client.getRequest(requestId).status)

        // 存在しない id は not_found
        try {
            client.getRequest("req_does_not_exist")
            fail("must be not found")
        } catch (e: RelayException.Api) {
            assertEquals(ErrorCode.NOT_FOUND, e.code)
        }

        // ペアリング解除後は unauthorized
        socket.cancel()
        client.deleteDevice()
        try {
            client.listRequests()
            fail("must be unauthorized after unpair")
        } catch (e: RelayException.Api) {
            assertTrue(e.isUnauthorized)
        }
    }
}
