package me.oyobidashi.android.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import me.oyobidashi.android.core.OyobidashiJson
import me.oyobidashi.android.core.NotificationContent
import me.oyobidashi.android.core.ReplyFailure
import me.oyobidashi.android.graph
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** 通知の「返信」(RemoteInput) と選択肢ボタン。relay に回答を POST し、結果に応じて通知を消す/更新する。 */
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REPLY) return
        val content = try {
            OyobidashiJson.decodeFromString(NotificationContent.serializer(), intent.getStringExtra(EXTRA_CONTENT) ?: return)
        } catch (e: Exception) {
            return
        }
        val choiceIndex = intent.getIntExtra(EXTRA_CHOICE_INDEX, -1).takeIf { it >= 0 }
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY_TEXT)?.toString()

        val graph = context.graph
        val pending = goAsync()
        graph.scope.launch {
            try {
                val session = graph.session.value
                if (!content.isForDevice(session?.credentials?.deviceId)) return@launch
                // BroadcastReceiver の持ち時間 (約10秒) に収める。超えたら未送信として扱い、入力は下書きに残す
                val result = withTimeoutOrNull(8_500) { graph.directReply.handle(content, text, choiceIndex) }
                if (result == null) {
                    if (graph.session.value !== session || !content.isForDevice(graph.session.value?.credentials?.deviceId)) return@launch
                    if (choiceIndex == null && !text.isNullOrBlank()) {
                        graph.session.value?.repository?.editDraft(content.requestId, text.trim())
                    }
                    graph.notifier.showReplyFailure(content, ReplyFailure.UNREACHABLE)
                }
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_REPLY = "me.oyobidashi.android.action.REPLY"
        const val EXTRA_CONTENT = "content"
        const val EXTRA_CHOICE_INDEX = "choice_index"
        const val KEY_REPLY_TEXT = "reply_text"
    }
}
