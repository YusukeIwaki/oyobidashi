package io.github.yusukeiwaki.oyobidashi.ui

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handleIntent(intent)
        setContent { OyobidashiTheme { AppRoot(viewModel) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        viewModel.graph.setForeground(true)
    }

    override fun onStop() {
        viewModel.graph.setForeground(false)
        super.onStop()
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        val data = intent.data
        when {
            intent.action == Intent.ACTION_VIEW && data?.scheme.equals("oyobidashi", ignoreCase = true) ->
                viewModel.onPairingLink(data.toString())
            intent.action == ACTION_OPEN_REQUEST ->
                intent.getStringExtra(EXTRA_REQUEST_ID)?.let { viewModel.openRequest(it, intent.getStringExtra(EXTRA_CONTENT)) }
        }
    }

    companion object {
        const val ACTION_OPEN_REQUEST = "io.github.yusukeiwaki.oyobidashi.action.OPEN_REQUEST"
        const val EXTRA_REQUEST_ID = "request_id"
        const val EXTRA_CONTENT = "content"
    }
}

@Composable
fun AppRoot(vm: MainViewModel) {
    val session by vm.session.collectAsState()
    val current = session
    BackHandler(enabled = current != null && vm.canGoBack) { vm.back() }

    if (current == null) {
        PairingScreen(vm)
    } else {
        when (val screen = vm.screen) {
            Screen.List -> RequestListScreen(vm, current)
            is Screen.Detail -> {
                RequestDetailScreen(vm, current, screen.requestId)
            }
            Screen.Settings -> {
                SettingsScreen(vm, current)
            }
            Screen.Pairing -> {
                PairingScreen(vm, onClose = { vm.back() })
            }
        }
    }

    vm.pendingLink?.let { info ->
        AlertDialog(
            onDismissRequest = { vm.pendingLink = null },
            title = { Text("ペアリングしますか?") },
            text = {
                Text(
                    "次の中継サーバーとペアリングします。\n\n${info.url}" +
                        if (current != null) "\n\n現在のペアリング (${current.credentials.baseUrl}) は解除されます。" else ""
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    vm.pendingLink = null
                    vm.pair(info)
                }) { Text("ペアリング") }
            },
            dismissButton = { TextButton(onClick = { vm.pendingLink = null }) { Text("キャンセル") } },
        )
    }

    // ペアリング済みの状態でディープリンク経由の再ペアリングに失敗した場合のエラー表示
    if (current != null && vm.screen != Screen.Pairing) {
        vm.pairingError?.let { message ->
            AlertDialog(
                onDismissRequest = { vm.pairingError = null },
                title = { Text("ペアリングできませんでした") },
                text = { Text(message) },
                confirmButton = { TextButton(onClick = { vm.pairingError = null }) { Text("OK") } },
            )
        }
    }
}
