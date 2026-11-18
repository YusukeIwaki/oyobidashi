package me.oyobidashi.android.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import me.oyobidashi.android.core.BillingApi
import me.oyobidashi.android.core.BillingStatus
import me.oyobidashi.android.core.BillingSync
import me.oyobidashi.android.core.PurchaseRef
import me.oyobidashi.android.ui.Texts
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 設定のプラン欄に出す状態。表示はサーバーの [status] が正で、端末側では何も解錠しない。 */
data class BillingPlanState(
    val status: BillingStatus? = null,
    val formattedPrice: String? = null,
    val googleAvailable: Boolean = false,
    val loadingPrice: Boolean = false,
    val working: Boolean = false,
    val syncError: String? = null,
    val notice: String? = null,
)

/**
 * Play Billing とサーバー同期の統括。
 *
 * 購入の確認 (acknowledge) はサーバーが行うので、端末側では行わない。
 * 起動時・購入後・ストア更新時に購入を照会して [BillingSync] へ渡す。
 * Play Integrity が未設定でもクラウドの現在の利用権は表示する。
 */
class BillingManager(
    context: Context,
    private val scope: CoroutineScope,
    private val api: () -> BillingApi?,
    cloudProjectNumber: String,
) : PurchasesUpdatedListener {
    private val integrity: PlayIntegrityTokens? =
        if ((cloudProjectNumber.trim().toLongOrNull() ?: 0) > 0) PlayIntegrityTokens(context, cloudProjectNumber) else null

    private val billingClient: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    private val _state = MutableStateFlow(BillingPlanState())
    val state: StateFlow<BillingPlanState> = _state.asStateFlow()

    private val mutex = Mutex()

    private data class MonthlyPlan(val details: ProductDetails, val offerToken: String, val price: String)
    private var monthlyPlan: MonthlyPlan? = null
    private var purchaseApi: BillingApi? = null

    override fun onPurchasesUpdated(billingResult: BillingResult, purchases: List<Purchase>?) {
        val purchaseClient = purchaseApi
        purchaseApi = null
        when (billingResult.responseCode) {
            BillingClient.BillingResponseCode.OK, BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> {
                val pending = purchases.orEmpty().any { it.purchaseState == Purchase.PurchaseState.PENDING }
                refresh(notice = if (pending) "Google Playで支払いを確認中です。" else null)
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> Unit
            else -> if (purchaseClient != null && api() === purchaseClient) {
                _state.value = _state.value.copy(syncError = Texts.BILLING_SYNC_FAILED)
            }
        }
    }

    /** セッション終了時にサーバーの状態表示を消す。 */
    fun clear() {
        monthlyPlan = null
        purchaseApi = null
        _state.value = BillingPlanState()
    }

    /** 起動時・設定表示時・ストア更新時に、状態と購入をサーバーへ同期する。 */
    fun refresh() = refresh(notice = null)

    private fun refresh(notice: String?) {
        val client = api() ?: return
        scope.launch {
            mutex.withLock {
                if (api() !== client) return@withLock
                withFeedback(client) { refreshInternal(client, notice = notice) }
            }
        }
    }

    fun restore() {
        val client = api() ?: return
        if (!_state.value.googleAvailable || _state.value.working) return
        _state.value = _state.value.copy(working = true, syncError = null, notice = null)
        scope.launch {
            mutex.withLock {
                if (api() !== client) return@withLock
                withFeedback(client) { refreshInternal(client, restoring = true) }
            }
        }
    }

    /** 購入画面を出す。成否はストアの通知とその後の同期で確定し、端末側では解錠しない。 */
    fun launchBillingFlow(activity: Activity) {
        val client = api() ?: return
        if (_state.value.working || monthlyPlan == null || _state.value.status?.active != false) return
        _state.value = _state.value.copy(working = true, syncError = null, notice = null)
        scope.launch {
            mutex.withLock {
                if (api() !== client) return@withLock
                withFeedback(client) {
                    refreshInternal(client)
                    val plan = monthlyPlan ?: return@withFeedback
                    if (api() !== client || _state.value.status?.active != false) return@withFeedback
                    val params = BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(plan.details)
                        .setOfferToken(plan.offerToken)
                        .build()
                    val flowParams = BillingFlowParams.newBuilder()
                        .setProductDetailsParamsList(listOf(params))
                        .build()
                    purchaseApi = client
                    val result = try {
                        billingClient.launchBillingFlow(activity, flowParams)
                    } catch (e: RuntimeException) {
                        purchaseApi = null
                        throw e
                    }
                    if (result.responseCode != BillingClient.BillingResponseCode.OK) purchaseApi = null
                    when (result.responseCode) {
                        BillingClient.BillingResponseCode.OK, BillingClient.BillingResponseCode.USER_CANCELED -> Unit
                        BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> refreshInternal(client)
                        else -> error("purchase flow unavailable")
                    }
                }
            }
        }
    }

    private suspend fun withFeedback(client: BillingApi, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            if (api() === client) _state.value = _state.value.copy(syncError = Texts.BILLING_SYNC_FAILED)
        } finally {
            if (api() === client) _state.value = _state.value.copy(working = purchaseApi != null, loadingPrice = false)
        }
    }

    private suspend fun refreshInternal(client: BillingApi, restoring: Boolean = false, notice: String? = null) {
        val status = client.billingStatus()
        if (api() !== client) return
        val ids = status.google?.productIds.orEmpty()
        val tokens = integrity?.takeIf { status.enabled && ids.isNotEmpty() }
        monthlyPlan = null
        _state.value = _state.value.copy(
            status = status,
            formattedPrice = null,
            googleAvailable = tokens != null,
            loadingPrice = tokens != null && !status.active,
            syncError = null,
            notice = notice ?: _state.value.notice,
        )
        if (tokens == null) return

        val purchases = queryPurchasedPurchases(ids)
        if (api() !== client) return
        val synced = if (purchases.isEmpty()) status else BillingSync(client, tokens).sync(purchases)
        if (api() !== client) return
        val restored = restoring && purchases.isNotEmpty() && synced.activeStores?.contains("google") == true
        _state.value = _state.value.copy(
            status = synced,
            notice = when {
                restored -> "Google Playの購入情報を確認しました。"
                restoring -> "このGoogleアカウントで復元できる購入は見つかりませんでした。"
                else -> _state.value.notice
            },
        )
        if (synced.active) return
        _state.value = _state.value.copy(loadingPrice = true)
        val plan = loadProductDetails(ids)
        if (api() !== client) return
        monthlyPlan = plan
        _state.value = _state.value.copy(formattedPrice = plan?.price)
    }

    /** SUBS の商品詳細を取り、ベースプランの offer と月額表示を覚える。 */
    private suspend fun loadProductDetails(productIds: List<String>): MonthlyPlan? {
        if (productIds.isEmpty()) return null
        ensureConnected()
        val products = productIds.map { productId ->
            QueryProductDetailsParams.Product.newBuilder()
                .setProductId(productId)
                .setProductType(BillingClient.ProductType.SUBS)
                .build()
        }
        val result = billingClient.queryProductDetails(
            QueryProductDetailsParams.newBuilder().setProductList(products).build()
        )
        if (result.billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
            throw IllegalStateException("product details unavailable")
        }
        val details = result.productDetailsList.orEmpty().associateBy { it.productId }
        for (id in productIds) {
            val product = details[id] ?: continue
            for (offer in product.subscriptionOfferDetails.orEmpty().filter { it.offerId == null }) {
                val phase = offer.pricingPhases.pricingPhaseList.singleOrNull() ?: continue
                if (phase.billingPeriod == "P1M" && phase.recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING) {
                    return MonthlyPlan(product, offer.offerToken, phase.formattedPrice)
                }
            }
        }
        return null
    }

    /** 購入済み (PURCHASED) の定期購入をすべて取り出す。保留中は含めない。 */
    private suspend fun queryPurchasedPurchases(productIds: List<String>): List<PurchaseRef> {
        ensureConnected()
        val params = QueryPurchasesParams.newBuilder()
            .setProductType(BillingClient.ProductType.SUBS)
            .build()
        val result = billingClient.queryPurchasesAsync(params)
        if (result.billingResult.responseCode != BillingClient.BillingResponseCode.OK) {
            throw IllegalStateException("purchases unavailable")
        }
        return result.purchasesList
            .filter { it.purchaseState == Purchase.PurchaseState.PURCHASED }
            .flatMap { purchase ->
                purchase.products.filter { it in productIds }.map { PurchaseRef(it, purchase.purchaseToken) }
            }
    }

    private suspend fun ensureConnected() {
        if (billingClient.isReady) return
        suspendCancellableCoroutine<Unit> { cont ->
            billingClient.startConnection(object : BillingClientStateListener {
                override fun onBillingServiceDisconnected() = Unit

                override fun onBillingSetupFinished(billingResult: BillingResult) {
                    if (!cont.isActive) return
                    if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) {
                        cont.resume(Unit)
                    } else {
                        cont.resumeWithException(IllegalStateException("billing unavailable"))
                    }
                }
            })
        }
    }
}
