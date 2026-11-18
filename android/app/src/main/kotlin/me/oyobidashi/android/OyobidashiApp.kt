package me.oyobidashi.android

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.provider.Settings
import me.oyobidashi.android.billing.BillingManager
import me.oyobidashi.android.billing.VoiceAccessManager
import me.oyobidashi.android.call.CallManager
import me.oyobidashi.android.core.Availability
import me.oyobidashi.android.core.ConnectionState
import me.oyobidashi.android.core.CredentialStore
import me.oyobidashi.android.core.Credentials
import me.oyobidashi.android.core.DevicePresence
import me.oyobidashi.android.core.DeviceUpdate
import me.oyobidashi.android.core.DirectReplyHandler
import me.oyobidashi.android.core.EventsClient
import me.oyobidashi.android.core.EventsListener
import me.oyobidashi.android.core.OkHttpEventSocketConnector
import me.oyobidashi.android.core.PairRequest
import me.oyobidashi.android.core.PairingInfo
import me.oyobidashi.android.core.PresenceNote
import me.oyobidashi.android.core.PresenceUntil
import me.oyobidashi.android.core.PresenceUpdate
import me.oyobidashi.android.core.PushTokenUpdate
import me.oyobidashi.android.core.RelayClient
import me.oyobidashi.android.core.RelayEvent
import me.oyobidashi.android.core.RelayException
import me.oyobidashi.android.core.RequestsRepository
import me.oyobidashi.android.data.EncryptedCredentialStore
import me.oyobidashi.android.data.PrefsDraftStore
import me.oyobidashi.android.data.PrefsPresenceStore
import me.oyobidashi.android.push.AndroidNotifier
import me.oyobidashi.android.push.PushTokens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.time.Instant
import java.util.concurrent.TimeUnit

class OyobidashiApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

val Context.graph: AppGraph get() = (applicationContext as OyobidashiApp).graph

/** ペアリング済みの間だけ存在する、relay 1台分のオブジェクト群。 */
class Session(
    val credentials: Credentials,
    val api: RelayClient,
    val repository: RequestsRepository,
    val events: EventsClient,
)

/** アプリ全体の依存関係。状態を触る処理はすべてメインスレッドで行う。 */
class AppGraph(private val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    // LAN 外では relay に届かないのが通常状態なので、接続タイムアウトは短めにして早く「接続できません」を出す
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()
    private val wsHttp: OkHttpClient = http.newBuilder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    val notifier = AndroidNotifier(app)
    val pushTokens = PushTokens(app)
    private val pushClientId = me.oyobidashi.android.push.PushClientIdentity.current(app)
    private val credentialStore: CredentialStore = EncryptedCredentialStore.create(app)
    private val draftStore = PrefsDraftStore(app)
    private val presenceStore = PrefsPresenceStore(app)

    private val _session = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = _session.asStateFlow()

    /** relay から 401 を受けてペアリングが無効になった (ペアリング画面で理由を表示する)。 */
    val signedOutByServer = MutableStateFlow(false)

    /** 在席状態 (端末側の保存 + サーバーへの PUT)。期限切れは available に寄せてある。 */
    private val _presence = MutableStateFlow(presenceStore.load())
    val presence: StateFlow<DevicePresence> = _presence.asStateFlow()
    val presenceSyncError = MutableStateFlow<String?>(null)

    /** クラウドのプラン表示と Google Play 購入の同期。 */
    val billingManager = BillingManager(
        app,
        scope,
        api = { _session.value?.api },
        cloudProjectNumber = BuildConfig.GOOGLE_CLOUD_PROJECT_NUMBER,
    )

    /** ネイティブ通話の統括。セッションの有無にかかわらず存在し、未ペアリング時は無操作。 */
    val callManager = CallManager(
        context = app,
        scope = scope,
        api = { _session.value?.api },
        myDeviceId = { _session.value?.credentials?.deviceId },
        repository = { _session.value?.repository },
        regularNotifier = notifier,
        onSignedOut = { _session.value?.repository?.handleUnauthorized() },
    )
    private var callReconcileJob: Job? = null

    private var foreground = false

    val directReply = DirectReplyHandler(
        api = { _session.value?.api },
        notifier = notifier,
        onAnswered = { _session.value?.repository?.applyRequest(it) },
        onUnauthorized = { _session.value?.repository?.handleUnauthorized() },
        saveDraft = { id, text -> _session.value?.repository?.editDraft(id, text) },
        currentDeviceId = { _session.value?.credentials?.deviceId },
    )

    init {
        notifier.ensureChannels()
        callManager.ensurePhoneAccount()
        credentialStore.load()?.let { startSession(it) }
        registerConnectivityCallback()
    }

    private fun startSession(credentials: Credentials) {
        val voiceApi = RelayClient(http, credentials.baseUrl, credentials.deviceToken)
        val voiceAccess = VoiceAccessManager(app, voiceApi, credentials.baseUrl, BuildConfig.GOOGLE_CLOUD_PROJECT_NUMBER)
        val api = RelayClient(http, credentials.baseUrl, credentials.deviceToken, voiceTokenProvider = voiceAccess)
        val repository = RequestsRepository(api, notifier, onSignedOut = {
            signedOutByServer.value = true
            endSessionLocally()
        }, draftStore = draftStore)
        val events = EventsClient(
            OkHttpEventSocketConnector(wsHttp, credentials.baseUrl, credentials.deviceToken),
            scope,
            object : EventsListener {
                override fun onEvent(event: RelayEvent) = repository.onEvent(event)
                override fun onStateChanged(state: ConnectionState) {
                    repository.onConnectionState(state)
                    if (state == ConnectionState.CONNECTED) scope.launch { repository.refresh() }
                }

                override fun onUnauthorized() = repository.handleUnauthorized()
            },
        )
        _session.value = Session(credentials, api, repository, events)
        // 通話の照合。hello/イベント/一覧/FCM のいずれも repository.state 経由で一元化する。
        callReconcileJob?.cancel()
        callReconcileJob = scope.launch {
            repository.state.collect { callManager.reconcile(it.requests) }
        }
        if (foreground) {
            events.start()
            scope.launch { repository.refresh() }
        } else {
            // バックグラウンド起動 (FCM 等) でも初回は一覧を取る。
            scope.launch { repository.refresh() }
        }
        syncPushToken()
        syncPresence()
        billingManager.refresh()
    }

    /** サーバーには何もせず、端末側の資格情報・下書き・通知を消す。 */
    private fun endSessionLocally() {
        val current = _session.value ?: return
        _session.value = null
        callReconcileJob?.cancel()
        callReconcileJob = null
        callManager.clearAll()
        current.events.stop()
        credentialStore.clear()
        draftStore.clear()
        presenceStore.clear()
        _presence.value = DevicePresence()
        presenceSyncError.value = null
        billingManager.clear()
        notifier.cancelAll()
    }

    /** POST /v1/pair。失敗は [RelayException]。成功したら既存のペアリングを置き換える。 */
    suspend fun pair(info: PairingInfo) {
        val pushToken = pushTokens.current()
        val response = RelayClient(http, info.url).pair(
            PairRequest(code = info.code, deviceName = deviceName(), platform = "android", pushToken = pushToken, pushClientId = pushClientId)
        )
        _session.value?.let { old ->
            endSessionLocally()
            // 古いペアリングはベストエフォートでサーバー側も解除する (届かなければ諦める)
            scope.launch { try { old.api.deleteDevice() } catch (ignored: RelayException) {} }
        }
        val credentials = Credentials(info.url, response.deviceToken, response.device.id, response.device.name)
        credentialStore.save(credentials)
        signedOutByServer.value = false
        startSession(credentials)
    }

    /**
     * DELETE /v1/devices/me してから端末側を消す。
     * @param force サーバーに届かなくても端末側だけ解除する
     * @throws RelayException サーバー側の解除に失敗し、force でもない場合
     */
    suspend fun unpair(force: Boolean) {
        val current = _session.value ?: return
        try {
            current.api.deleteDevice()
        } catch (e: RelayException) {
            if (!force && !e.isUnauthorized) throw e
        }
        endSessionLocally()
    }

    /** FCM トークンを relay に登録する (起動時・ペアリング直後・onNewToken)。Firebase 未設定なら何もしない。 */
    fun syncPushToken(knownToken: String? = null) {
        scope.launch {
            val current = _session.value ?: return@launch
            val token = knownToken ?: pushTokens.current() ?: return@launch
            try {
                current.api.updateDevice(DeviceUpdate(PushTokenUpdate.Set(token), pushClientId = pushClientId))
            } catch (e: RelayException) {
                if (e.isUnauthorized) current.repository.handleUnauthorized()
                // LAN 外などで失敗した場合は次回の起動/フォアグラウンド復帰で再試行する
            }
        }
    }

    // ---- 在席 (presence) ----

    /**
     * 在席を変更する。端末側に即保存し、サーバーへ PUT する。
     * @param untilIso8601 busy/away の期限 (null で無期限)。available では無視して解除する。
     */
    fun setPresence(availability: Availability, untilIso8601: String? = null, note: String? = null) {
        val normalized = when (availability) {
            Availability.AVAILABLE, Availability.UNKNOWN -> DevicePresence(Availability.AVAILABLE, null, null)
            Availability.BUSY, Availability.AWAY -> DevicePresence(
                availability,
                untilIso8601?.takeIf { it.isNotBlank() },
                note?.trim()?.takeIf { it.isNotEmpty() }?.take(200),
            )
        }
        _presence.value = normalized.effective(Instant.now())
        presenceStore.save(_presence.value)
        presenceSyncError.value = null
        syncPresence()
    }

    /** 期限切れの busy/away を available に戻す (フォアグラウンド復帰時等)。 */
    fun checkPresenceExpiry() {
        val effective = _presence.value.effective(Instant.now())
        if (effective != _presence.value) {
            _presence.value = effective
            presenceStore.save(effective)
            syncPresence()
        }
    }

    /** 在席をサーバーへ PUT する。失敗しても端末側の値は残す。 */
    fun syncPresence() {
        scope.launch {
            val current = _session.value ?: return@launch
            val p = _presence.value.effective(Instant.now())
            if (p != _presence.value) {
                _presence.value = p
                presenceStore.save(p)
            }
            val update = PresenceUpdate(
                availability = if (p.availability == Availability.UNKNOWN) Availability.AVAILABLE else p.availability,
                until = p.until?.let { PresenceUntil.Set(it) } ?: PresenceUntil.Clear,
                note = p.note?.let { PresenceNote.Set(it) } ?: PresenceNote.Clear,
            )
            try {
                current.api.updatePresence(update)
                presenceSyncError.value = null
            } catch (e: RelayException) {
                if (e.isUnauthorized) {
                    current.repository.handleUnauthorized()
                    return@launch
                }
                presenceSyncError.value = if (e is RelayException.Network) {
                    "在席を送信できません。中継サーバーに接続できないため、端末側のみ変更しました"
                } else {
                    "在席の送信に失敗しました。端末側のみ変更しました"
                }
            }
        }
    }

    /** フォアグラウンドの間だけ WebSocket を繋ぎ、復帰のたびに一覧を取り直す。 */
    fun setForeground(value: Boolean) {
        foreground = value
        val current = _session.value ?: return
        if (value) {
            checkPresenceExpiry()
            current.events.start()
            scope.launch { current.repository.refresh() }
            syncPushToken()
            syncPresence()
            billingManager.refresh()
        } else {
            current.events.stop()
        }
    }

    /** ネットワークが戻った (Wi‑Fi に繋がった等): バックオフを待たずに再接続する。 */
    private fun onNetworkAvailable() {
        val current = _session.value ?: return
        if (!foreground) return
        current.events.reconnectNow()
        scope.launch { current.repository.refresh() }
        syncPresence()
    }

    private fun registerConnectivityCallback() {
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    scope.launch { onNetworkAvailable() }
                }
            })
        } catch (e: RuntimeException) {
            // コールバック登録数の上限など。自動再接続はバックオフ頼みになるだけ
        }
    }

    private fun deviceName(): String {
        val fromSettings = try {
            Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME)
        } catch (e: RuntimeException) {
            null
        }
        return (fromSettings?.takeIf { it.isNotBlank() } ?: "${Build.MANUFACTURER} ${Build.MODEL}").trim().take(100)
    }
}
