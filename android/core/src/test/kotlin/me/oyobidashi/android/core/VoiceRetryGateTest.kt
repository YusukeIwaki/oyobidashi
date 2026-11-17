package me.oyobidashi.android.core

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceRetryGateTest {
    @Test fun `wait suspends until one explicit retry and does not prequeue repeats`() = runTest {
        val gate = VoiceRetryGate()
        assertFalse(gate.retry())
        val waiting = async { gate.awaitRetry() }
        runCurrent()
        assertFalse(waiting.isCompleted)
        assertTrue(gate.retry())
        assertFalse(gate.retry())
        waiting.await()
        assertFalse(gate.retry())
        assertEquals(0L, testScheduler.currentTime)
    }

    @Test fun `hangup cancels suspended wait without leaving retry state behind`() = runTest {
        val gate = VoiceRetryGate()
        val waiting = async { gate.awaitRetry() }
        runCurrent()
        waiting.cancelAndJoin()
        assertFalse(gate.retry())
        val nextCall = async { gate.awaitRetry() }
        runCurrent()
        assertTrue(gate.retry())
        nextCall.await()
    }
}
