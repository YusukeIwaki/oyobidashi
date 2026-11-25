package me.oyobidashi.android.call

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import me.oyobidashi.android.core.CallEvent
import me.oyobidashi.android.core.CallEventBody
import me.oyobidashi.android.core.CallResponse
import me.oyobidashi.android.core.CallRole
import me.oyobidashi.android.core.CallTranscriptEntry
import me.oyobidashi.android.core.RelayException
import me.oyobidashi.android.core.ErrorCode
import me.oyobidashi.android.core.VoiceRetryGate
import me.oyobidashi.android.graph
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume

/**
 * 通話中のフォアグラウンド service。オンデバイスの TextToSpeech + SpeechRecognizer で
 * 「話す → 聞く → POST turn → 応答を話す → 繰り返し」のループを回す。
 *
 * - 部分結果 (onPartialResults) は送信しない。確定結果 (onResults) のみ POST する。
 * - SpeechRecognizer/TTS はメインスレッドで作り・使い・捨てる。
 * - 解決 (resolved=true) したら最終応答を話し終えてから終わる。
 * - 音声エンジンが無い端末では正直にテキストへ落とす (黙って成功にしない)。
 */
class CallService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var loopJob: Job? = null
    private val retryGate = VoiceRetryGate()
    private var tts: TextToSpeech? = null
    private var recognizer: SpeechRecognizer? = null
    private var ttsReady: Boolean = false

    private var requestId: String? = null
    private var callId: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // TTS はここでは作らない。start 時に作り、destroy 時に捨てる (リーク防止)。
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val reqId = intent?.getStringExtra(EXTRA_REQUEST_ID)
        val cId = intent?.getStringExtra(EXTRA_CALL_ID)
        val initial = intent?.getStringExtra(EXTRA_INITIAL_REPLY)
        if (reqId.isNullOrEmpty() || cId.isNullOrEmpty()) {
            Log.w(CallManager.TAG, "CallService started without ids; stopping")
            stopSelf()
            return START_NOT_STICKY
        }
        // 二重起動は無視 (同一 call)。
        if (loopJob?.isActive == true && requestId == reqId && callId == cId) {
            if (intent.action == ACTION_RETRY) retryGate.retry()
            return START_STICKY
        }
        requestId = reqId
        callId = cId

        // フォアグラウンド化 (Android 14: phoneCall タイプ。10秒以内の startForeground が必須)。
        val graph = applicationContext.graph
        val session = graph.session.value
        val req = session?.repository?.state?.value?.find(reqId)
        val notification = CallNotifications.ongoingNotification(
            this, reqId, cId, req?.agent?.name, initial ?: req?.question.orEmpty(),
        )
        try {
            ServiceCompat.startForeground(
                this, CallNotifications.ONGOING_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } catch (e: RuntimeException) {
            // フォアグラウンド化できない (権限無し等)。テキストに落とす。
            Log.w(CallManager.TAG, "startForeground failed", e)
            graph.callManager.onServiceFallback(reqId, cId, "通話を開始できませんでした", postFailedEvent = true)
            stopSelf()
            return START_NOT_STICKY
        } catch (e: SecurityException) {
            Log.w(CallManager.TAG, "startForeground denied", e)
            graph.callManager.onServiceFallback(reqId, cId, "通話を開始できませんでした", postFailedEvent = true)
            stopSelf()
            return START_NOT_STICKY
        }

        loopJob?.cancel()
        loopJob = scope.launch {
            runVoiceLoop(reqId, cId, initial ?: req?.question.orEmpty())
        }
        return START_STICKY
    }

    override fun onDestroy() {
        loopJob?.cancel()
        loopJob = null
        destroyVoiceEngines()
        scope.cancel()
        super.onDestroy()
    }

    // ---- 音声ループ ----

    private suspend fun runVoiceLoop(reqId: String, cId: String, initialReply: String) {
        val graph = applicationContext.graph
        // エンジン確認 (認識)。TTS は初期化時に確認する。
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            graph.callManager.onServiceFallback(
                reqId, cId, "この端末では音声認識を利用できません", postFailedEvent = true,
            )
            stopSelf()
            return
        }
        if (!initTts()) {
            graph.callManager.onServiceFallback(
                reqId, cId, "この端末では音声合成を利用できません", postFailedEvent = true,
            )
            stopSelf()
            return
        }
        val request = graph.session.value?.repository?.state?.value?.find(reqId)
        val saved = graph.session.value?.repository?.state?.value?.draft(reqId)
        val pending = request?.call?.takeIf { it.id == cId }?.turn?.takeIf { it.isPending }
        val persistedText = saved?.takeIf { it.voiceCallId == cId && it.dictated && it.text.isNotBlank() }?.text
        val snapshotText = request?.call?.transcript?.lastOrNull()?.takeIf { it.role == CallRole.USER }?.text
        var recoveryText = persistedText ?: snapshotText?.takeIf { pending != null }
        val transcript = request?.call?.transcript?.toMutableList() ?: mutableListOf()
        var reply: String? = request?.call?.transcript?.lastOrNull()
            ?.takeIf { it.role == CallRole.ASSISTANT }?.text?.takeIf { it.isNotBlank() }
            ?: initialReply.takeIf { it.isNotBlank() }
        // 初回質問を話す。
        if (reply != null && recoveryText == null) {
            if (transcript.lastOrNull()?.text != reply) transcript += CallTranscriptEntry(CallRole.ASSISTANT, reply)
            graph.callManager.onTurnProgress(reqId, cId, transcript.toList(), reply)
            if (!speak(reply)) {
                graph.callManager.onServiceFallback(reqId, cId, "音声の再生に失敗しました", postFailedEvent = true)
                stopSelf()
                return
            }
        }
        while (true) {
            // 聞く (リトライ付き)。
            // プロセス再起動・再接続後は確定済みの発話を同じ ID で回収する。
            val recovering = recoveryText != null
            val heard = recoveryText?.also { recoveryText = null } ?: listenWithRetries(reqId, cId)
            if (heard == null) {
                // listenWithRetries がフォールバック済み or キャンセル。
                if (loopJob?.isActive != true) return // hangup 等で止められた
                graph.callManager.onServiceFallback(reqId, cId, "音声を認識できませんでした", postFailedEvent = true)
                stopSelf()
                return
            }
            if (!recovering || transcript.lastOrNull()?.text != heard) transcript += CallTranscriptEntry(CallRole.USER, heard)
            graph.callManager.onTurnProgress(reqId, cId, transcript.toList(), reply)
            // POST turn。
            val res = postTurn(reqId, cId, heard, pending?.id?.takeIf { recovering })
            if (res == null) {
                // 発話を残したまま、ユーザーの再試行・テキスト切り替え・切断を待つ。
                // 認識を再開せず、同じ発話を勝手に再送しない。
                if (loopJob?.isActive != true) return
                if (graph.session.value == null) { stopSelf(); return }
                retryGate.awaitRetry()
                recoveryText = heard
                continue
            }
            // サーバー側 transcript があれば使う。
            val serverTranscript = res.call?.transcript
            if (!serverTranscript.isNullOrEmpty()) {
                transcript.clear()
                transcript.addAll(serverTranscript)
            }
            val nextReply = res.reply?.takeIf { it.isNotBlank() }
            if (res.isResolved || res.endCall == true) {
                // 最終応答を読み上げてから、通話を閉じる。
                if (nextReply != null) {
                    // サーバー transcript に最終応答が含まれていない場合の保険で足す。
                    if (transcript.lastOrNull()?.text != nextReply) {
                        transcript += CallTranscriptEntry(CallRole.ASSISTANT, nextReply)
                    }
                    graph.callManager.onTurnProgress(reqId, cId, transcript.toList(), nextReply)
                    speak(nextReply) // 読み上げに失敗しても通話終了へ進む。
                }
                if (res.isResolved) graph.callManager.onServiceFinished(reqId, cId)
                else graph.callManager.onServiceHandoff(reqId, cId)
                stopSelf()
                return
            }
            if (nextReply != null) {
                if (transcript.lastOrNull()?.text != nextReply) {
                    transcript += CallTranscriptEntry(CallRole.ASSISTANT, nextReply)
                }
                reply = nextReply
                graph.callManager.onTurnProgress(reqId, cId, transcript.toList(), reply)
                if (!speak(nextReply)) {
                    graph.callManager.onServiceFallback(reqId, cId, "音声の再生に失敗しました", postFailedEvent = true)
                    stopSelf()
                    return
                }
            } else {
                // 応答文なし・未解決。続けて聞く。
                reply = null
                graph.callManager.onTurnProgress(reqId, cId, transcript.toList(), null)
            }
        }
    }

    /** turn を POST する。成功すれば応答、失敗すれば null (下書き保存・状態反映は内部で行う)。 */
    private suspend fun postTurn(reqId: String, cId: String, text: String, recoveredTurnId: String? = null): CallResponse? {
        val graph = applicationContext.graph
        val client = graph.session.value?.api
        if (client == null) {
            graph.callManager.onServiceError(reqId, cId, "ペアリングが解除されています")
            return null
        }
        // 認識済みの発話は送信前に保存する。HTTP 待機中の中断でも失わない。
        val body = graph.session.value?.repository?.beginVoiceTurn(reqId, cId, text, recoveredTurnId)
            ?: CallEventBody(CallEvent.TURN, text, turnId = UUID.randomUUID().toString(), async = true)
        graph.callManager.beginVoiceTurn(reqId)
        var guardReleased = false
        return try {
            graph.session.value?.repository?.flushVoiceDraft(body.turnId)
            val provider = graph.callManager.consentedVoiceProvider(reqId, cId)
            val res = client.postCall(reqId, body.copy(voiceProvider = provider))
            graph.callManager.finishVoiceTurn(reqId, res.isResolved)
            guardReleased = true
            graph.session.value?.repository?.completeVoiceTurn(reqId, body.turnId)
            graph.session.value?.repository?.applyRequest(res.request)
            res
        } catch (e: RelayException) {
            if (e is RelayException.VoiceTurn && e.state == "failed" ||
                e is RelayException.Api && e.rawCode in listOf("conversation_failed", "voice_unavailable")
            ) graph.session.value?.repository?.failVoiceTurn(reqId, body.turnId)
            when {
                e.isUnauthorized -> {
                    graph.session.value?.repository?.handleUnauthorized()
                    null
                }
                e is RelayException.VoiceTurn && e.state == "cancelled" ||
                    e is RelayException.Api && e.code in listOf(ErrorCode.CALL_ENDED, ErrorCode.CALL_CLAIMED, ErrorCode.VOICE_HANDOFF) -> {
                    try {
                        graph.session.value?.repository?.applyRequest(client.getRequest(reqId))
                    } catch (_: RelayException) { }
                    graph.callManager.onServiceFallback(reqId, cId, "通話は終了しました。テキストで返信できます", postFailedEvent = false)
                    stopSelf()
                    null
                }
                e.isAlreadyResolved -> {
                    // 他所で解決済み。最新を取り直して終わらせる。
                    try {
                        graph.session.value?.repository?.applyRequest(client.getRequest(reqId))
                    } catch (ignored: RelayException) {
                    }
                    // 最新状態を確認できない場合や pending の競合を成功扱いしない。
                    val latest = graph.session.value?.repository?.state?.value?.find(reqId)
                    if (latest?.status == me.oyobidashi.android.core.RequestStatus.ANSWERED) {
                        CallResponse(latest, null, null, true)
                    } else null
                }
                e is RelayException.Network -> {
                    // 圏外。下書きに残してテキストへ。
                    graph.callManager.onServiceError(reqId, cId, "中継サーバーに接続できません")
                    null
                }
                else -> {
                    // 会話プロバイダの失敗等 (5xx)。リトライ余地を残すため null だが、下書きは残す。
                    graph.callManager.onServiceError(reqId, cId, "応答を取得できませんでした。テキストで返信できます")
                    null
                }
            }
        } finally {
            // コルーチンのキャンセルでも、次の通話に古い in-flight ガードを残さない。
            if (!guardReleased) graph.callManager.finishVoiceTurn(reqId, false)
        }
    }

    /** 聞き取り (最大3回)。確定結果のみ返す。部分結果は捨てる。 */
    private suspend fun listenWithRetries(reqId: String, cId: String): String? {
        repeat(MAX_LISTEN_ATTEMPTS) { attempt ->
            val heard = listenOnce()
            if (heard != null && heard.isNotBlank()) return heard.trim()
            if (loopJob?.isActive != true) return null // 中断
            if (attempt + 1 < MAX_LISTEN_ATTEMPTS) {
                // 聞き直しを促す。
                speak("聞き取れませんでした。もう一度お願いします")
            }
        }
        return null
    }

    // ---- TTS ----

    /** TTS を初期化する。成功すれば true。 */
    private suspend fun initTts(): Boolean = suspendCancellableCoroutine { cont ->
        // 既存があれば使い回す。
        if (ttsReady && tts != null) {
            if (cont.isActive) cont.resume(true)
            return@suspendCancellableCoroutine
        }
        try {
            val engine = TextToSpeech(this) { status ->
                mainHandler.post {
                    if (status != TextToSpeech.SUCCESS) {
                        Log.w(CallManager.TAG, "tts init failed: $status")
                        if (cont.isActive) cont.resume(false)
                        return@post
                    }
                    val t = tts
                    if (t == null) {
                        if (cont.isActive) cont.resume(false)
                        return@post
                    }
                    // 日本語を優先し、無ければ既定ロケール。
                    var langResult = t.setLanguage(Locale.JAPANESE)
                    if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                        langResult = t.setLanguage(Locale.getDefault())
                    }
                    if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                        Log.w(CallManager.TAG, "tts lang not supported: $langResult")
                        if (cont.isActive) cont.resume(false)
                        return@post
                    }
                    t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(utteranceId: String?) {}
                        override fun onDone(utteranceId: String?) {
                            mainHandler.post { pendingUtterance.remove(utteranceId)?.resume(true) }
                        }

                        override fun onError(utteranceId: String?) {
                            mainHandler.post { pendingUtterance.remove(utteranceId)?.resume(false) }
                        }

                        @Deprecated("Deprecated in Java")
                        override fun onError(utteranceId: String?, errorCode: Int) {
                            onError(utteranceId)
                        }
                    })
                    t.setAudioAttributes(android.media.AudioAttributes.Builder()
                        .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build())
                    // 端末の読み上げ速度設定に対する倍率。iOS の `speechRate` と揃える。
                    t.setSpeechRate(SPEECH_RATE)
                    ttsReady = true
                    if (cont.isActive) cont.resume(true)
                }
            }
            tts = engine
            cont.invokeOnCancellation {
                mainHandler.post {
                    try {
                        engine.stop()
                    } catch (ignored: RuntimeException) {
                    }
                }
            }
        } catch (e: RuntimeException) {
            Log.w(CallManager.TAG, "tts create failed", e)
            if (cont.isActive) cont.resume(false)
        }
    }

    private val pendingUtterance = mutableMapOf<String, kotlin.coroutines.Continuation<Boolean>>()

    /** 1件話す。完了すれば true。 */
    private suspend fun speak(text: String): Boolean = suspendCancellableCoroutine { cont ->
        val t = tts
        if (t == null || !ttsReady) {
            if (cont.isActive) cont.resume(false)
            return@suspendCancellableCoroutine
        }
        val id = UUID.randomUUID().toString()
        pendingUtterance[id] = cont
        cont.invokeOnCancellation {
            mainHandler.post {
                pendingUtterance.remove(id)
                try {
                    t.stop()
                } catch (ignored: RuntimeException) {
                }
            }
        }
        mainHandler.post {
            try {
                val params = Bundle().apply {
                    putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id)
                }
                val result = t.speak(text, TextToSpeech.QUEUE_FLUSH, params, id)
                if (result != TextToSpeech.SUCCESS) {
                    pendingUtterance.remove(id)
                    if (cont.isActive) cont.resume(false)
                }
                // 完了は UtteranceProgressListener で resume する。
            } catch (e: RuntimeException) {
                pendingUtterance.remove(id)
                if (cont.isActive) cont.resume(false)
            }
        }
    }

    // ---- STT ----

    /** 1回聞く。確定結果のみ。失敗・取消なら null。部分結果は捨てる。 */
    private suspend fun listenOnce(): String? = suspendCancellableCoroutine { cont ->
        // メインスレッドで作る・使う。
        val run = listen@{
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                if (cont.isActive) cont.resume(null)
                return@listen
            }
            val sr = try {
                recognizer ?: SpeechRecognizer.createSpeechRecognizer(this).also { recognizer = it }
            } catch (e: RuntimeException) {
                Log.w(CallManager.TAG, "recognizer create failed", e)
                if (cont.isActive) cont.resume(null)
                return@listen
            }
            sr.setRecognitionListener(object : RecognitionListener {
                override fun onPartialResults(partialResults: Bundle?) {
                    // 部分結果は送信しない。捨てる。
                }

                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                        ?.firstOrNull { it.isNotBlank() }
                    if (cont.isActive) cont.resume(text?.trim())
                }

                override fun onError(error: Int) {
                    Log.i(CallManager.TAG, "recognizer error: $error")
                    if (cont.isActive) cont.resume(null)
                }

                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            val intent = android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.JAPANESE.toLanguageTag())
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
            cont.invokeOnCancellation {
                mainHandler.post {
                    try {
                        sr.cancel()
                    } catch (ignored: RuntimeException) {
                    }
                }
            }
            try {
                sr.startListening(intent)
            } catch (e: RuntimeException) {
                Log.w(CallManager.TAG, "startListening failed", e)
                if (cont.isActive) cont.resume(null)
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run() else mainHandler.post(run)
    }

    private fun destroyVoiceEngines() {
        val t = tts
        tts = null
        ttsReady = false
        pendingUtterance.clear()
        mainHandler.post {
            try {
                t?.stop()
            } catch (ignored: RuntimeException) {
            }
            try {
                t?.shutdown()
            } catch (ignored: RuntimeException) {
            }
            try {
                recognizer?.cancel()
            } catch (ignored: RuntimeException) {
            }
            try {
                recognizer?.destroy()
            } catch (ignored: RuntimeException) {
            }
            recognizer = null
        }
    }

    companion object {
        const val ACTION_START = "me.oyobidashi.android.call.action.START"
        const val ACTION_STOP = "me.oyobidashi.android.call.action.STOP"
        const val ACTION_RETRY = "me.oyobidashi.android.call.action.RETRY"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_INITIAL_REPLY = "initial_reply"

        const val MAX_LISTEN_ATTEMPTS = 3

        /** 読み上げ速度の倍率 (1.0 が端末設定どおり)。 */
        const val SPEECH_RATE = 1.5f

        fun start(context: Context, requestId: String, callId: String, initialReply: String) {
            startWithAction(context, requestId, callId, initialReply, ACTION_START)
        }

        fun retry(context: Context, requestId: String, callId: String, initialReply: String) {
            startWithAction(context, requestId, callId, initialReply, ACTION_RETRY)
        }

        private fun startWithAction(context: Context, requestId: String, callId: String, initialReply: String, action: String) {
            val intent = Intent(context, CallService::class.java)
                .setAction(action)
                .putExtra(EXTRA_REQUEST_ID, requestId)
                .putExtra(EXTRA_CALL_ID, callId)
                .putExtra(EXTRA_INITIAL_REPLY, initialReply)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: RuntimeException) {
                Log.w(CallManager.TAG, "startForegroundService failed", e)
                context.applicationContext.graph.callManager
                    .onServiceFallback(requestId, callId, "通話を開始できませんでした", postFailedEvent = true)
            } catch (e: SecurityException) {
                Log.w(CallManager.TAG, "startForegroundService denied", e)
                context.applicationContext.graph.callManager
                    .onServiceFallback(requestId, callId, "通話を開始できませんでした", postFailedEvent = true)
            }
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, CallService::class.java).setAction(ACTION_STOP))
            } catch (e: RuntimeException) {
                Unit
            }
        }
    }
}
