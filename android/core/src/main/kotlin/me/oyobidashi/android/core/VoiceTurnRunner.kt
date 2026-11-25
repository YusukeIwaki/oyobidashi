package me.oyobidashi.android.core

import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeout
import java.net.SocketTimeoutException
import java.util.UUID

/** 通話全体ではなく、発話の送信と結果待ちだけを非同期に行う。 */
data class VoiceTurnOptions(
    val timeoutMs: Long = 95_000,
    val firstPollMs: Long = 250,
    val maxPollMs: Long = 2_000,
    val maxAttempts: Int = 3,
    val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
    val sleep: suspend (Long) -> Unit = { delay(it) },
    val newId: () -> String = { UUID.randomUUID().toString() },
) {
    init {
        require(timeoutMs > 0 && firstPollMs > 0 && maxPollMs >= firstPollMs && maxAttempts in 1..10)
    }
}

internal data class CallExchange(val status: Int, val body: CallResponse)

/**
 * 待機中はコルーチンを suspend する。HTTP 切断はジョブのキャンセルではない。
 * POST の応答を失ったらまず確定済み結果を読む。未対応の LAN relay に同じ発話を
 * 自動再送しないよう、404 の場合は idempotency capability を確認する。
 */
internal class VoiceTurnRunner(private val options: VoiceTurnOptions) {
    suspend fun submit(
        requestId: String,
        body: CallEventBody,
        post: suspend (CallEventBody) -> CallExchange,
        get: suspend (String) -> CallExchange,
        supportsIdempotency: suspend () -> Boolean,
    ): CallResponse = bounded {
        val turnId = body.turnId ?: options.newId()
        requireTurnId(turnId)
        val outgoing = body.copy(turnId = turnId, async = true)
        val start = options.nowMs()
        var posts = 0
        var recovered: CallExchange? = null
        var legacyResponseAllowed = false
        if (body.resumeTurn) {
            var attempts = 0
            while (true) {
                checkDeadline(start)
                try {
                    recovered = get(turnId)
                    break
                } catch (failure: RelayException) {
                    if (failure is RelayException.Api && failure.httpStatus == 404) {
                        if (!supportsIdempotency()) throw RelayException.VoiceTurn(turnId, "uncertain", "delivery_unknown")
                        break
                    }
                    if (!failure.transient || ++attempts >= options.maxAttempts) throw failure
                    pause(start, backoff(attempts))
                }
            }
        }
        while (recovered == null) {
            checkDeadline(start)
            try {
                posts++
                recovered = post(outgoing)
                legacyResponseAllowed = true
            } catch (failure: RelayException) {
                if (!failure.transient) throw failure
                var readAttempts = 0
                while (true) {
                    checkDeadline(start)
                    try {
                        recovered = get(turnId)
                        break
                    } catch (readFailure: RelayException) {
                        if (readFailure is RelayException.Api && readFailure.httpStatus == 404) {
                            if (posts >= options.maxAttempts || !supportsIdempotency()) throw failure
                            pause(start, backoff(posts))
                            break
                        }
                        // An unreachable result endpoint provides no evidence that POST was not committed.
                        if (!readFailure.transient || ++readAttempts >= options.maxAttempts) throw readFailure
                        pause(start, backoff(readAttempts))
                    }
                }
            }
        }
        awaitResult(requestId, turnId, recovered, start, allowLegacy = legacyResponseAllowed, get = get)
    }

    suspend fun resume(
        requestId: String,
        turnId: String,
        get: suspend (String) -> CallExchange,
    ): CallResponse = bounded {
        requireTurnId(turnId)
        awaitResult(requestId, turnId, null, options.nowMs(), allowLegacy = false, get = get)
    }

    private suspend fun awaitResult(
        requestId: String,
        turnId: String,
        initial: CallExchange?,
        start: Long,
        allowLegacy: Boolean,
        get: suspend (String) -> CallExchange,
    ): CallResponse {
        var exchange = initial
        var pollDelay = options.firstPollMs
        var failures = 0
        while (true) {
            checkDeadline(start)
            if (exchange != null) {
                val response = exchange.body
                if (exchange.status != 200 && exchange.status != 202) {
                    throw RelayException.Protocol("unexpected asynchronous voice status")
                }
                if (response.request.id != requestId) throw RelayException.Protocol("mismatched voice request")
                val turn = response.turn ?: response.call?.turn
                if (turn == null) {
                    if (allowLegacy && exchange === initial && exchange.status == 200) return response
                    throw RelayException.Protocol("missing asynchronous voice turn")
                }
                if (response.request.id != requestId || turn.id != turnId ||
                    response.turn != null && response.call?.turn != null && response.turn != response.call.turn
                ) throw RelayException.Protocol("mismatched asynchronous voice turn")
                if (turn.resolved == null) throw RelayException.Protocol("missing voice turn resolution")
                when (turn.state) {
                    "queued", "running" -> {
                        if (turn.resolved || turn.reply != null || turn.error != null) {
                            throw RelayException.Protocol("invalid pending voice turn")
                        }
                        if (response.request.status != RequestStatus.PENDING || response.call?.isEnded == true || response.request.call?.isEnded == true) {
                            throw RelayException.VoiceTurn(turnId, "cancelled", "call_ended")
                        }
                    }
                    "completed" -> {
                        if (turn.reply.isNullOrBlank() || turn.error != null) {
                            throw RelayException.Protocol("invalid completed voice turn")
                        }
                        if (turn.resolved && response.request.status != RequestStatus.ANSWERED ||
                            !turn.resolved && response.request.status != RequestStatus.PENDING
                        ) throw RelayException.Protocol("voice turn and request disagree")
                        if (!turn.resolved && (response.call?.isEnded == true || response.request.call?.isEnded == true)) {
                            throw RelayException.VoiceTurn(turnId, "cancelled", "call_ended")
                        }
                        return response.copy(reply = turn.reply, resolved = turn.resolved, turn = turn, endCall = turn.endCall)
                    }
                    "failed", "cancelled" -> {
                        if (turn.resolved) throw RelayException.Protocol("failed voice turn cannot resolve a request")
                        throw RelayException.VoiceTurn(turnId, turn.state, turn.error?.code)
                    }
                    else -> throw RelayException.Protocol("unknown voice turn state")
                }
                failures = 0
                pause(start, pollDelay)
                pollDelay = minOf(options.maxPollMs, pollDelay * 2)
            }
            try {
                exchange = get(turnId)
            } catch (failure: RelayException) {
                if (!failure.transient || ++failures >= options.maxAttempts) throw failure
                exchange = null
                pause(start, backoff(failures))
            }
        }
    }

    private suspend fun <T> bounded(block: suspend () -> T): T {
        try {
            return withTimeout(options.timeoutMs) { block() }
        } catch (timeout: TimeoutCancellationException) {
            // An enclosing caller timeout/cancellation must remain cancellation.
            currentCoroutineContext().ensureActive()
            throw timeoutError()
        }
    }

    private fun requireTurnId(id: String) {
        if (runCatching { UUID.fromString(id).toString().equals(id, ignoreCase = true) }.getOrDefault(false).not()) {
            throw RelayException.Protocol("invalid voice turn identifier")
        }
    }

    private fun checkDeadline(start: Long) {
        if (options.nowMs() - start >= options.timeoutMs) throw timeoutError()
    }

    private suspend fun pause(start: Long, ms: Long) {
        currentCoroutineContext().ensureActive()
        val remaining = options.timeoutMs - (options.nowMs() - start)
        if (remaining <= 0) throw timeoutError()
        options.sleep(minOf(ms, remaining))
        checkDeadline(start)
    }

    private fun backoff(attempt: Int) = minOf(options.maxPollMs, options.firstPollMs * (1L shl minOf(attempt - 1, 10)))
    private fun timeoutError() = RelayException.Network(true, SocketTimeoutException("voice turn result deadline exceeded"))

    private val RelayException.transient: Boolean
        get() = this is RelayException.Network || this is RelayException.Api && httpStatus in 500..599 &&
            rawCode !in listOf("conversation_failed", "voice_unavailable")
}
