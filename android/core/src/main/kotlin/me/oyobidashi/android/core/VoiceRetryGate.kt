package me.oyobidashi.android.core

import kotlinx.coroutines.CompletableDeferred

/** エラー後は明示的な再試行を待つ。スレッド、タイマー、録音は占有しない。 */
class VoiceRetryGate {
    private var waiter: CompletableDeferred<Unit>? = null

    suspend fun awaitRetry() {
        val pending = CompletableDeferred<Unit>()
        synchronized(this) {
            check(waiter == null) { "voice retry already waiting" }
            waiter = pending
        }
        try { pending.await() } finally {
            synchronized(this) { if (waiter === pending) waiter = null }
        }
    }

    /** 実行中のターンに再試行を先行予約しない。 */
    fun retry(): Boolean = synchronized(this) { waiter?.complete(Unit) ?: false }
}
