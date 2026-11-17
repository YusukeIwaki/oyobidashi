package me.oyobidashi.android.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/** Cloud Push contains a private-content-free hint. Actions become available after authenticated fetch. */
object NotificationEnrichmentPolicy {
    fun fallback(source: NotificationContent): NotificationContent =
        if (source.recipientDeviceId != null && !source.isCall && !source.isTerminalPush) {
            source.copy(choices = emptyList(), deliveryMode = DeliveryMode.TEXT)
        } else source

    /** Null removes an obsolete ordinary notification; live calls belong to Telecom. */
    fun enriched(source: NotificationContent, authoritative: Request): NotificationContent? {
        if (authoritative.id != source.requestId || authoritative.isLiveCall) return null
        if (!authoritative.isPending &&
            !(authoritative.kind == RequestKind.NOTIFICATION && authoritative.status == RequestStatus.NOTIFIED)
        ) return null
        return NotificationContent.fromRequest(authoritative).copy(recipientDeviceId = source.recipientDeviceId)
    }
}

/**
 * Enriches the already visible fallback on the caller's dispatcher. A finite deadline cancels
 * the device HTTP request. No exception can replace the fallback with invented content.
 */
class NotificationEnricher(
    private val api: RelayApi,
    private val notifier: RequestNotifier,
    private val isCurrentSession: () -> Boolean,
    private val currentDeviceId: () -> String?,
    private val applyRequest: (Request) -> Unit,
    private val latestRequest: (String) -> Request?,
    private val onUnauthorized: () -> Unit = {},
    private val timeoutMs: Long = 3_000,
) {
    init { require(timeoutMs > 0) }

    suspend fun enrich(source: NotificationContent) {
        // Incoming call reporting and terminal cancellation do not wait behind an enrichment fetch.
        if (source.isCall || source.isTerminalPush || !current(source)) return
        val request = try {
            withTimeoutOrNull(timeoutMs) { api.getRequest(source.requestId) } ?: return
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: RelayException) {
            if (current(source) && failure.isUnauthorized) onUnauthorized()
            return
        } catch (_: Exception) {
            return
        }
        if (!current(source) || request.id != source.requestId) return
        if (request.isLiveCall) {
            // Ordinary and incoming-call notifications share the tag. Remove the fallback
            // before applying state, so Telecom's newly reported incoming notification wins.
            notifier.cancel(source.requestId)
            applyRequest(request)
            return
        }
        applyRequest(request)
        if (!current(source)) return
        // A newer WebSocket result may have ended the request during this HTTP fetch.
        val latest = latestRequest(source.requestId) ?: request
        if (latest.isLiveCall) return // preserve a newer incoming-call notification
        val content = NotificationEnrichmentPolicy.enriched(source, latest)
        if (content == null) notifier.cancel(source.requestId) else notifier.show(content)
    }

    private fun current(source: NotificationContent) = isCurrentSession() && source.isForDevice(currentDeviceId())
}
