package me.oyobidashi.android.ui

import me.oyobidashi.android.core.BillingStatus
import me.oyobidashi.android.core.BillingVoiceTraining
import me.oyobidashi.android.core.VoiceRecipient
import org.junit.Assert.assertEquals
import org.junit.Test

class BillingVoiceSummaryTest {
    private val status = BillingStatus(
        enabled = true,
        voiceTraining = BillingVoiceTraining(free = false, plus = false),
        voicePlanProviders = mapOf("free" to "meta", "plus" to "gemini"),
    )

    @Test fun `plans show their model benefits and recipients with identical training terms`() {
        assertEquals("日常会話に適したモデルを使います。\n${VoiceRecipient.META.disclosure}", Texts.billingVoiceSummary(status))
        val plusSummary = "より高精度なモデルを使います。\n${VoiceRecipient.GEMINI.disclosure}"
        assertEquals(plusSummary, Texts.billingVoiceSummary(status, plus = true))
        assertEquals(plusSummary, Texts.billingVoiceSummary(status.copy(active = true)))
    }

    @Test fun `older billing responses still show the model benefits`() {
        assertEquals("日常会話に適したモデルを使います。", Texts.billingVoiceSummary(BillingStatus(enabled = true)))
        assertEquals("より高精度なモデルを使います。", Texts.billingVoiceSummary(BillingStatus(enabled = true, active = true)))
    }

    @Test fun `linked Claude shows its own billing and recipient`() {
        val linked = status.copy(voiceProvider = "anthropic-linked")
        val summary = "通話には連携したClaudeを使い、APIの利用分はAnthropicから直接請求されます。"
        assertEquals(summary, Texts.billingVoiceSummary(linked))
        assertEquals(summary, Texts.billingVoiceSummary(linked, plus = true))
    }
}
