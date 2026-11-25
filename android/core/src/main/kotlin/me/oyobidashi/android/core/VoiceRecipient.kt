package me.oyobidashi.android.core

/** Recipients used by cloud plan calls. Unrecognized values cannot be confirmed. */
enum class VoiceRecipient(val provider: String, val displayName: String) {
    META("meta", "Meta"),
    GEMINI("gemini", "Google（Gemini）"),
    CLAUDE("anthropic", "Anthropic");

    companion object {
        fun fromProvider(provider: String?): VoiceRecipient? = entries.firstOrNull { it.provider == provider }
    }
}
