package me.oyobidashi.android.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import me.oyobidashi.android.Session
import me.oyobidashi.android.call.CallActivity
import me.oyobidashi.android.core.Availability
import me.oyobidashi.android.core.CallState
import me.oyobidashi.android.core.HomeNotice
import me.oyobidashi.android.core.Priority
import me.oyobidashi.android.core.RefreshError
import me.oyobidashi.android.core.Request
import me.oyobidashi.android.core.VoiceRecipient
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.temporal.ChronoUnit

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestListScreen(vm: MainViewModel, session: Session) {
    val state by session.repository.state.collectAsState()
    val pending = remember(state.requests) { state.pending }
    val voiceNotice = state.homeNotice?.takeIf { it.requiresVoicePlanConsent }
    var noticeOpen by remember(session) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior(rememberTopAppBarState())
    val notificationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    Scaffold(
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            LargeTopAppBar(
                title = { Text("お呼び出し") },
                scrollBehavior = scrollBehavior,
                actions = {
                    IconButton(onClick = { scope.launch { session.repository.refresh() } }, enabled = !state.refreshing) {
                        Icon(Icons.Default.Refresh, contentDescription = "更新")
                    }
                    IconButton(onClick = vm::openSettings, modifier = Modifier.padding(end = 8.dp)) {
                        Icon(Icons.Default.Settings, contentDescription = "設定")
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            LazyColumn(
                modifier = Modifier.widthIn(max = 640.dp).fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                item(key = "availability") { AvailabilityCard(vm) }
                if (state.relayUnreachable) item(key = "relay_unreachable") { UnreachableBanner() }
                if (voiceNotice != null) item(key = "home_voice_notice") {
                    Card(
                        onClick = { noticeOpen = true },
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer),
                    ) {
                        Row(
                            Modifier.padding(16.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Default.Notifications, contentDescription = null)
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("音声通話の送信先を確認", style = MaterialTheme.typography.titleMedium)
                                Text("同意すると、次の通話から音声で応答できます。", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
                item(key = "inbox_heading") {
                    Row(Modifier.padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("未回答の通知", style = MaterialTheme.typography.titleMedium)
                        if (pending.isNotEmpty()) Badge { Text(pending.size.toString()) }
                    }
                }
                if (pending.isEmpty()) {
                    if (state.inboxLoaded) item(key = "empty_inbox") { EmptyInboxCard() }
                    else if (state.refreshError == RefreshError.SERVER) item(key = "inbox_load_error") {
                        Text("未回答の通知を取得できませんでした。", color = MaterialTheme.colorScheme.error)
                    }
                }
                items(pending, key = { it.id }) { request ->
                    RequestCard(request, hasDraft = state.draft(request.id).text.isNotEmpty()) {
                        val call = vm.graph.callManager.uiState.value
                        if (call != null && call.requestId == request.id &&
                            (call.state == CallState.RINGING || call.state == CallState.ACTIVE)
                        ) {
                            context.startActivity(Intent(context, CallActivity::class.java)
                                .setAction(CallActivity.ACTION_SHOW)
                                .putExtra(CallActivity.EXTRA_REQUEST_ID, call.requestId)
                                .putExtra(CallActivity.EXTRA_CALL_ID, call.callId))
                        } else vm.openRequest(request.id)
                    }
                }
            }
            if (state.refreshing) {
                LinearProgressIndicator(Modifier.widthIn(max = 640.dp).fillMaxWidth())
            }
        }
    }
    if (noticeOpen && voiceNotice != null) {
        VoiceNoticeDialog(voiceNotice, session.credentials.baseUrl, onClose = { noticeOpen = false })
    }
    LaunchedEffect(voiceNotice) {
        if (voiceNotice == null) noticeOpen = false
    }
}

@Composable
private fun VoiceNoticeDialog(notice: HomeNotice, baseUrl: String, onClose: () -> Unit) {
    val context = LocalContext.current
    var browserUnavailable by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("音声通話の送信先") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("現在は、通話での質問もテキストで届きます。音声で応答したときは、文字起こしと質問・会話履歴を利用プランの送信先へ送ります。")
                VoiceRecipient.fromProvider(notice.providers["free"])?.let { Text("FREE  ${it.displayName}") }
                VoiceRecipient.fromProvider(notice.providers["plus"])?.let { Text("PLUS  ${it.displayName}") }
                if (browserUnavailable) Text("ブラウザを開けませんでした。", color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            Button(onClick = {
                val uri = Uri.parse(baseUrl).buildUpon().appendPath("pair").appendQueryParameter("voice", "1").build()
                try {
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                    onClose()
                } catch (_: ActivityNotFoundException) {
                    browserUnavailable = true
                }
            }) { Text("送信先を確認して同意") }
        },
        dismissButton = { TextButton(onClick = onClose) { Text("あとで") } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AvailabilityCard(vm: MainViewModel) {
    val presence by vm.graph.presence.collectAsState()
    val syncError by vm.graph.presenceSyncError.collectAsState()
    val current = presence.effectiveAvailability
    val choices = listOf(Availability.AVAILABLE, Availability.BUSY, Availability.AWAY)
    fun choose(choice: Availability) {
        if (choice == Availability.BUSY) vm.graph.setPresence(choice, Instant.now().plus(30, ChronoUnit.MINUTES).toString())
        else vm.graph.setPresence(choice)
    }
    val icon = when (current) {
        Availability.BUSY -> Icons.Default.DateRange
        Availability.AWAY -> Icons.Default.Person
        else -> Icons.Default.CheckCircle
    }
    Card(
        modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.extraLarge,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Surface(Modifier.size(48.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary) {
                    Box(contentAlignment = Alignment.Center) { Icon(icon, null, Modifier.size(26.dp)) }
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("あなたの状態", style = MaterialTheme.typography.labelLarge)
                    Text(Texts.availabilityLabel(current), style = MaterialTheme.typography.titleLarge)
                }
            }
            if (LocalDensity.current.fontScale >= 1.2f) {
                Column(Modifier.selectableGroup()) {
                    choices.forEach { choice ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .selectable(selected = current == choice, role = Role.RadioButton, onClick = { choose(choice) }),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            RadioButton(selected = current == choice, onClick = null)
                            Text(Texts.availabilityLabel(choice), style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
            } else SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                choices.forEachIndexed { index, choice ->
                    SegmentedButton(
                        selected = current == choice,
                        onClick = { choose(choice) },
                        shape = SegmentedButtonDefaults.itemShape(index, choices.size),
                    ) { Text(Texts.availabilityLabel(choice), style = MaterialTheme.typography.labelLarge) }
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (current == Availability.BUSY) {
                    Texts.clock(presence.until).takeIf { it.isNotEmpty() }?.let {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(Icons.Default.DateRange, null, Modifier.size(16.dp))
                            Text("$it まで", style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
                Text(when (current) {
                    Availability.BUSY -> "取り込み中は、通話の代わりに文字で連絡が届きます"
                    Availability.AWAY -> "離席中は、通話の代わりに文字で連絡が届きます"
                    else -> "質問や通知を受け取れます"
                }, style = MaterialTheme.typography.bodyMedium)
            }
            syncError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                TextButton(onClick = { vm.graph.syncPresence() }) { Text("再送信") }
            }
        }
    }
}

@Composable
private fun EmptyInboxCard() {
    Card(modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.extraLarge,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Surface(Modifier.size(64.dp), CircleShape, color = MaterialTheme.colorScheme.secondaryContainer,
                contentColor = MaterialTheme.colorScheme.onSecondaryContainer) {
                Box(contentAlignment = Alignment.Center) { Icon(Icons.Default.Notifications, null, Modifier.size(28.dp)) }
            }
            Text("未回答の通知はありません", style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
            Text("新しい通知はここに届きます", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun RequestCard(request: Request, hasDraft: Boolean, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.extraLarge,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                IconBadge { Icon(Icons.Default.Person, null, Modifier.size(22.dp)) }
                Text(Texts.agentLabel(request), Modifier.weight(1f), style = MaterialTheme.typography.labelLarge,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(Texts.time(request), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(request.question, style = MaterialTheme.typography.titleLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (request.priority == Priority.HIGH || request.priority == Priority.URGENT) {
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer) {
                        Text(if (request.priority == Priority.URGENT) "至急" else "優先度 高",
                            Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.labelSmall)
                    }
                }
                Text(when {
                    hasDraft -> "下書きあり"
                    request.isCallFallback -> "通話からテキストに切り替わりました"
                    else -> Texts.deliveryLabel(request.deliveryMode).orEmpty()
                }, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(if (request.isLiveCall) "通話を開く" else if (hasDraft) "回答を続ける" else "回答する",
                Modifier.align(Alignment.End).padding(vertical = 4.dp),
                style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        }
    }
}
