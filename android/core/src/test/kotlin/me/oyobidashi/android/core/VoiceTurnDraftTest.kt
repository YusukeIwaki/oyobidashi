package me.oyobidashi.android.core

import org.junit.Assert.*
import org.junit.Test
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking

class VoiceTurnDraftTest {
    private val drafts = InMemoryDraftStore()
    private fun repository() = RequestsRepository(FakeApi(), FakeNotifier(), draftStore = drafts)

    @Test fun `confirmed utterance and UUID survive process recreation before network result`() {
        val first = repository().beginVoiceTurn("r", "c", "明日10時で")
        val recreated = repository()
        val saved = recreated.state.value.draft("r")
        assertEquals("明日10時で", saved.text)
        assertEquals(InputMethod.VOICE, saved.inputMethod)
        assertEquals(first.turnId, saved.voiceTurnId)
        val resumed = recreated.beginVoiceTurn("r", "c", "明日10時で")
        assertEquals(first.turnId, resumed.turnId)
        assertFalse(first.resumeTurn)
        assertTrue(resumed.resumeTurn)
    }

    @Test fun `new utterance and different call get new IDs rather than replaying old answer`() {
        val repo = repository()
        val first = repo.beginVoiceTurn("r", "c", "はい")
        val next = repo.beginVoiceTurn("r", "c", "いいえ")
        val otherCall = repo.beginVoiceTurn("r", "other", "いいえ")
        assertNotEquals(first.turnId, next.turnId)
        assertNotEquals(next.turnId, otherCall.turnId)
    }

    @Test fun `same-text preservation after transport failure keeps uncertainty key`() {
        val repo = repository()
        val first = repo.beginVoiceTurn("r", "c", "はい")
        repo.editDraft("r", "はい")
        assertEquals(first.turnId, repository().beginVoiceTurn("r", "c", "はい").turnId)
    }

    @Test fun `successful result clears only its matching draft`() {
        val repo = repository()
        val first = repo.beginVoiceTurn("r", "c", "はい")
        repo.completeVoiceTurn("r", first.turnId)
        assertEquals(Draft(), repo.state.value.draft("r"))
        assertTrue(drafts.loadAll().isEmpty())
        val second = repo.beginVoiceTurn("r", "c", "はい")
        repo.editDraft("r", "手直しした回答")
        repo.completeVoiceTurn("r", second.turnId)
        assertEquals("手直しした回答", repo.state.value.draft("r").text)
    }

    @Test fun `reconnected snapshot can restore server turn ID without generating new utterance`() {
        val turnId = "123e4567-e89b-12d3-a456-426614174000"
        val repo = repository()
        val body = repo.beginVoiceTurn("r", "c", "はい", recoveredTurnId = turnId)
        assertEquals(turnId, body.turnId)
        assertEquals(turnId, repository().state.value.draft("r").voiceTurnId)
    }

    @Test fun `legacy draft format loads and new pending metadata roundtrips`() {
        val legacy = OyobidashiJson.decodeFromString(Draft.serializer(), """{"text":"draft","dictated":true}""")
        assertNull(legacy.voiceTurnId)
        val saved = Draft("はい", true, "123e4567-e89b-12d3-a456-426614174000", "c")
        assertEquals(saved, OyobidashiJson.decodeFromString(Draft.serializer(), OyobidashiJson.encodeToString(Draft.serializer(), saved)))
    }

    @Test fun `flush waits for persistence and preserves draft on storage failure`() = runBlocking {
        var flushed = false
        val failing = object : DraftStore by drafts {
            override suspend fun flush() { flushed = true; throw java.io.IOException("disk unavailable") }
        }
        val repo = RequestsRepository(FakeApi(), FakeNotifier(), draftStore = failing)
        val body = repo.beginVoiceTurn("r", "c", "はい")
        try {
            repo.flushVoiceDraft(body.turnId)
            fail("must not submit without durable key")
        } catch (failure: RelayException.VoiceTurn) {
            assertEquals("local_storage_failed", failure.code)
        }
        assertTrue(flushed)
        assertEquals("はい", repo.state.value.draft("r").text)
        assertEquals(body.turnId, repo.state.value.draft("r").voiceTurnId)
    }

    @Test fun `caller cancellation while persisting is never converted into success or server failure`() = runBlocking {
        val cancelled = object : DraftStore by drafts {
            override suspend fun flush() { throw CancellationException("cancelled") }
        }
        val repo = RequestsRepository(FakeApi(), FakeNotifier(), draftStore = cancelled)
        val body = repo.beginVoiceTurn("r", "c", "はい")
        try {
            repo.flushVoiceDraft(body.turnId)
            fail("must cancel")
        } catch (_: CancellationException) {
            assertEquals(body.turnId, repo.state.value.draft("r").voiceTurnId)
        }
    }

    @Test fun `definitive failure preserves text but explicit retry creates a new ID`() {
        val repo = repository()
        val original = repo.beginVoiceTurn("r", "c", "はい")
        repo.failVoiceTurn("r", original.turnId)
        val draft = repository().state.value.draft("r")
        assertEquals("はい", draft.text)
        assertEquals("c", draft.voiceCallId)
        assertNull(draft.voiceTurnId)
        val retried = repo.beginVoiceTurn("r", "c", "はい")
        assertNotEquals(original.turnId, retried.turnId)
        assertFalse(retried.resumeTurn)
    }
}
