package io.github.yusukeiwaki.oyobidashi.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import io.github.yusukeiwaki.oyobidashi.core.CredentialStore
import io.github.yusukeiwaki.oyobidashi.core.Credentials
import io.github.yusukeiwaki.oyobidashi.core.Draft
import io.github.yusukeiwaki.oyobidashi.core.DraftStore
import io.github.yusukeiwaki.oyobidashi.core.InMemoryCredentialStore
import io.github.yusukeiwaki.oyobidashi.core.OyobidashiJson

/** `url` と `device_token` を EncryptedSharedPreferences (Android Keystore の鍵で暗号化) に保存する。 */
class EncryptedCredentialStore(private val prefs: SharedPreferences) : CredentialStore {
    override fun load(): Credentials? {
        val url = prefs.getString(KEY_URL, null)
        val token = prefs.getString(KEY_TOKEN, null)
        if (url.isNullOrEmpty() || token.isNullOrEmpty()) return null
        return Credentials(url, token, prefs.getString(KEY_DEVICE_ID, null), prefs.getString(KEY_DEVICE_NAME, null))
    }

    override fun save(credentials: Credentials) {
        prefs.edit()
            .putString(KEY_URL, credentials.baseUrl)
            .putString(KEY_TOKEN, credentials.deviceToken)
            .putString(KEY_DEVICE_ID, credentials.deviceId)
            .putString(KEY_DEVICE_NAME, credentials.deviceName)
            .apply()
    }

    override fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val TAG = "oyobidashi"
        private const val FILE = "oyobidashi_credentials"
        private const val KEY_URL = "base_url"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_NAME = "device_name"

        /** Keystore が壊れている等で開けない場合は、ファイルを消して1度だけ作り直す。それでも駄目ならメモリのみ (再起動で再ペアリング)。 */
        fun create(context: Context): CredentialStore {
            fun open(): SharedPreferences = EncryptedSharedPreferences.create(
                FILE,
                MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC),
                context,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return try {
                EncryptedCredentialStore(open())
            } catch (e: Exception) {
                Log.w(TAG, "credential store could not be opened; resetting", e)
                try {
                    context.deleteSharedPreferences(FILE)
                    EncryptedCredentialStore(open())
                } catch (e2: Exception) {
                    Log.e(TAG, "credential store unavailable; falling back to memory", e2)
                    InMemoryCredentialStore()
                }
            }
        }
    }
}

/** 未送信の回答の下書き。秘密情報ではないので通常の SharedPreferences に JSON で保存する。 */
class PrefsDraftStore(context: Context) : DraftStore {
    private val prefs = context.getSharedPreferences("oyobidashi_drafts", Context.MODE_PRIVATE)

    override fun loadAll(): Map<String, Draft> = prefs.all.mapNotNull { (id, value) ->
        val json = value as? String ?: return@mapNotNull null
        try {
            id to OyobidashiJson.decodeFromString(Draft.serializer(), json)
        } catch (e: Exception) {
            null
        }
    }.toMap()

    override fun put(requestId: String, draft: Draft) {
        prefs.edit().putString(requestId, OyobidashiJson.encodeToString(Draft.serializer(), draft)).apply()
    }

    override fun remove(requestId: String) {
        prefs.edit().remove(requestId).apply()
    }

    override fun clear() {
        prefs.edit().clear().apply()
    }
}
