package me.oyobidashi.android.ui

import android.app.Activity
import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import me.oyobidashi.android.core.OyobidashiJson
import me.oyobidashi.android.core.NotificationContent
import me.oyobidashi.android.core.PairingAttempt
import me.oyobidashi.android.core.PairingError
import me.oyobidashi.android.core.PairingInfo
import me.oyobidashi.android.core.PairingParseResult
import me.oyobidashi.android.core.PairingUri
import me.oyobidashi.android.core.RelayException
import me.oyobidashi.android.graph
import kotlinx.coroutines.launch

class MainViewModel(app: Application) : AndroidViewModel(app) {
    val graph = app.graph
    val session = graph.session

    private var navigation by mutableStateOf(AppNavigation())
    val screen: Screen get() = navigation.current
    val canGoBack: Boolean get() = navigation.canGoBack
    fun back() { navigation = navigation.back() }
    fun openSettings() { navigation = navigation.openSettings() }
    fun openPairing() { navigation = navigation.openPairing() }
    fun answerSubmitted(id: String) { navigation = navigation.answerSubmitted(id) }
    fun finishAnswerCompletion(id: String) { navigation = navigation.finishAnswerCompletion(id) }

    // ---- ペアリング ----
    var pairingBusy by mutableStateOf(false)
        private set
    var pairingError by mutableStateOf<String?>(null)

    /** ディープリンクで受け取ったペアリング情報。意図しないサーバーに繋がないよう、必ず確認ダイアログを出す。 */
    var pendingLink by mutableStateOf<PairingInfo?>(null)

    /** ブラウザにいる間にアプリが終了しても戻れるよう、始めたペアリングの控えは保存しておく。 */
    private val attempts = app.getSharedPreferences("pairing_attempt", android.content.Context.MODE_PRIVATE)

    // ---- ペアリング解除 ----
    var unpairBusy by mutableStateOf(false)
        private set
    var unpairError by mutableStateOf<String?>(null)

    // ---- プラン ----
    val billingState = graph.billingManager.state

    fun refreshBilling() = graph.billingManager.refresh()
    fun restorePlan() = graph.billingManager.restore()

    fun purchasePlan(activity: Activity) = graph.billingManager.launchBillingFlow(activity)

    /** 公式クラウドのペアリングを始め、ブラウザで開くページのURLを返す。 */
    fun beginCloudPairing(): String {
        val attempt = PairingAttempt.begin(OFFICIAL_CLOUD_URL, System.currentTimeMillis())
        attempts.edit()
            .putString("state", attempt.state)
            .putString("url", attempt.url)
            .putLong("expires", attempt.expiresAtMillis)
            .apply()
        return attempt.pageUrl
    }

    /** リンクは外部から誰でも開ける。このアプリが始めたペアリングへの戻りだけを受け付ける。 */
    fun onPairingLink(uri: String) {
        val state = attempts.getString("state", null)
        val url = attempts.getString("url", null)
        val result = if (state != null && url != null) {
            PairingAttempt(state, url, attempts.getLong("expires", 0)).accept(uri, System.currentTimeMillis())
        } else {
            // 形式の誤りはその内容を伝える。正しい形式なら、始めていないことを伝える。
            PairingUri.parse(uri).let {
                if (it is PairingParseResult.Success) PairingParseResult.Failure(PairingError.NOT_STARTED_IN_APP) else it
            }
        }
        when (result) {
            is PairingParseResult.Success -> {
                // 1回限り。合わなかったリンクでは消さず、進行中の正規のペアリングを妨げさせない。
                attempts.edit().clear().apply()
                pairingError = null
                pendingLink = result.info
            }
            is PairingParseResult.Failure -> pairingError = Texts.pairingError(result.error)
        }
    }

    /** QR 読み取り結果。oyobidashi のペアリングURIならペアリングを開始して true。 */
    fun onQrScanned(raw: String): Boolean {
        val result = PairingUri.parse(raw) as? PairingParseResult.Success ?: return false
        pair(result.info)
        return true
    }

    fun pairManually(url: String, code: String) {
        when (val result = PairingUri.fromManualInput(url, code)) {
            is PairingParseResult.Success -> pair(result.info)
            is PairingParseResult.Failure -> pairingError = Texts.pairingError(result.error)
        }
    }

    fun pair(info: PairingInfo) {
        if (pairingBusy) return
        pairingBusy = true
        pairingError = null
        viewModelScope.launch {
            try {
                graph.pair(info)
                navigation = AppNavigation()
            } catch (e: RelayException) {
                pairingError = Texts.pairFailure(e)
            } finally {
                pairingBusy = false
            }
        }
    }

    fun unpair(force: Boolean) {
        if (unpairBusy) return
        unpairBusy = true
        unpairError = null
        viewModelScope.launch {
            try {
                graph.unpair(force)
                navigation = AppNavigation()
            } catch (e: RelayException) {
                unpairError = Texts.unpairFailure(e)
            } finally {
                unpairBusy = false
            }
        }
    }

    /** @param contentJson 通知から開いた場合の通知内容。relay に届かなくても質問を表示できるようにする。 */
    fun openRequest(id: String, contentJson: String? = null) {
        if (contentJson != null) {
            try {
                val content = OyobidashiJson.decodeFromString(NotificationContent.serializer(), contentJson)
                val current = session.value
                if (content.requestId == id && content.isForDevice(current?.credentials?.deviceId)) current?.repository?.onPushReceived(content)
            } catch (e: Exception) {
                // 壊れた extra は無視して、通常どおり relay から取得する
            }
        }
        navigation = navigation.openRequest(id)
    }
}

/** 公式クラウド。「Oyobidashiクラウドに接続」が開くペアリングページの接続先。 */
private const val OFFICIAL_CLOUD_URL = "https://api.oyobidashi.me"
