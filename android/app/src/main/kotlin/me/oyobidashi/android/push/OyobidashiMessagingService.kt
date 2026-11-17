package me.oyobidashi.android.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import me.oyobidashi.android.core.FcmPayloadParser
import me.oyobidashi.android.core.RequestStatus
import me.oyobidashi.android.core.NotificationEnricher
import me.oyobidashi.android.core.NotificationEnrichmentPolicy
import me.oyobidashi.android.graph
import kotlinx.coroutines.launch

/** FCM の data メッセージを受けて、アプリ側で通知を組み立てる (RemoteInput を付けるため)。 */
class OyobidashiMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val graph = applicationContext.graph
        val data = message.data.toMap()
        // Session changes and notification side effects share the main dispatcher.
        graph.scope.launch { deliver(data) }
    }

    private fun deliver(data: Map<String, String>) {
        val graph = applicationContext.graph
        val session = graph.session.value ?: return // ペアリング解除後に届いたものは出さない
        val content = FcmPayloadParser.parseForDevice(data, session.credentials.deviceId) ?: return

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
        val fallback = NotificationEnrichmentPolicy.fallback(content)
        if (known?.isLiveCall != true) {
            session.repository.onPushReceived(fallback) // 圏外でも安全な通知と下書きの入口を残す
            graph.notifier.show(fallback)
        }
        // The full authoritative request also carries call endings and priority changes.
        // Keep Telecom in sync even when this arrived while the UI/WebSocket was asleep.
        graph.scope.launch {
            NotificationEnricher(
                api = session.api,
                notifier = graph.notifier,
                isCurrentSession = { graph.session.value === session },
                currentDeviceId = { graph.session.value?.credentials?.deviceId },
                applyRequest = session.repository::applyRequest,
                latestRequest = { session.repository.state.value.find(it) },
                onUnauthorized = session.repository::handleUnauthorized,
            ).enrich(content)
        }
    }

    override fun onNewToken(token: String) {
        applicationContext.graph.syncPushToken(token)
    }
}
