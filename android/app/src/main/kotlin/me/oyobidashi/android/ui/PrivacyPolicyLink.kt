package me.oyobidashi.android.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext

private const val PRIVACY_POLICY_URL = "https://ai.oyobidashi.me/privacy/"

@Composable
internal fun PrivacyPolicyLink(modifier: Modifier = Modifier) {
    SupportLink("プライバシーポリシー", PRIVACY_POLICY_URL, modifier)
}

@Composable
internal fun AccountDeletionLink(modifier: Modifier = Modifier) {
    SupportLink("アカウント削除の申請", "$PRIVACY_POLICY_URL#account-deletion", modifier)
}

@Composable
private fun SupportLink(label: String, url: String, modifier: Modifier) {
    val context = LocalContext.current
    TextButton(
        modifier = modifier,
        onClick = {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(context, "$url をブラウザで開いてください。", Toast.LENGTH_LONG).show()
            }
        },
    ) { Text(label) }
}
