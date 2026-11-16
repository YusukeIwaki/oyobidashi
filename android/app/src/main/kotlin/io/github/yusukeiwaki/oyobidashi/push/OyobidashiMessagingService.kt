package io.github.yusukeiwaki.oyobidashi.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.github.yusukeiwaki.oyobidashi.core.FcmPayloadParser
import io.github.yusukeiwaki.oyobidashi.core.RequestStatus
import io.github.yusukeiwaki.oyobidashi.graph
import kotlinx.coroutines.launch

/** FCM の data メッセージを受けて、アプリ側で通知を組み立てる (RemoteInput を付けるため)。 */
class OyobidashiMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val content = FcmPayloadParser.parse(message.data) ?: return
        val graph = applicationContext.graph
        val session = graph.session.value ?: return // ペアリング解除後に届いたものは出さない

        // 終端・サイレント push: 通知を取り消して再取得する (stale push 対策)。
        if (content.isTerminalPush) {
            graph.notifier.cancel(content.requestId)
            graph.callManager.onTerminalPush(content.requestId, content.status)
            graph.scope.launch {
                try {
                    session.repository.refresh()
                } catch (e: Exception) {
                    // LAN 外等。取り消しは済んでいる。
                }
            }
            return
        }

        // 通話 push: ネイティブ通話側へ (通常通知は出さない)。
        if (content.isCall) {
            val known = session.repository.state.value.find(content.requestId)
            if (known != null && content.isQuestion && !known.isPending) {
                graph.notifier.cancel(content.requestId)
                return
            }
            graph.callManager.onFcmCall(content)
            return
        }

        // すでに解決済みと分かっている質問の遅延配信は出さない
        val known = session.repository.state.value.find(content.requestId)
        if (known != null && known.status in setOf(RequestStatus.ANSWERED, RequestStatus.CANCELLED, RequestStatus.EXPIRED, RequestStatus.UNKNOWN)) return
        session.repository.onPushReceived(content) // LAN 外でもアプリ内で質問を読んで下書きできるように
        graph.notifier.show(content)
        // The full authoritative request also carries call endings and priority changes.
        // Keep Telecom in sync even when this arrived while the UI/WebSocket was asleep.
        graph.scope.launch {
            try { session.repository.applyRequest(session.api.getRequest(content.requestId)) }
            catch (e: Exception) { /* The visible notification remains usable offline. */ }
        }
    }

    override fun onNewToken(token: String) {
        applicationContext.graph.syncPushToken(token)
    }
}
