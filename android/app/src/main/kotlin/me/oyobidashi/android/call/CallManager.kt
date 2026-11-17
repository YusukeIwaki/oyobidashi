package me.oyobidashi.android.call

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.SpeechRecognizer
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import androidx.core.content.ContextCompat
import me.oyobidashi.android.core.Call
import me.oyobidashi.android.core.CallEvent
import me.oyobidashi.android.core.CallEventBody
import me.oyobidashi.android.core.CallState
import me.oyobidashi.android.core.CallTranscriptEntry
import me.oyobidashi.android.core.DeliveryMode
import me.oyobidashi.android.core.NotificationContent
import me.oyobidashi.android.core.RelayApi
import me.oyobidashi.android.core.RelayException
import me.oyobidashi.android.core.Request
import me.oyobidashi.android.core.RequestStatus
import me.oyobidashi.android.core.CallOutcome
import me.oyobidashi.android.core.RequestNotifier
import me.oyobidashi.android.core.RequestsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** 通話中 UI (CallActivity / 通知) が購読する状態。null は通話なし。 */
data class CallUiState(
    val requestId: String,
    val callId: String,
    val agentName: String?,
    val question: String,
    val state: CallState,
    val transcript: List<CallTranscriptEntry> = emptyList(),
    val lastReply: String? = null,
    val error: String? = null,
    val voiceAvailable: Boolean = true,
    val ringing: Boolean = state == CallState.RINGING,
    val awaitingReply: Boolean = false,
    val canRetryVoice: Boolean = false,
    val subject: String? = null,
)

/**
 * ネイティブ通話の統括。WebSocket/FCM/一覧のいずれから届いた call もここで一元化する。
 *
 * - 同一 call_id の重複は無視 (dedup)。relay は同時に1通話のみ。
 * - 他端末が所有 (device_id が自端末以外) したら鳴動を止める。
 * - リモートで終わったら (ended / 終端 status) 鳴動・通話を止め、pending 残りならテキストにフォールバック。
 * - 鳴動はローカルでもタイムアウトする (relay 45s に対する保険)。
 */
class CallManager(
    private val context: Context,
    private val scope: CoroutineScope,
    private val api: () -> RelayApi?,
    private val myDeviceId: () -> String?,
    private val repository: () -> RequestsRepository?,
    private val regularNotifier: RequestNotifier,
    private val onSignedOut: () -> Unit = {},
) {
    private val _uiState = MutableStateFlow<CallUiState?>(null)
    val uiState: StateFlow<CallUiState?> = _uiState.asStateFlow()

    private data class ActiveCall(
        val requestId: String,
        val callId: String,
        var state: CallState,
        var agentName: String?,
        var question: String,
        var subject: String?,
        var transcript: List<CallTranscriptEntry>,
        var lastReply: String?,
        var error: String?,
        var connection: OyobidashiConnection?,
        var timeoutJob: Job?,
        var needsResume: Boolean = false,
    )

    private val stoppedPreferences = context.getSharedPreferences("oyobidashi_call_history", Context.MODE_PRIVATE)
    private val stoppedCallIds = LinkedHashSet(stoppedPreferences.getStringSet("ended", emptySet()).orEmpty())
    private fun markStopped(id: String) {
        stoppedCallIds.add(id)
        while (stoppedCallIds.size > 128) stoppedCallIds.remove(stoppedCallIds.first())
        stoppedPreferences.edit().putStringSet("ended", HashSet(stoppedCallIds)).apply()
    }
    private var current: ActiveCall? = null
    private var voiceTurnRequestId: String? = null
    private var finishingVoiceRequestId: String? = null

    fun beginVoiceTurn(requestId: String) {
        voiceTurnRequestId = requestId
        current?.takeIf { it.requestId == requestId }?.let { publish(it) }
    }
    fun finishVoiceTurn(requestId: String, resolved: Boolean) {
        if (voiceTurnRequestId == requestId) voiceTurnRequestId = null
        if (resolved) finishingVoiceRequestId = requestId
        current?.takeIf { it.requestId == requestId }?.let { publish(it) }
    }

    private fun shouldFinishAcknowledgement(requestId: String, latest: Request?): Boolean =
        latest?.status == RequestStatus.ANSWERED && latest.call?.outcome == CallOutcome.RESOLVED &&
        latest.call?.deviceId == myDeviceId() &&
        (voiceTurnRequestId == requestId || finishingVoiceRequestId == requestId)


    val phoneAccountHandle: PhoneAccountHandle =
        PhoneAccountHandle(ComponentName(context, OyobidashiConnectionService::class.java), "oyobidashi")

    private fun telecom(): TelecomManager? =
        context.getSystemService(TelecomManager::class.java)

    /** PhoneAccount を登録する (self-managed はユーザーの有効化不要)。 */
    fun ensurePhoneAccount() {
        try {
            val tm = telecom() ?: return
            val account = PhoneAccount.builder(phoneAccountHandle, "お呼び出し")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .build()
            tm.registerPhoneAccount(account)
        } catch (e: RuntimeException) {
            Log.w(TAG, "registerPhoneAccount failed; calls fall back to text", e)
        } catch (e: SecurityException) {
            Log.w(TAG, "registerPhoneAccount denied; calls fall back to text", e)
        }
    }

    /** 音声通話がこの端末でできるか (認識エンジン + マイク権限)。TTS の有無は service 側で確定する。 */
    fun isVoiceAvailable(): Boolean {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) return false
        return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
    }

    /** 認識エンジン自体の有無 (権限とは独立。エミュレータの正直なフォールバック用)。 */
    fun isSpeechEnginePresent(): Boolean = try {
        SpeechRecognizer.isRecognitionAvailable(context)
    } catch (e: RuntimeException) {
        false
    }

    // ---- 照合 (repository.state の変更ごとに AppGraph から呼ばれる) ----

    fun reconcile(requests: List<Request>) {
        scope.launch { doReconcile(requests) }
    }

    private fun doReconcile(requests: List<Request>) {
        val mine = myDeviceId()
        val live = requests.filter { it.isLiveCall }
        val cur = current
        if (live.isEmpty()) {
            // 生きた通話なし。鳴動・通話中ならリモートで終わった。
            if (cur != null) {
                val latest = requests.firstOrNull { it.id == cur.requestId }
                if (shouldFinishAcknowledgement(cur.requestId, latest)) {
                    finishingVoiceRequestId = cur.requestId
                    return
                }
                onRemoteEnded(cur, latest)
            }
            return
        }
        // 同一 call の更新か、新着か。
        if (cur != null) {
            val same = live.firstOrNull { it.call!!.id == cur.callId }
            if (same != null) {
                onLiveCallUpdated(cur, same, mine)
                return
            }
            // 別 call が来た。古い方を片付けて新しい方へ (relay は1通話のみのはずだが保険)。
            val next = live.first()
            Log.i(TAG, "replacing call ${cur.callId} with ${next.call!!.id}")
            cleanupCurrent(silently = true)
            startRinging(next, mine)
            return
        }
        // 新着。複数あれば先頭のみ (1通話のみ)。
        startRinging(live.first(), mine)
    }

    private fun onLiveCallUpdated(cur: ActiveCall, req: Request, mine: String?) {
        val call = req.call!!
        // 他端末が所有したら鳴動を止める (answer で device_id が付く)。
        if (!call.deviceId.isNullOrEmpty() && mine != null && call.deviceId != mine) {
            Log.i(TAG, "call ${call.id} owned by ${call.deviceId}; stopping locally")
            stopLocallyWithoutFallback(cur, "他の端末で応答されました")
            // repository 側の通常通知も消す (通話通知と同じ tag のため1回で消える)。
            regularNotifier.cancel(req.id)
            return
        }
        // 自端末の通話の進捗 (transcript 等) を UI に反映。state は answer 側で管理するが、
        // サーバーが active に遷移していたら追随する。
        var changed = false
        if (call.transcript != cur.transcript) {
            cur.transcript = call.transcript
            changed = true
        }
        if (call.state == CallState.ACTIVE && cur.state == CallState.RINGING) {
            // 自端末で answer した直後のサーバー反映。service が起動済みなら何もしない。
            // (service 未起動で active になった場合は answer 側の処理に任せる)
            changed = true
        }
        if (req.agent?.name != cur.agentName || req.question != cur.question || req.subject != cur.subject) {
            cur.agentName = req.agent?.name
            cur.question = req.question
            cur.subject = req.subject
            changed = true
        }
        if (changed) publish(cur)
    }

    // ---- FCM からの着信 ----

    fun onFcmCall(content: NotificationContent) {
        scope.launch { doFcmCall(content) }
    }

    private suspend fun doFcmCall(content: NotificationContent) {
        if (!content.isForDevice(myDeviceId())) return
        val cur = current
        // dedup: 同一 call は無視。
        if (cur != null && content.callId != null && content.callId == cur.callId) return
        if (cur != null && content.callId == null && content.requestId == cur.requestId) return
        val client = api() ?: return
        // すでに解決済みと分かっている質問の遅延配信は無視する。
        val known = repository()?.state?.value?.find(content.requestId)
        if (known != null && !known.isPending) {
            regularNotifier.cancel(content.requestId)
            return
        }
        // FCM だけでは Call 全体が無いので取りに行く。LAN 外では取れないのでテキストで出す。
        val req = try {
            client.getRequest(content.requestId)
        } catch (e: RelayException) {
            if (api() !== client || !content.isForDevice(myDeviceId())) return
            if (e.isUnauthorized) {
                repository()?.handleUnauthorized() ?: onSignedOut()
                return
            }
            // LAN 外など。プレースホルダを残してテキスト通知にする (通話はできない旨を正直に)。
            repository()?.onPushReceived(content.copy(deliveryMode = DeliveryMode.TEXT, callId = null))
            val fallback = content.copy(deliveryMode = DeliveryMode.TEXT, callId = null)
            regularNotifier.show(fallback)
            return
        }
        if (api() !== client || !content.isForDevice(myDeviceId())) return
        repository()?.applyRequest(req)
        // 適用後の reconcile は state 購読経由で走るが、即時性のため直接も回す。
        val mine = myDeviceId()
        if (req.isLiveCall) {
            if (current == null) {
                startRinging(req, mine)
            } else if (current?.callId != req.call!!.id) {
                cleanupCurrent(silently = true)
                startRinging(req, mine)
            }
        } else if (req.isPending) {
            // すでにテキストにフォールバック済み等。通常通知にする。
            regularNotifier.show(NotificationContent.fromRequest(req))
        } else {
            regularNotifier.cancel(req.id)
        }
    }

    /** 終端 push (silent) が届いた。通話中なら即座に止める。 */
    fun onTerminalPush(requestId: String, status: RequestStatus? = null) {
        scope.launch {
            if (status == RequestStatus.ANSWERED && (voiceTurnRequestId == requestId || finishingVoiceRequestId == requestId)) return@launch
            val cur = current
            if (cur != null && cur.requestId == requestId) {
                val latest = repository()?.state?.value?.find(requestId)
                onRemoteEnded(cur, latest)
            } else {
                regularNotifier.cancel(requestId)
            }
        }
    }

    // ---- 鳴動開始 ----

    private fun startRinging(req: Request, mine: String?) {
        val call = req.call ?: return
        if (!call.isValid || !call.isLive || call.id in stoppedCallIds) return
        // 他端末所有は鳴らさない。
        if (!call.deviceId.isNullOrEmpty() && mine != null && call.deviceId != mine) return
        if (call.isActive && (mine.isNullOrEmpty() || call.deviceId != mine)) return
        // 終端済みリクエストは鳴らさない。
        if (!req.isPending) return
        if (current != null) return // dedup (reconcile 側で置換済みのはずだが保険)

        // 音声エンジンが無い端末 (エミュレータ等) は正直にテキストへ。POST はしない
        // (他端末が応答できるよう relay 側は ringing のままにする)。
        if (!isSpeechEnginePresent()) {
            markStopped(call.id)
            Log.i(TAG, "speech engine missing; falling back to text for ${req.id}")
            repository()?.applyRequest(req)
            showTextFallback(req, "この端末では音声通話を利用できないため、テキストで回答してください")
            return
        }

        val active = ActiveCall(
            requestId = req.id,
            callId = call.id,
            state = if (call.isActive) CallState.ACTIVE else CallState.RINGING,
            agentName = req.agent?.name,
            question = req.question,
            subject = req.subject,
            transcript = call.transcript,
            lastReply = if (call.isActive) call.transcript.lastOrNull()?.takeIf { it.role == me.oyobidashi.android.core.CallRole.ASSISTANT }?.text else null,
            error = if (call.isActive) "通話が中断されました。再開するか、テキストで返信できます" else null,
            connection = null,
            timeoutJob = null,
            needsResume = call.isActive,
        )
        current = active
        publish(active)

        // Process restart must not manufacture another incoming call for an answered
        // session. Resume is an explicit UI action and reuses the saved turn.
        if (call.isActive) return

        // Telecom に着信を積む (失敗しても通知は出す)。
        addTelecomIncoming(req, call)

        // ネイティブ通話通知 (CallStyle + 許可時のみフルスクリーン)。
        CallNotifications.showIncoming(context, req, call)

        // ローカルタイムアウト (relay 45s の保険。55s)。
        active.timeoutJob?.cancel()
        active.timeoutJob = scope.launch {
            delay(RING_TIMEOUT_MILLIS)
            val still = current
            if (still != null && still.callId == call.id && still.state == CallState.RINGING) {
                Log.i(TAG, "ring timeout for ${call.id}; falling back to text")
                // relay 側の missed 遷移を待たず鳴動だけ止め、最新を取り直す。
                cleanupCurrent(silently = true)
                regularNotifier.cancel(req.id)
                refreshAndFallback(req.id)
            }
        }
    }

    private suspend fun refreshAndFallback(requestId: String) {
        val client = api()
        val latest = if (client != null) {
            try {
                client.getRequest(requestId).also { repository()?.applyRequest(it) }
            } catch (e: RelayException) {
                if (e.isUnauthorized) repository()?.handleUnauthorized()
                repository()?.state?.value?.find(requestId)
            }
        } else {
            repository()?.state?.value?.find(requestId)
        }
        if (latest != null && latest.isPending) {
            showTextFallback(latest, null)
        } else if (latest != null) {
            regularNotifier.cancel(requestId)
        }
    }

    private fun showTextFallback(req: Request, notice: String?) {
        val base = NotificationContent.fromRequest(req)
        // 通話モードのまま出すとボタン無し・通話扱いになるのでテキストに寄せる。
        val fallback = base.copy(
            deliveryMode = DeliveryMode.TEXT,
            callId = null,
            body = if (notice != null) "$notice\n\n${base.body}" else base.body,
        )
        regularNotifier.show(fallback)
    }

    private fun addTelecomIncoming(req: Request, call: Call) {
        try {
            val tm = telecom() ?: return
            ensurePhoneAccount()
            val extras = Bundle().apply {
                putString(EXTRA_REQUEST_ID, req.id)
                putString(EXTRA_CALL_ID, call.id)
                putString(EXTRA_AGENT_NAME, req.agent?.name.orEmpty())
                putString(EXTRA_QUESTION, req.question)
            }
            tm.addNewIncomingCall(phoneAccountHandle, extras)
        } catch (e: RuntimeException) {
            Log.w(TAG, "addNewIncomingCall failed; notification only", e)
        } catch (e: SecurityException) {
            Log.w(TAG, "addNewIncomingCall denied; notification only", e)
        }
    }

    // ---- 応答・拒否・切断 ----

    fun answer(requestId: String, callId: String) {
        scope.launch { doAnswer(requestId, callId) }
    }

    private suspend fun doAnswer(requestId: String, callId: String) {
        val cur = current
        if (cur == null || cur.requestId != requestId || cur.callId != callId) {
            // 不明な通話への応答。最新を取り直して終わり (stale push 対策)。
            refreshQuietly(requestId)
            return
        }
        if (cur.state == CallState.ACTIVE) return // 済み
        // マイク権限がなければ UI 側で求める。ここでは止めてエラーを出す。
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            cur.error = "通話にはマイクの権限が必要です"
            publish(cur)
            return
        }
        if (!isSpeechEnginePresent()) {
            cleanupCurrent(silently = true)
            regularNotifier.cancel(requestId)
            val latest = repository()?.state?.value?.find(requestId)
            if (latest != null) showTextFallback(latest, "この端末では音声通話を利用できません")
            return
        }
        val client = api()
        if (client == null) {
            cur.error = "ペアリングが解除されています"
            publish(cur)
            return
        }
        cur.error = null
        publish(cur)
        val res = try {
            client.postCall(requestId, CallEventBody(CallEvent.ANSWER))
        } catch (e: RelayException) {
            if (e.isUnauthorized) {
                repository()?.handleUnauthorized() ?: onSignedOut()
                cleanupCurrent(silently = true)
                return
            }
            if (e.isAlreadyResolved) {
                // 他端末が先に応答/解決した等。最新を取り直して終わる。
                cleanupCurrent(silently = true)
                regularNotifier.cancel(requestId)
                refreshQuietly(requestId)
                return
            }
            cur.error = if (e is RelayException.Network) {
                "中継サーバーに接続できません。ネットワーク接続を確認してもう一度お試しください"
            } else {
                "応答できませんでした。もう一度お試しください"
            }
            publish(cur)
            return
        }
        repository()?.applyRequest(res.request)
        val newCall = res.call
        if (newCall == null || !newCall.isValid) {
            cur.error = "通話を開始できませんでした"
            publish(cur)
            return
        }
        // 鳴動停止 → 通話中へ。
        cur.timeoutJob?.cancel()
        cur.timeoutJob = null
        cur.state = CallState.ACTIVE
        cur.transcript = newCall.transcript
        cur.lastReply = res.reply
        cur.error = null
        publish(cur)
        regularNotifier.cancel(requestId) // 着信通知を消す (FGS 通知に置き換わる)
        cur.connection?.setActive()
        // フォアグラウンド service で音声ループ開始。
        CallService.start(context, requestId, newCall.id, res.reply ?: res.request.question)
    }

    fun decline(requestId: String, callId: String) {
        scope.launch { doDecline(requestId, callId) }
    }

    fun retryVoice(requestId: String, callId: String) {
        val cur = current?.takeIf { it.requestId == requestId && it.callId == callId && it.state == CallState.ACTIVE } ?: return
        if (voiceTurnRequestId == requestId) return
        val draft = repository()?.state?.value?.draft(requestId) ?: return
        if (!cur.needsResume && (draft.voiceCallId != callId || draft.text.isBlank())) return
        cur.error = null
        cur.needsResume = false
        publish(cur)
        CallService.retry(context, requestId, callId, cur.lastReply ?: cur.question)
    }

    private suspend fun doDecline(requestId: String, callId: String) {
        val cur = current
        val client = api()
        // 鳴動は即止める (ネットワークを待たない)。
        if (cur != null && cur.requestId == requestId && cur.callId == callId) {
            cleanupCurrent(silently = true)
        }
        regularNotifier.cancel(requestId)
        if (client == null) return
        val res = try {
            client.postCall(requestId, CallEventBody(CallEvent.DECLINE))
        } catch (e: RelayException) {
            if (e.isUnauthorized) {
                repository()?.handleUnauthorized() ?: onSignedOut()
                return
            }
            // 圏外等でも鳴動は止めた。最新が取れればテキストに寄せる。
            refreshAndFallback(requestId)
            return
        }
        repository()?.applyRequest(res.request)
        if (res.request.isPending) showTextFallback(res.request, null)
        else regularNotifier.cancel(requestId)
    }

    fun hangup(requestId: String, callId: String) {
        scope.launch { doHangup(requestId, callId) }
    }

    private suspend fun doHangup(requestId: String, callId: String) {
        val cur = current
        val isRinging = cur != null && cur.requestId == requestId && cur.callId == callId && cur.state == CallState.RINGING
        // service と接続を即止める。
        CallService.stop(context)
        if (cur != null && cur.requestId == requestId && cur.callId == callId) {
            cleanupCurrent(silently = true)
        }
        regularNotifier.cancel(requestId)
        val client = api() ?: return
        val res = try {
            // 鳴動中でも hangup を送ってよい (relay は両方受け付ける)。decline との差は運用上の記録のみ。
            client.postCall(requestId, CallEventBody(CallEvent.HANGUP))
        } catch (e: RelayException) {
            if (e.isUnauthorized) {
                repository()?.handleUnauthorized() ?: onSignedOut()
                return
            }
            if (!isRinging) refreshAndFallback(requestId)
            return
        }
        repository()?.applyRequest(res.request)
        if (res.request.isPending) showTextFallback(res.request, null)
        else regularNotifier.cancel(requestId)
    }

    fun postFailed(requestId: String, callId: String, text: String?) {
        scope.launch { doFailed(requestId, callId, text) }
    }

    private suspend fun doFailed(requestId: String, callId: String, text: String?) {
        CallService.stop(context)
        val cur = current
        if (cur != null && cur.requestId == requestId && cur.callId == callId) {
            cleanupCurrent(silently = true)
        }
        regularNotifier.cancel(requestId)
        val client = api() ?: return
        val res = try {
            client.postCall(requestId, CallEventBody(CallEvent.FAILED, text))
        } catch (e: RelayException) {
            if (e.isUnauthorized) repository()?.handleUnauthorized()
            refreshAndFallback(requestId)
            return
        }
        repository()?.applyRequest(res.request)
        if (res.request.isPending) showTextFallback(res.request, null)
    }

    // ---- リモート終了・他端末所有 ----

    private fun onRemoteEnded(cur: ActiveCall, latest: Request?) {
        val wasActive = cur.state == CallState.ACTIVE
        CallService.stop(context)
        cleanupCurrent(silently = true)
        regularNotifier.cancel(cur.requestId)
        if (latest != null && latest.isPending) {
            // 通話は終わったが質問は残る (declined/hangup/missed/failed/cancel 後のフォールバック)。
            // 通話中だった場合はテキスト通知で知らせる。鳴動中だった場合も同様。
            showTextFallback(latest, null)
        }
        // 終端なら repository 側の cancel で消えている (同じ tag のため二重でも無害)。
        if (wasActive) {
            Log.i(TAG, "call ${cur.callId} ended remotely")
        }
    }

    private fun stopLocallyWithoutFallback(cur: ActiveCall, reason: String) {
        CallService.stop(context)
        cleanupCurrent(silently = true)
        regularNotifier.cancel(cur.requestId)
        Log.i(TAG, "call ${cur.callId} stopped locally: $reason")
    }

    /** 通話データを消して接続を切る。通知の出し直しは呼び出し側で行う。 */
    private fun cleanupCurrent(silently: Boolean) {
        val cur = current ?: return
        markStopped(cur.callId)
        if (voiceTurnRequestId == cur.requestId) voiceTurnRequestId = null
        if (finishingVoiceRequestId == cur.requestId) finishingVoiceRequestId = null
        current = null
        cur.timeoutJob?.cancel()
        cur.timeoutJob = null
        try {
            cur.connection?.setDisconnectedAndDestroy()
        } catch (e: RuntimeException) {
            // 既に破棄済み等
        }
        cur.connection = null
        _uiState.value = null
        if (!silently) Log.i(TAG, "call ${cur.callId} cleaned up")
    }

    /** ペアリング解除・プロセス終了時。全通話を黙って片付ける。 */
    fun clearAll() {
        scope.launch {
            CallService.stop(context)
            val cur = current
            if (cur != null) regularNotifier.cancel(cur.requestId)
            cleanupCurrent(silently = true)
        }
    }

    // ---- ConnectionService からのコールバック ----

    fun onConnectionCreated(conn: OyobidashiConnection, requestId: String?, callId: String?) {
        scope.launch {
            val cur = current
            if (cur != null && cur.requestId == requestId && cur.callId == callId) {
                cur.connection = conn
            } else {
                // 対応する通話がもう無い (タイムアウト等)。即切りする。
                try {
                    conn.setDisconnectedAndDestroy()
                } catch (e: RuntimeException) {
                    Unit
                }
            }
        }
    }

    fun onConnectionAnswer(requestId: String?, callId: String?) {
        if (requestId != null && callId != null) answer(requestId, callId)
    }

    fun onConnectionReject(requestId: String?, callId: String?) {
        if (requestId != null && callId != null) decline(requestId, callId)
    }

    fun onConnectionDisconnect(requestId: String?, callId: String?) {
        if (requestId != null && callId != null) hangup(requestId, callId)
    }

    // ---- CallService からのコールバック ----

    /** 音声ループの進捗 (発話・応答) を UI に反映する。 */
    fun onTurnProgress(requestId: String, callId: String, transcript: List<CallTranscriptEntry>, lastReply: String?) {
        scope.launch {
            val cur = current
            if (cur != null && cur.requestId == requestId && cur.callId == callId) {
                cur.transcript = transcript
                cur.lastReply = lastReply
                cur.error = null
                publish(cur)
            }
        }
    }

    fun onServiceError(requestId: String, callId: String, error: String) {
        scope.launch {
            val cur = current
            if (cur != null && cur.requestId == requestId && cur.callId == callId) {
                cur.error = error
                publish(cur)
            }
        }
    }

    /** 音声ループが解決後の最終応答まで再生し終えた。サーバー側は既に終端。 */
    fun onServiceFinished(requestId: String, callId: String) {
        scope.launch {
            val cur = current
            if (cur != null && cur.requestId == requestId && cur.callId == callId) {
                CallService.stop(context)
                cleanupCurrent(silently = true)
                regularNotifier.cancel(requestId)
                refreshQuietly(requestId)
            }
        }
    }

    /** 音声ループが継続不能でテキストに落とす (service は既に停止中)。 */
    fun onServiceFallback(requestId: String, callId: String, notice: String?, postFailedEvent: Boolean) {
        scope.launch {
            val cur = current
            if (cur != null && cur.requestId == requestId && cur.callId == callId) {
                cleanupCurrent(silently = true)
            }
            regularNotifier.cancel(requestId)
            if (postFailedEvent) {
                doFailed(requestId, callId, notice)
            } else {
                refreshAndFallback(requestId)
            }
        }
    }

    // ---- 内部 ----

    private fun publish(cur: ActiveCall) {
        _uiState.value = CallUiState(
            requestId = cur.requestId,
            callId = cur.callId,
            agentName = cur.agentName,
            question = cur.question,
            subject = cur.subject,
            state = cur.state,
            transcript = cur.transcript,
            lastReply = cur.lastReply,
            error = cur.error,
            voiceAvailable = isSpeechEnginePresent(),
            ringing = cur.state == CallState.RINGING,
            awaitingReply = voiceTurnRequestId == cur.requestId,
            canRetryVoice = cur.error != null && voiceTurnRequestId != cur.requestId &&
                (cur.needsResume || repository()?.state?.value?.draft(cur.requestId)?.let { it.voiceCallId == cur.callId && it.text.isNotBlank() } == true),
        )
    }

    private suspend fun refreshQuietly(requestId: String) {
        val client = api() ?: return
        try {
            repository()?.applyRequest(client.getRequest(requestId))
        } catch (e: RelayException) {
            if (e.isUnauthorized) repository()?.handleUnauthorized()
        }
    }

    companion object {
        const val TAG = "oyobidashi-call"

        /** 鳴動のローカルタイムアウト。relay 45s に対する保険で 55s。 */
        const val RING_TIMEOUT_MILLIS = 55_000L

        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_AGENT_NAME = "agent_name"
        const val EXTRA_QUESTION = "question"
    }
}
