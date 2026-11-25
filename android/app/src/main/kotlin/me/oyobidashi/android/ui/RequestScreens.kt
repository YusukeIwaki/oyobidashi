package me.oyobidashi.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import me.oyobidashi.android.R
import me.oyobidashi.android.Session
import me.oyobidashi.android.call.CallActivity
import me.oyobidashi.android.core.CallState
import me.oyobidashi.android.core.AnswerOutcome
import me.oyobidashi.android.core.InputMethod
import me.oyobidashi.android.core.ItemAnswerForm
import me.oyobidashi.android.core.ItemReply
import me.oyobidashi.android.core.ItemStatus
import me.oyobidashi.android.core.Priority
import me.oyobidashi.android.core.Request
import me.oyobidashi.android.core.RequestKind
import me.oyobidashi.android.core.Urgency
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AnswerSentScreen(requestId: String, onFinish: (String) -> Unit) {
    val accessibility = LocalAccessibilityManager.current
    LaunchedEffect(requestId) {
        delay(accessibility?.calculateRecommendedTimeoutMillis(
            originalTimeoutMillis = 1_200,
            containsIcons = true,
            containsText = true,
            containsControls = true,
        ) ?: 1_200)
        onFinish(requestId)
    }
    Scaffold(topBar = { TopAppBar(title = { Text("回答完了") }) }) { padding ->
        Column(
            modifier = Modifier.padding(padding).padding(24.dp).fillMaxSize()
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(Icons.Default.CheckCircle, contentDescription = null,
                tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(56.dp))
            Text("回答を送信しました", style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
            Text("未回答一覧に戻ります", style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            Button(onClick = { onFinish(requestId) }) { Text("未回答一覧へ") }
        }
    }
}

@Composable
internal fun UnreachableBanner() {
    Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
        Text(
            Texts.UNREACHABLE,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestDetailScreen(vm: MainViewModel, session: Session, requestId: String) {
    val repository = session.repository
    val state by repository.state.collectAsState()
    val request = state.find(requestId)
    val callUi by vm.graph.callManager.uiState.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // 項目別の回答は別端末や直前の通話でも更新される。
    LaunchedEffect(requestId) {
        val cached = repository.state.value.find(requestId)
        if (cached == null || cached.items != null) repository.refresh()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(request?.let { Texts.agentLabel(it) } ?: "質問", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = { vm.back() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).imePadding().fillMaxSize()) {
            if (state.relayUnreachable) UnreachableBanner()
            if (request == null) {
                Text(
                    if (state.refreshing) "読み込み中…" else "この質問は見つかりません",
                    Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                return@Column
            }
            Column(
                Modifier
                    .widthIn(max = 640.dp)
                    .align(Alignment.CenterHorizontally)
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                val meta = buildList {
                    add(Texts.time(request))
                    if (request.priority != Priority.NORMAL && request.priority != Priority.UNKNOWN) {
                        add("優先度: ${Texts.priorityLabel(request.priority)}")
                    } else if (request.urgency == Urgency.HIGH) add("至急")
                    Texts.deliveryLabel(request.deliveryMode)?.let { add(it) }
                }.filter { it.isNotEmpty() }.joinToString(" ・ ")
                if (meta.isNotEmpty()) {
                    Text(meta, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                // 通話バナー: 着信中は通話画面へ、フォールバックは注記。
                if (request.isItemAnswerHandoff) {
                    Text(
                        Texts.remainingQuestions,
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                } else if (request.isLiveCall) {
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                "通話着信中です",
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                            )
                            Button(onClick = {
                                val callId = request.call?.id.orEmpty()
                                context.startActivity(
                                    Intent(context, CallActivity::class.java)
                                        .setAction(CallActivity.ACTION_SHOW)
                                        .putExtra(CallActivity.EXTRA_REQUEST_ID, request.id)
                                        .putExtra(CallActivity.EXTRA_CALL_ID, callId)
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            }) { Text("通話を開く") }
                        }
                    }
                } else if (request.isCallFallback) {
                    val outcome = Texts.callOutcomeLabel(request.call?.outcome)
                    Text(
                        if (outcome != null) "${outcome}のため、テキストで回答してください" else "通話が終わったため、テキストで回答してください",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                SelectionContainer { Text(request.question, style = MaterialTheme.typography.titleLarge) }
                request.context?.takeIf { it.isNotBlank() }?.let { contextText ->
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        SelectionContainer { Text(contextText, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyMedium) }
                    }
                }
                // 通話の会話記録 (あれば)。
                request.call?.transcript?.takeIf { it.isNotEmpty() }?.let { transcript ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text("通話記録", style = MaterialTheme.typography.labelMedium)
                            transcript.forEach { entry ->
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

                state.answerErrors[requestId]?.let {
                    Text(Texts.answerError(it), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }

                if (request.items != null) {
                    ItemAnswersPanel(
                        request = request,
                        submitting = requestId in state.submitting,
                        unconfirmedSpeech = state.draft(requestId).takeIf {
                            it.dictated && !request.isLiveCall
                        }?.text.orEmpty(),
                        onSend = { replies -> scope.launch {
                            if (repository.submitItems(requestId, replies) is AnswerOutcome.Success) vm.answerSubmitted(requestId)
                        } },
                    )
                } else if (request.isAnswerable) {
                    AnswerForm(
                        request = request,
                        draftText = state.draft(requestId).text,
                        submitting = requestId in state.submitting,
                        onEdit = { repository.editDraft(requestId, it) },
                        onDictate = { repository.dictateDraft(requestId, it) },
                        onSend = { scope.launch {
                            if (repository.submitDraft(requestId) is AnswerOutcome.Success) vm.answerSubmitted(requestId)
                        } },
                        onChoice = { index -> scope.launch {
                            if (repository.submitChoice(requestId, index) is AnswerOutcome.Success) vm.answerSubmitted(requestId)
                        } },
                    )
                } else {
                    ResolvedSummary(request)
                }
                // 通話中 (別リクエストの通話) の注意。誤って二重対応しないよう。
                val otherCall = callUi?.takeIf { it.requestId != requestId && (it.state == CallState.RINGING || it.state == CallState.ACTIVE) }
                otherCall?.let {
                    Text(
                        "別の通話に対応中です",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun ItemAnswersPanel(
    request: Request,
    submitting: Boolean,
    unconfirmedSpeech: String,
    onSend: (List<ItemReply>) -> Unit,
) {
    var drafts by remember(request.id) { mutableStateOf<Map<String, ItemReply>>(emptyMap()) }
    val form = ItemAnswerForm(request, drafts)
    form.rows.forEach { row ->
        val item = row.item
        val answer = row.answer
        val draft = drafts[item.id]
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(item.question, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                item.context?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodyMedium) } }
                when {
                    answer?.status == ItemStatus.ANSWERED -> {
                        if (answer.inputMethod == InputMethod.VOICE && request.isAnswerable) {
                            Text("通話で回答済み", style = MaterialTheme.typography.labelMedium)
                        }
                        SelectionContainer { Text(answer.text.orEmpty()) }
                    }
                    answer?.status == ItemStatus.NOT_APPLICABLE -> Text("対象外")
                    request.isAnswerable -> {
                        if (answer?.status == ItemStatus.DEFERRED) {
                            Text("通話で保留", style = MaterialTheme.typography.labelMedium)
                        }
                        if (!item.choices.isNullOrEmpty()) {
                            item.choices.orEmpty().forEachIndexed { index, label ->
                                FilterChip(
                                    selected = draft?.choiceIndex == index,
                                    enabled = !submitting,
                                    onClick = { drafts = drafts + (item.id to ItemReply(item.id, choiceIndex = index)) },
                                    label = { Text(label) },
                                )
                            }
                        } else {
                            OutlinedTextField(
                                value = draft?.text.orEmpty(),
                                onValueChange = { drafts = drafts + (item.id to ItemReply(item.id, text = it)) },
                                label = { Text("回答を入力") },
                                enabled = !submitting,
                                minLines = 2,
                                modifier = Modifier.fillMaxWidth(),
                                isError = (draft?.text?.length ?: 0) > ItemReply.MAX_TEXT_LENGTH,
                                supportingText = if ((draft?.text?.length ?: 0) > ItemReply.MAX_TEXT_LENGTH) {
                                    { Text("回答は${ItemReply.MAX_TEXT_LENGTH}文字以内で入力してください") }
                                } else null,
                            )
                        }
                    }
                }
            }
        }
    }
    if (request.isAnswerable) {
        if (unconfirmedSpeech.isNotBlank()) {
            Text("送信が確定していない音声入力", style = MaterialTheme.typography.labelMedium)
            SelectionContainer { Text(unconfirmedSpeech, style = MaterialTheme.typography.bodyMedium) }
        }
        Button(
            enabled = form.replies != null && !submitting,
            onClick = { form.replies?.let(onSend) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (submitting) "送信中…" else "回答を送信") }
    }
}

@Composable
private fun ResolvedSummary(request: Request) {
    if (request.kind != RequestKind.QUESTION) return
    Text(Texts.status(request), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.primary)
    request.answer?.let { answer ->
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val how = when (answer.inputMethod) {
                    InputMethod.VOICE -> "音声入力"
                    InputMethod.CHOICE -> "選択肢"
                    InputMethod.TEXT -> "テキスト"
                    InputMethod.UNKNOWN -> ""
                }
                if (how.isNotEmpty()) {
                    Text(how, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                SelectionContainer { Text(answer.text, style = MaterialTheme.typography.bodyLarge) }
            }
        }
    }
}

@Composable
private fun AnswerForm(
    request: Request,
    draftText: String,
    submitting: Boolean,
    onEdit: (String) -> Unit,
    onDictate: (String) -> Unit,
    onSend: () -> Unit,
    onChoice: (Int) -> Unit,
) {
    val context = LocalContext.current
    // Keep IME edits synchronous; a StateFlow collector may conflate rapid key/paste updates.
    var editorText by remember(request.id) { mutableStateOf(draftText) }
    var editorFocused by remember(request.id) { mutableStateOf(false) }
    LaunchedEffect(draftText, editorFocused) {
        if (!editorFocused && editorText != draftText) editorText = draftText
    }
    val voice = remember(request.id) { VoiceInput(context) }
    DisposableEffect(voice) { onDispose { voice.destroy() } }
    var voiceMessage by remember(request.id) { mutableStateOf<String?>(null) }

    fun startVoice() {
        voiceMessage = null
        // 認識結果は、開始時点で入力済みのテキストの後ろに追記する
        val base = editorText
        voice.start(
            onText = { spoken ->
                if (spoken.isNotEmpty()) {
                    val text = if (base.isBlank()) spoken else base.trimEnd() + " " + spoken
                    editorText = text
                    onDictate(text)
                }
            },
            onError = { voiceMessage = it },
        )
    }

    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startVoice() else voiceMessage = "マイクの権限がありません。端末の設定で許可してください"
    }

    // 通話モードの着信中は選択肢・テキストを隠さない (テキストでも回答できるよう残す)。
    // ただし通話着信中は回答より通話を促す注記を出す (上のバナー)。
    Text("回答", Modifier.padding(top = 8.dp).semantics { heading() },
        style = MaterialTheme.typography.titleMedium)
    if (!request.choices.isNullOrEmpty()) {
        Text("選択肢をタップすると回答を送信します", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    request.choices.orEmpty().forEachIndexed { index, choice ->
        FilledTonalButton(onClick = { onChoice(index) }, enabled = !submitting, modifier = Modifier.fillMaxWidth()) {
            Text(choice)
        }
    }

    OutlinedTextField(
        value = editorText,
        onValueChange = { editorText = it; onEdit(it) },
        label = { Text(if (voice.listening) "聞き取り中…" else "回答を入力") },
        enabled = !submitting,
        minLines = 3,
        modifier = Modifier.fillMaxWidth().onFocusChanged { editorFocused = it.isFocused },
    )
    voiceMessage?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }

    Row(verticalAlignment = Alignment.CenterVertically) {
        FilledTonalIconButton(
            onClick = {
                when {
                    voice.listening -> voice.stop()
                    !voice.available -> voiceMessage = "この端末では音声入力を利用できません"
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED -> startVoice()
                    else -> micPermission.launch(Manifest.permission.RECORD_AUDIO)
                }
            },
            enabled = !submitting,
            colors = if (voice.listening) {
                IconButtonDefaults.filledTonalIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                )
            } else {
                IconButtonDefaults.filledTonalIconButtonColors()
            },
        ) {
            Icon(painterResource(R.drawable.ic_mic), contentDescription = if (voice.listening) "音声入力を停止" else "音声入力")
        }
        Spacer(Modifier.width(12.dp))
        Button(
            onClick = {
                voice.stop()
                onSend()
            },
            enabled = !submitting && draftText.isNotBlank(),
            modifier = Modifier.weight(1f),
        ) { Text(if (submitting) "送信中…" else "送信") }
    }
}
