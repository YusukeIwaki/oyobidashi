package me.oyobidashi.android.core

/** Recipients used by cloud plan calls. Unrecognized values cannot be confirmed. */
enum class VoiceRecipient(val provider: String, val displayName: String) {
    META("meta", "Meta"),
    GEMINI("gemini", "Google（Gemini）"),
    CLAUDE("anthropic", "Anthropic");

    val disclosure: String
        get() = "通話の文字起こしと質問・補足・選択肢・会話の履歴を${displayName}に送信します。"

    companion object {
        fun fromProvider(provider: String?): VoiceRecipient? = entries.firstOrNull { it.provider == provider }
    }
}
