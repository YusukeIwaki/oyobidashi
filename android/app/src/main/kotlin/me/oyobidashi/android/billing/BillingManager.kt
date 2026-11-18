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
    val productId: String? = null,
    val syncError: String? = null,
)

/**
 * Play Billing とサーバー同期の統括。
 *
 * 購入の確認 (acknowledge) はサーバーが行うので、端末側では行わない。
 * 起動時・購入後・ストア更新時に購入を照会して [BillingSync] へ渡す。
 * プロジェクト番号が未設定なら何もしない。
 */
class BillingManager(
    context: Context,
    private val scope: CoroutineScope,
    private val api: () -> BillingApi?,
    cloudProjectNumber: String,
) : PurchasesUpdatedListener {
    val configured: Boolean = cloudProjectNumber.trim().toLongOrNull() != null

    private val integrity: PlayIntegrityTokens? =
        if (configured) PlayIntegrityTokens(context, cloudProjectNumber) else null

    private val billingClient: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener(this)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    private val _state = MutableStateFlow(BillingPlanState())
    val state: StateFlow<BillingPlanState> = _state.asStateFlow()

    private val mutex = Mutex()

    @Volatile
    private var productDetails: ProductDetails? = null

    @Volatile
    private var offerToken: String? = null

    override fun onPurchasesUpdated(billingResult: BillingResult, purchases: List<Purchase>?) {
        if (billingResult.responseCode == BillingClient.BillingResponseCode.OK) refresh()
    }

    /** セッション終了時にサーバーの状態表示を消す。 */
    fun clear() {
        productDetails = null
        offerToken = null
        _state.value = BillingPlanState()
    }

    /** 起動時・設定表示時・ストア更新時に、状態と購入をサーバーへ同期する。 */
    fun refresh() {
        if (!configured) return
        scope.launch {
            mutex.withLock {
                try {
                    refreshInternal()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _state.value = _state.value.copy(syncError = Texts.BILLING_SYNC_FAILED)
                }
            }
        }
    }

    /** 購入画面を出す。成否はストアの通知とその後の同期で確定し、端末側では解錠しない。 */
    fun launchBillingFlow(activity: Activity) {
        if (!configured) return
        scope.launch {
            mutex.withLock {
                try {
                    val details = productDetails ?: run {
                        val ids = api()?.billingStatus()?.google?.productIds.orEmpty()
                        if (ids.isEmpty()) null else loadProductDetails(ids)?.first
                    }
                    val token = offerToken
                    if (details == null || token == null) {
                        _state.value = _state.value.copy(syncError = Texts.BILLING_SYNC_FAILED)
                        return@withLock
                    }
                    val params = BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(details)
                        .setOfferToken(token)
                        .build()
                    val flowParams = BillingFlowParams.newBuilder()
                        .setProductDetailsParamsList(listOf(params))
                        .build()
                    val result = billingClient.launchBillingFlow(activity, flowParams)
                    when (result.responseCode) {
                        BillingClient.BillingResponseCode.OK -> refreshInternal()
                        BillingClient.BillingResponseCode.USER_CANCELED -> Unit
                        else -> _state.value = _state.value.copy(syncError = Texts.BILLING_SYNC_FAILED)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _state.value = _state.value.copy(syncError = Texts.BILLING_SYNC_FAILED)
                }
            }
        }
    }

    private suspend fun refreshInternal() {
        val client = api() ?: run {
            _state.value = BillingPlanState()
            return
        }
        val tokens = integrity ?: return
        val status = client.billingStatus()
        if (!status.enabled) {
            productDetails = null
            offerToken = null
            _state.value = BillingPlanState(status = status)
            return
        }
        var formattedPrice = _state.value.formattedPrice
        var productId = _state.value.productId
        val googleIds = status.google?.productIds.orEmpty()
        if (googleIds.isNotEmpty()) {
            loadProductDetails(googleIds)?.let { (details, price) ->
                formattedPrice = price ?: formattedPrice
                productId = details.productId
            }
        }
        val purchases = queryPurchasedPurchases()
        // 報告する購入が無ければ端末検証も送信もしない。空の報告はサーバーの状態を変えない。
        val synced = if (purchases.isEmpty()) status else BillingSync(client, tokens).sync(purchases)
        _state.value = BillingPlanState(
            status = synced,
            formattedPrice = formattedPrice,
            productId = productId ?: status.google?.productIds?.firstOrNull(),
            syncError = null,
        )
    }

    /** SUBS の商品詳細を取り、ベースプランの offer と月額表示を覚える。 */
    private suspend fun loadProductDetails(productIds: List<String>): Pair<ProductDetails, String?>? {
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
        val details = result.productDetailsList?.firstOrNull() ?: return null
        val offer = details.subscriptionOfferDetails
            ?.firstOrNull { it.offerId == null }
            ?: details.subscriptionOfferDetails?.firstOrNull()
            ?: return null
        productDetails = details
        offerToken = offer.offerToken
        return details to monthlyPrice(offer)
    }

    private fun monthlyPrice(offer: ProductDetails.SubscriptionOfferDetails): String? {
        val phases = offer.pricingPhases.pricingPhaseList
        val phase = phases.firstOrNull {
            it.billingPeriod == "P1M" && it.recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING
        } ?: phases.lastOrNull()
        return phase?.formattedPrice
    }

    /** 購入済み (PURCHASED) の定期購入をすべて取り出す。保留中は含めない。 */
    private suspend fun queryPurchasedPurchases(): List<PurchaseRef> {
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
            .flatMap { purchase -> purchase.products.map { productId -> PurchaseRef(productId, purchase.purchaseToken) } }
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
