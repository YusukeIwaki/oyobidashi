package me.oyobidashi.android.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import me.oyobidashi.android.billing.BillingPlanState

@Composable
internal fun PlanDialog(
    billing: BillingPlanState,
    purchase: (Activity) -> Unit,
    restore: () -> Unit,
    refresh: () -> Unit,
    close: () -> Unit,
) {
    val status = billing.status ?: return
    val context = LocalContext.current
    val activity = context as? Activity
    val stores = status.activeStores.orEmpty()
    var manageError by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(if (status.active) "現在のプラン：PLUS" else "プランを変更") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (!status.active) {
                    Text("FREE", style = MaterialTheme.typography.titleMedium)
                    Text(Texts.billingVoiceTraining(status.voiceTraining?.free))
                    Text("PLUS", style = MaterialTheme.typography.titleMedium)
                }
                Text(Texts.billingVoiceTraining(status.voiceTraining?.plus))
                if (status.active) {
                    val expiry = Texts.billingExpiry(status.expiresAt)
                    if (expiry.isNotEmpty()) Text(expiry)
                    if ("google" in stores) {
                        Text("Google Playで解約できます。解約後も購読の有効期限まではPLUSをご利用いただけます。")
                        TextButton(onClick = {
                            val uri = Uri.parse("https://play.google.com/store/account/subscriptions")
                                .buildUpon().apply {
                                    status.google?.productIds?.singleOrNull()?.let {
                                        appendQueryParameter("sku", it)
                                        appendQueryParameter("package", context.packageName)
                                    }
                                }.build()
                            try {
                                context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                                manageError = false
                            } catch (_: ActivityNotFoundException) {
                                manageError = true
                            }
                        }) { Text("Google Playで購読を管理") }
                    }
                    if ("apple" in stores) Text("App Storeで購入した購読は、iPhoneの設定から管理できます。")
                    if (stores.isEmpty()) Text("購入したストアで購読を管理できます。")
                } else if (billing.googleAvailable) {
                    when {
                        billing.loadingPrice -> Text("料金を取得中…")
                        billing.formattedPrice != null -> {
                            Text("${billing.formattedPrice}/月")
                            Text("毎月自動更新されます。Google Playで解約できます。")
                        }
                        else -> Text("Google Playから料金を取得できませんでした。")
                    }
                } else {
                    Text("この接続先ではGoogle Playでの購入を利用できません。")
                }
                if (billing.syncError != null) Text(billing.syncError, color = MaterialTheme.colorScheme.error)
                if (manageError) Text(Texts.BILLING_MANAGE_FAILED, color = MaterialTheme.colorScheme.error)
                billing.notice?.let { Text(it) }
                if (billing.syncError != null || (!status.active && billing.googleAvailable && billing.formattedPrice == null && !billing.loadingPrice)) {
                    TextButton(onClick = refresh, enabled = !billing.working) { Text("再読み込み") }
                }
                if (billing.googleAvailable) {
                    TextButton(onClick = restore, enabled = !billing.working) { Text("Google Playの購入を復元") }
                }
            }
        },
        confirmButton = {
            if (!status.active && billing.googleAvailable && activity != null) {
                Button(
                    onClick = { purchase(activity) },
                    enabled = billing.formattedPrice != null && !billing.loadingPrice && !billing.working,
                ) { Text("PLUSに変更") }
            }
        },
        dismissButton = { TextButton(onClick = close) { Text("閉じる") } },
    )
}
