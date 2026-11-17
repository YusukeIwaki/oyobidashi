package me.oyobidashi.android.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceTurnRunnerTest {
    private val turnId = "123e4567-e89b-12d3-a456-426614174000"
    private val otherId = "123e4567-e89b-12d3-a456-426614174001"
    private val body = CallEventBody(CallEvent.TURN, "明日お願いします")

    private fun TestScope.options(timeout: Long = 95_000) = VoiceTurnOptions(
        timeoutMs = timeout, nowMs = { testScheduler.currentTime }, newId = { turnId },
    )

    private fun exchange(
        state: String = "queued", resolved: Boolean = false, status: Int = 200,
        id: String = turnId, requestId: String = "r", reply: String? = if (state == "completed") "承知しました" else null,
    ): CallExchange {
        val turn = CallTurn(id, state, reply, resolved)
        val call = ringingCall(requestId = requestId).copy(
            state = if (resolved) CallState.ENDED else CallState.ACTIVE,
            outcome = if (resolved) CallOutcome.RESOLVED else null,
            deviceId = "d", turn = turn,
        )
        return CallExchange(status, CallResponse(
            request(requestId, status = if (resolved) RequestStatus.ANSWERED else RequestStatus.PENDING, call = call),
            call, turn = turn,
        ))
    }

    private suspend inline fun <reified E : Throwable> expectFailure(block: suspend () -> Unit): E {
        try { block() } catch (error: Throwable) {
            if (error is E) return error
            throw AssertionError("expected ${E::class.simpleName}, got $error", error)
        }
        throw AssertionError("expected ${E::class.simpleName}")
    }

    @Test fun `queued running completed polls with bounded backoff and returns final reply`() = runTest {
        val posts = mutableListOf<CallEventBody>()
        val gets = mutableListOf<Long>()
        val replies = ArrayDeque(listOf(exchange("running"), exchange("completed", resolved = true)))
        val response = VoiceTurnRunner(options()).submit("r", body,
            post = { posts += it; exchange(status = 202) },
            get = { assertEquals(turnId, it); gets += testScheduler.currentTime; replies.removeFirst() },
            supportsIdempotency = { error("successful POST needs no capability request") },
        )
        assertEquals(listOf(250L, 750L), gets)
        assertEquals(1, posts.size)
        assertEquals(turnId, posts.single().turnId)
        assertEquals(true, posts.single().async)
        assertEquals("明日お願いします", posts.single().text)
        assertEquals("承知しました", response.reply)
        assertTrue(response.isResolved)
    }

    @Test fun `legacy synchronous result completes without polling`() = runTest {
        val legacy = CallResponse(request("r"), reply = "もう少し詳しく教えてください", resolved = false)
        val actual = VoiceTurnRunner(options()).submit("r", body,
            post = { CallExchange(200, legacy) }, get = { error("LAN response must not poll") },
            supportsIdempotency = { error("no discovery needed") },
        )
        assertEquals(legacy, actual)
        assertEquals(0L, testScheduler.currentTime)
    }

    @Test fun `lost POST after commit recovers result without repeating utterance`() = runTest {
        var posts = 0
        var gets = 0
        val response = VoiceTurnRunner(options()).submit("r", body,
            post = { posts++; throw networkError() },
            get = { gets++; exchange("completed", resolved = true) },
            supportsIdempotency = { error("result already exists") },
        )
        assertTrue(response.isResolved)
        assertEquals(1, posts)
        assertEquals(1, gets)
    }

    @Test fun `lost POST before commit retries same ID only after capability discovery`() = runTest {
        val ids = mutableListOf<String?>()
        var capabilities = 0
        val response = VoiceTurnRunner(options()).submit("r", body,
            post = {
                ids += it.turnId
                if (ids.size == 1) throw networkError()
                exchange("completed")
            },
            get = { throw apiError(404, ErrorCode.NOT_FOUND) },
            supportsIdempotency = { capabilities++; true },
        )
        assertEquals(listOf(turnId, turnId), ids)
        assertEquals(1, capabilities)
        assertEquals("承知しました", response.reply)
    }

    @Test fun `lost legacy response never blindly repeats non-idempotent POST`() = runTest {
        var posts = 0
        expectFailure<RelayException.Network> {
            VoiceTurnRunner(options()).submit("r", body,
                post = { posts++; throw networkError() },
                get = { throw apiError(404, ErrorCode.NOT_FOUND) }, supportsIdempotency = { false },
            )
        }
        assertEquals(1, posts)
    }

    @Test fun `unreachable result endpoint retries reads but cannot repeat POST`() = runTest {
        var posts = 0
        var reads = 0
        expectFailure<RelayException.Network> {
            VoiceTurnRunner(options()).submit("r", body,
                post = { posts++; throw networkError() },
                get = { reads++; throw networkError() }, supportsIdempotency = { error("no 404 evidence") },
            )
        }
        assertEquals(1, posts)
        assertEquals(3, reads)
        assertEquals(750L, testScheduler.currentTime)
    }

    @Test fun `POST attempts are bounded when requests never commit`() = runTest {
        val ids = mutableListOf<String?>()
        expectFailure<RelayException.Network> {
            VoiceTurnRunner(options()).submit("r", body,
                post = { ids += it.turnId; throw networkError() },
                get = { throw apiError(404, ErrorCode.NOT_FOUND) }, supportsIdempotency = { true },
            )
        }
        assertEquals(listOf(turnId, turnId, turnId), ids)
    }

    @Test fun `polling tolerates a network outage and 503 without another POST`() = runTest {
        var posts = 0
        var reads = 0
        val response = VoiceTurnRunner(options()).submit("r", body,
            post = { posts++; exchange(status = 202) },
            get = {
                reads++
                when (reads) {
                    1 -> throw networkError()
                    2 -> throw apiError(503, ErrorCode.INTERNAL)
                    else -> exchange("completed")
                }
            }, supportsIdempotency = { error("accepted turns never resubmit") },
        )
        assertEquals(1, posts)
        assertEquals(3, reads)
        assertEquals("承知しました", response.reply)
    }

    @Test fun `401 during polling is surfaced immediately for unpair handling`() = runTest {
        var reads = 0
        val error = expectFailure<RelayException.Api> {
            VoiceTurnRunner(options()).submit("r", body,
                post = { exchange(status = 202) },
                get = { reads++; throw apiError(401, ErrorCode.UNAUTHORIZED) }, supportsIdempotency = { true },
            )
        }
        assertTrue(error.isUnauthorized)
        assertEquals(1, reads)
    }

    @Test fun `429 and a rejected POST are not retried`() = runTest {
        for (status in listOf(400, 401, 403, 409, 429)) {
            var posts = 0
            expectFailure<RelayException.Api> {
                VoiceTurnRunner(options()).submit("r", body,
                    post = { posts++; throw apiError(status, ErrorCode.fromHttpStatus(status)) },
                    get = { error("known rejection does not poll") }, supportsIdempotency = { true },
                )
            }
            assertEquals(1, posts)
        }
    }

    @Test fun `failed and cancelled turns never return an answer`() = runTest {
        for (state in listOf("failed", "cancelled")) {
            val failure = expectFailure<RelayException.VoiceTurn> {
                VoiceTurnRunner(options()).submit("r", body,
                    post = { exchange(state, status = 202) }, get = { error("terminal state") },
                    supportsIdempotency = { true },
                )
            }
            assertEquals(state, failure.state)
            assertEquals(turnId, failure.turnId)
        }
    }

    @Test fun `unknown missing or mismatched turn fails closed`() = runTest {
        val malformed = listOf(
            exchange("future_state", status = 202),
            exchange(status = 202, id = otherId),
            exchange(status = 202, requestId = "other"),
            CallExchange(202, CallResponse(request("r"))),
            exchange("completed", reply = ""),
            exchange().let { it.copy(body = it.body.copy(turn = it.body.turn!!.copy(resolved = null), call = null)) },
            exchange().let { it.copy(body = it.body.copy(turn = it.body.turn!!.copy(reply = "too early"), call = null)) },
            exchange("completed", resolved = true).let { it.copy(body = it.body.copy(request = request("r"))) },
        )
        for (response in malformed) expectFailure<RelayException.Protocol> {
            VoiceTurnRunner(options()).submit("r", body,
                post = { response }, get = { error("malformed result must not poll") }, supportsIdempotency = { true },
            )
        }
    }

    @Test fun `successful GET recovery without a turn cannot masquerade as LAN response`() = runTest {
        expectFailure<RelayException.Protocol> {
            VoiceTurnRunner(options()).submit("r", body,
                post = { throw networkError() }, get = { CallExchange(200, CallResponse(request("r"))) },
                supportsIdempotency = { true },
            )
        }
    }

    @Test fun `caller cancellation during backoff stops all polling without cancelling remote job`() = runTest {
        var gets = 0
        val operation = launch {
            VoiceTurnRunner(options()).submit("r", body,
                post = { exchange(status = 202) }, get = { gets++; exchange("running") },
                supportsIdempotency = { true },
            )
        }
        runCurrent()
        operation.cancelAndJoin()
        advanceTimeBy(100_000)
        assertEquals(0, gets)
        assertTrue(operation.isCancelled)
    }

    @Test fun `caller cancellation interrupts an in-flight HTTP exchange`() = runTest {
        val cancelled = CompletableDeferred<Unit>()
        val operation = launch {
            VoiceTurnRunner(options()).submit("r", body,
                post = { try { awaitCancellation() } finally { cancelled.complete(Unit) } },
                get = { error("cancelled submit must not recover") }, supportsIdempotency = { true },
            )
        }
        runCurrent()
        operation.cancelAndJoin()
        assertTrue(cancelled.isCompleted)
    }

    @Test fun `overall deadline bounds silence from worker and maximum polling rate`() = runTest {
        val times = mutableListOf<Long>()
        val error = expectFailure<RelayException.Network> {
            VoiceTurnRunner(options(timeout = 10_000)).submit("r", body,
                post = { exchange(status = 202) },
                get = { times += testScheduler.currentTime; exchange("running") }, supportsIdempotency = { true },
            )
        }
        assertTrue(error.isTimeout)
        assertEquals(10_000L, testScheduler.currentTime)
        assertEquals(listOf(250L, 750L, 1750L, 3750L, 5750L, 7750L, 9750L), times)
    }

    @Test fun `overall deadline interrupts a hung HTTP operation`() = runTest {
        val error = expectFailure<RelayException.Network> {
            VoiceTurnRunner(options(timeout = 1_000)).submit("r", body,
                post = { awaitCancellation() }, get = { error("unreachable") }, supportsIdempotency = { true },
            )
        }
        assertTrue(error.isTimeout)
        assertEquals(1_000L, testScheduler.currentTime)
    }

    @Test fun `outer deadline remains coroutine cancellation`() = runTest {
        expectFailure<CancellationException> {
            withTimeout(100) {
                VoiceTurnRunner(options()).submit("r", body,
                    post = { awaitCancellation() }, get = { error("unreachable") }, supportsIdempotency = { true },
                )
            }
        }
    }

    @Test fun `reconnection resumes durable turn without POST`() = runTest {
        var reads = 0
        val response = VoiceTurnRunner(options()).resume("r", turnId) {
            reads++
            if (reads == 1) exchange("running") else exchange("completed", resolved = true)
        }
        assertTrue(response.isResolved)
        assertEquals(2, reads)
        assertEquals(250L, testScheduler.currentTime)
    }

    @Test fun `explicit retry preserves supplied UUID and rejects invalid IDs before network`() = runTest {
        VoiceTurnRunner(options()).submit("r", body.copy(turnId = otherId),
            post = { assertEquals(otherId, it.turnId); exchange("completed", id = otherId) },
            get = { error("complete") }, supportsIdempotency = { true },
        )
        expectFailure<RelayException.Protocol> {
            VoiceTurnRunner(options()).submit("r", body.copy(turnId = "bad/id"),
                post = { error("invalid ID") }, get = { error("invalid ID") }, supportsIdempotency = { true },
            )
        }
    }

    @Test fun `hangup after a completed unresolved turn cannot restart speech or recognition`() = runTest {
        val finishedCall = exchange("completed").let {
            val call = it.body.call!!.copy(state = CallState.ENDED, outcome = CallOutcome.HANGUP)
            it.copy(body = it.body.copy(call = call, request = it.body.request.copy(call = call)))
        }
        val error = expectFailure<RelayException.VoiceTurn> {
            VoiceTurnRunner(options()).resume("r", turnId) { finishedCall }
        }
        assertEquals("cancelled", error.state)
    }

    @Test fun `explicit recovery probes existing turn before any POST`() = runTest {
        var reads = 0
        val response = VoiceTurnRunner(options()).submit("r", body.copy(turnId = turnId, resumeTurn = true),
            post = { error("previous uncertain POST must not be repeated") },
            get = { reads++; exchange("completed", true) }, supportsIdempotency = { error("known result") },
        )
        assertTrue(response.isResolved)
        assertEquals(1, reads)
    }

    @Test fun `persisted but uncommitted cloud turn can safely submit after recovery probe`() = runTest {
        val operations = mutableListOf<String>()
        val response = VoiceTurnRunner(options()).submit("r", body.copy(turnId = turnId, resumeTurn = true),
            post = { operations += "post"; assertEquals(turnId, it.turnId); exchange("completed") },
            get = { operations += "get"; throw apiError(404, ErrorCode.NOT_FOUND) },
            supportsIdempotency = { operations += "capabilities"; true },
        )
        assertEquals(listOf("get", "capabilities", "post"), operations)
        assertEquals("承知しました", response.reply)
    }

    @Test fun `persisted unknown legacy turn cannot be implicitly replayed by explicit recovery`() = runTest {
        val failure = expectFailure<RelayException.VoiceTurn> {
            VoiceTurnRunner(options()).submit("r", body.copy(turnId = turnId, resumeTurn = true),
                post = { error("uncertain legacy call must not replay") },
                get = { throw apiError(404, ErrorCode.NOT_FOUND) }, supportsIdempotency = { false },
            )
        }
        assertEquals("uncertain", failure.state)
    }

    @Test fun `known provider failure is definitive and does not probe or retry POST`() = runTest {
        for (code in listOf("conversation_failed", "voice_unavailable")) {
            val failure = expectFailure<RelayException.Api> {
                VoiceTurnRunner(options()).submit("r", body,
                    post = { throw RelayException.Api(503, ErrorCode.INTERNAL, code, null) },
                    get = { error("definitive failure") }, supportsIdempotency = { true },
                )
            }
            assertEquals(code, failure.rawCode)
        }
    }
}
