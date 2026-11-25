package me.oyobidashi.android.call

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.withResumed
import me.oyobidashi.android.core.CallState
import me.oyobidashi.android.graph
import me.oyobidashi.android.ui.MainActivity
import me.oyobidashi.android.ui.OyobidashiTheme
import me.oyobidashi.android.ui.Texts
import me.oyobidashi.android.core.VoiceRecipient

/**
 * 着信・通話中の全画面 UI。CallStyle 通知の応答・拒否・フルスクリーンから開く。
 * 応答はマイク権限を確認してから [CallManager.answer] する。
 */
class CallActivity : ComponentActivity() {
    private data class PendingAnswer(val requestId: String, val callId: String, val acceptedProvider: String?)
    private var pendingAnswer: PendingAnswer? = null
    private var displayedRequestId by mutableStateOf("")
    private var displayedCallId by mutableStateOf("")

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val pending = pendingAnswer
        pendingAnswer = null
        if (granted && pending != null) {
            graph.callManager.answer(pending.requestId, pending.callId, pending.acceptedProvider)
        } else if (pending != null) {
            graph.callManager.onServiceError(pending.requestId, pending.callId, "通話にはマイクの権限が必要です")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // ロック画面でも着信を表示する。
        @Suppress("DEPRECATION")
        window.addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
        )
        updateDisplayedCall(intent)
        if (savedInstanceState == null) handleIntent(intent)

        setContent {
            OyobidashiTheme {
                CallScreen(
                    requestId = displayedRequestId,
                    callId = displayedCallId,
                    onAnswer = { r, c, provider -> requestAnswer(r, c, provider) },
                    onDecline = { r, c ->
                        graph.callManager.decline(r, c)
                        finish()
                    },
                    onHangup = { r, c ->
                        graph.callManager.hangup(r, c)
                        finish()
                    },
                    onRetry = { r, c -> graph.callManager.retryVoice(r, c) },
                    onOpenDetail = { r ->
                        openDetail(r)
                        finish()
                    },
                    onClose = { finish() },
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        graph.setCallScreenVisible(true)
    }

    override fun onStop() {
        graph.setCallScreenVisible(false)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        updateDisplayedCall(intent)
        handleIntent(intent)
    }

    private fun updateDisplayedCall(intent: Intent?) {
        // Notification actions reuse this Activity while the preceding call's end screen remains.
        displayedRequestId = intent?.getStringExtra(EXTRA_REQUEST_ID).orEmpty()
        displayedCallId = intent?.getStringExtra(EXTRA_CALL_ID).orEmpty()
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val reqId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return
        val cId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
        when (intent.action) {
            ACTION_ANSWER -> requestAnswer(reqId, cId)
            ACTION_DECLINE -> {
                graph.callManager.decline(reqId, cId)
                finish()
            }
            ACTION_HANGUP -> {
                graph.callManager.hangup(reqId, cId)
                finish()
            }
            ACTION_SHOW -> Unit // UI を見るだけ
        }
    }

    private fun requestAnswer(reqId: String, callId: String, acceptedProvider: String? = null) {
        val state = graph.callManager.uiState.value?.takeIf { it.requestId == reqId && it.callId == callId }
        if (state?.voiceConsentRequired == true && acceptedProvider != state.voiceProvider) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            graph.callManager.answer(reqId, callId, acceptedProvider)
        } else {
            pendingAnswer = PendingAnswer(reqId, callId, acceptedProvider)
            micPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun openDetail(requestId: String) {
        val intent = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_REQUEST)
            .setData(Uri.parse("oyobidashi-request://open/${Uri.encode(requestId)}"))
            .putExtra(MainActivity.EXTRA_REQUEST_ID, requestId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        startActivity(intent)
    }

    companion object {
        const val ACTION_ANSWER = "me.oyobidashi.android.call.action.ANSWER"
        const val ACTION_DECLINE = "me.oyobidashi.android.call.action.DECLINE"
        const val ACTION_HANGUP = "me.oyobidashi.android.call.action.HANGUP"
        const val ACTION_SHOW = "me.oyobidashi.android.call.action.SHOW"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_CALL_ID = "call_id"
    }
}

@Composable
private fun CallScreen(
    requestId: String,
    callId: String,
    onAnswer: (String, String, String?) -> Unit,
    onDecline: (String, String) -> Unit,
    onHangup: (String, String) -> Unit,
    onRetry: (String, String) -> Unit,
    onOpenDetail: (String) -> Unit,
    onClose: () -> Unit,
) {
    val graph = androidx.compose.ui.platform.LocalContext.current.graph
    val ui by graph.callManager.uiState.collectAsState()
    val state = ui?.takeIf { it.requestId == requestId && (callId.isEmpty() || it.callId == callId) }
    val handoff = state?.takeIf { it.handoffToAnswer }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(handoff?.requestId, handoff?.callId) {
        if (handoff != null) {
            lifecycle.withResumed {
                val latest = graph.callManager.uiState.value
                if (latest?.handoffToAnswer == true && latest.callId == handoff.callId) {
                    onOpenDetail(handoff.requestId)
                }
            }
        }
    }

    Scaffold { padding ->
        Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            Column(
                modifier = Modifier.widthIn(max = 640.dp).fillMaxSize()
                    .verticalScroll(rememberScrollState()).padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (handoff != null) {
                    Text(Texts.remainingQuestions, style = MaterialTheme.typography.titleMedium)
                    return@Column
                }
                if (state == null) {
                    Text(
                        "この通話は既に応答・終了しているか、他の端末で対応されました。" +
                            "質問が残っている場合はテキストで回答できます。",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = { onOpenDetail(requestId) }, modifier = Modifier.fillMaxWidth()) {
                        Text("質問を開く")
                    }
                    OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) {
                        Text("閉じる")
                    }
                    return@Column
                }
                val title = state.agentName?.takeIf { it.isNotBlank() }?.let { "$it からの通話" } ?: "エージェントからの通話"
                Text(title, style = MaterialTheme.typography.headlineSmall)
                state.subject?.takeIf { it.isNotBlank() }?.let { subject ->
                    Text(
                        subject,
                        modifier = Modifier.fillMaxWidth(),
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                ) {
                    Text(state.question, Modifier.padding(16.dp), style = MaterialTheme.typography.bodyLarge)
                }
                if (!state.voiceAvailable) {
                    Text(
                        "この端末では音声通話を利用できません。テキストで回答してください。",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(onClick = { onOpenDetail(requestId) }, modifier = Modifier.fillMaxWidth()) {
                        Text("テキストで回答する")
                    }
                    OutlinedButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) {
                        Text("閉じる")
                    }
                    return@Column
                }
                if (state.voiceProvider == "anthropic-linked") {
                    Text(
                        "通話の文字起こしと質問はAnthropicに送信されます。Claude APIの利用分は連携した組織に請求されます。",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                val recipient = VoiceRecipient.fromProvider(state.voiceProvider)
                if (recipient != null) {
                    Text(
                        if (state.voiceConsentRequired)
                            recipient.disclosure
                        else "送信先  ${recipient.displayName}",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                state.error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
                if (state.ringing) {
                    Text("着信中…", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(8.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                        Button(
                            onClick = { onAnswer(state.requestId, state.callId, recipient?.provider) },
                            modifier = Modifier.weight(1f),
                        ) { Text(if (state.voiceConsentRequired) "同意して応答" else "応答") }
                        OutlinedButton(
                            onClick = { onDecline(state.requestId, state.callId) },
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        ) { Text("拒否") }
                    }
                    OutlinedButton(onClick = { onOpenDetail(requestId) }, modifier = Modifier.fillMaxWidth()) {
                        Text("テキストで見る")
                    }
                } else if (state.state == CallState.ACTIVE) {
                    Text(
                        if (state.awaitingReply) "応答を準備しています…" else "通話中…",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    if (state.canRetryVoice) {
                        Button(onClick = { onRetry(state.requestId, state.callId) }, modifier = Modifier.fillMaxWidth()) {
                            Text("通話を再開")
                        }
                    }
                    state.lastReply?.takeIf { reply ->
                        reply.isNotBlank() && state.transcript.none { it.text == reply }
                    }?.let { reply ->
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("エージェント", style = MaterialTheme.typography.labelMedium)
                                Text(reply, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }
                    if (state.transcript.isNotEmpty()) {
                        Card(modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text("会話", style = MaterialTheme.typography.labelMedium)
                                state.transcript.takeLast(6).forEach { entry ->
                                    val who = when (entry.role.name) {
                                        "USER" -> "あなた"
                                        "ASSISTANT" -> "エージェント"
                                        else -> ""
                                    }
                                    Text(
                                        if (who.isNotEmpty()) "$who: ${entry.text}" else entry.text,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                }
                            }
                        }
                    }
                    Button(
                        onClick = { onHangup(state.requestId, state.callId) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                    ) { Text("切断") }
                    FilledTonalButton(onClick = { onOpenDetail(requestId) }, modifier = Modifier.fillMaxWidth()) {
                        Text("テキストで回答する")
                    }
                }
            }
        }
    }
}
