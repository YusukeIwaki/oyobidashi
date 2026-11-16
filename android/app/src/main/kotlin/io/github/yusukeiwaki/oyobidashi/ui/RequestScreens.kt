package io.github.yusukeiwaki.oyobidashi.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import io.github.yusukeiwaki.oyobidashi.R
import io.github.yusukeiwaki.oyobidashi.Session
import io.github.yusukeiwaki.oyobidashi.call.CallActivity
import io.github.yusukeiwaki.oyobidashi.core.Availability
import io.github.yusukeiwaki.oyobidashi.core.CallState
import io.github.yusukeiwaki.oyobidashi.core.DeliveryMode
import io.github.yusukeiwaki.oyobidashi.core.InputMethod
import io.github.yusukeiwaki.oyobidashi.core.Priority
import io.github.yusukeiwaki.oyobidashi.core.Request
import io.github.yusukeiwaki.oyobidashi.core.RequestKind
import io.github.yusukeiwaki.oyobidashi.core.Urgency
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.temporal.ChronoUnit

@Composable
private fun UnreachableBanner() {
    Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
        Text(
            Texts.UNREACHABLE,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            color = MaterialTheme.colorScheme.onErrorContainer,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun AvailabilityRow(vm: MainViewModel) {
    val presence by vm.graph.presence.collectAsState()
    val current = presence.effectiveAvailability
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("あなたの状態", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp, bottom = 6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(Availability.AVAILABLE, Availability.BUSY, Availability.AWAY).forEach { a ->
                FilterChip(
                    selected = current == a,
                    onClick = {
                        when (a) {
                            Availability.BUSY -> vm.graph.setPresence(
                                Availability.BUSY,
                                Instant.now().plus(30, ChronoUnit.MINUTES).toString(),
                            )
                            else -> vm.graph.setPresence(a)
                        }
                    },
                    label = { Text(Texts.availabilityLabel(a)) },
                )
            }
        }
        if (current == Availability.BUSY) {
            Texts.clock(presence.until).takeIf { it.isNotEmpty() }?.let {
                Text("$it まで取り込み中", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        val explanation = when (current) {
            Availability.BUSY -> "取り込み中は、通話の代わりに文字で連絡が届きます"
            Availability.AWAY -> "離席中は、通話の代わりに文字で連絡が届きます"
            else -> "通話や通知で連絡を受け取れます"
        }
        Text(explanation, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    vm.graph.presenceSyncError.collectAsState().value?.let {
        Text(
            it,
            modifier = Modifier.padding(horizontal = 16.dp),
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestListScreen(vm: MainViewModel, session: Session) {
    val state by session.repository.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // 通知の権限 (Android 13+) は一覧を最初に開いたときに求める
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    // 通常起動では未解決を取り直す。
    LaunchedEffect(session) {
        session.repository.refresh()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("ホーム") },
                actions = {
                    IconButton(onClick = { scope.launch { session.repository.refresh() } }) {
                        Icon(Icons.Filled.Refresh, contentDescription = "更新")
                    }
                    IconButton(onClick = { vm.screen = Screen.Settings }) {
                        Icon(Icons.Filled.Settings, contentDescription = "設定")
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (state.refreshing) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.relayUnreachable) UnreachableBanner()
            AvailabilityRow(vm)
            val pending = state.pending
            LazyColumn(Modifier.fillMaxSize()) {
                item { SectionHeader("未回答の通知 (${pending.size})") }
                if (pending.isEmpty()) {
                    item {
                        Text(
                            "未回答の通知はありません",
                            Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                items(pending, key = { "p-" + it.id }) { request ->
                    RequestRow(request, hasDraft = state.draft(request.id).text.isNotEmpty()) {
                        val call = vm.graph.callManager.uiState.value
                        if (call != null && call.requestId == request.id) {
                            context.startActivity(Intent(context, CallActivity::class.java)
                                .setAction(CallActivity.ACTION_SHOW)
                                .putExtra(CallActivity.EXTRA_REQUEST_ID, call.requestId)
                                .putExtra(CallActivity.EXTRA_CALL_ID, call.callId))
                        } else {
                            vm.openRequest(request.id)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
private fun PriorityChip(priority: Priority) {
    if (priority == Priority.NORMAL || priority == Priority.UNKNOWN) return
    val (label, container, content) = when (priority) {
        Priority.LOW -> Triple("低", MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant)
        Priority.HIGH -> Triple("高", MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer)
        Priority.URGENT -> Triple("至急", MaterialTheme.colorScheme.errorContainer, MaterialTheme.colorScheme.onErrorContainer)
        else -> return
    }
    Surface(color = container, contentColor = content, shape = MaterialTheme.shapes.small) {
        Text(label, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp))
    }
}

@Composable
private fun RequestRow(request: Request, hasDraft: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                Texts.agentLabel(request),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.weight(1f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            PriorityChip(request.priority)
            if (request.isLiveCall) {
                Text(if (request.call?.state == CallState.ACTIVE) "通話中" else "着信中", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            }
            Texts.deliveryLabel(request.deliveryMode)?.takeIf { request.isPending && !request.isLiveCall }?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(Texts.time(request), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(
            request.question,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = if (request.isPending) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        val sub = buildList {
            if (request.urgency == Urgency.HIGH && request.isPending && request.priority != Priority.HIGH && request.priority != Priority.URGENT) add("至急")
            if (request.isLiveCall) add("タップして通話を開く")
            if (request.isCallFallback) {
                Texts.callOutcomeLabel(request.call?.outcome)?.let { add(it) }
                add("テキストで回答")
            }
            if (!request.isPending) add(Texts.status(request))
            request.answer?.text?.takeIf { it.isNotEmpty() }?.let { add("「$it」") }
            if (hasDraft) add("下書きあり")
        }.joinToString(" ・ ")
        if (sub.isNotEmpty()) {
            Text(
                sub,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
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

    // 一覧に無い (通知から直接開いた等) 場合は取りに行く
    LaunchedEffect(requestId) {
        if (repository.state.value.find(requestId) == null) repository.refresh()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(request?.let { Texts.agentLabel(it) } ?: "質問", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = { vm.screen = Screen.List }) {
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
                    Texts.deliveryLabel(request.deliveryMode)?.let { add("方式: $it") }
                    request.agent?.cwd?.takeIf { it.isNotBlank() }?.let { add(it) }
                }.filter { it.isNotEmpty() }.joinToString(" ・ ")
                if (meta.isNotEmpty()) {
                    Text(meta, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                // 通話バナー: 着信中は通話画面へ、フォールバックは注記。
                if (request.isLiveCall) {
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
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
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

                if (request.isAnswerable) {
                    AnswerForm(
                        request = request,
                        draftText = state.draft(requestId).text,
                        submitting = requestId in state.submitting,
                        onEdit = { repository.editDraft(requestId, it) },
                        onDictate = { repository.dictateDraft(requestId, it) },
                        onSend = { scope.launch { repository.submitDraft(requestId) } },
                        onChoice = { index -> scope.launch { repository.submitChoice(requestId, index) } },
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
    request.choices.orEmpty().forEachIndexed { index, choice ->
        FilledTonalButton(onClick = { onChoice(index) }, enabled = !submitting, modifier = Modifier.fillMaxWidth()) {
            Text(choice)
        }
    }

    OutlinedTextField(
        value = editorText,
        onValueChange = { editorText = it; onEdit(it) },
        label = { Text(if (voice.listening) "聞き取り中…" else "回答") },
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
