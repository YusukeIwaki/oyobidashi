package me.oyobidashi.android.billing

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import me.oyobidashi.android.core.IntegrityTokens
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Play Integrity (standard request) の token 発行。
 *
 * token provider は準備して使い回し、失効したら一度だけ準備し直す。
 */
class PlayIntegrityTokens(context: Context, cloudProjectNumber: String) : IntegrityTokens {
    private val manager: StandardIntegrityManager = IntegrityManagerFactory.createStandard(context.applicationContext)
    private val projectNumber: Long = cloudProjectNumber.trim().toLongOrNull() ?: 0L
    private val prepareMutex = Mutex()

    @Volatile
    private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null

    override suspend fun token(requestHash: String): String {
        val current = provider ?: prepareMutex.withLock { provider ?: prepare().also { provider = it } }
        return try {
            current.requestToken(requestHash)
        } catch (e: StandardIntegrityException) {
            if (e.errorCode != StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) throw e
            // provider が失効した。準備し直して一度だけ再試行する。
            val refreshed = prepareMutex.withLock { prepare().also { provider = it } }
            refreshed.requestToken(requestHash)
        }
    }

    private suspend fun prepare(): StandardIntegrityManager.StandardIntegrityTokenProvider {
        val request = StandardIntegrityManager.PrepareIntegrityTokenRequest.builder()
            .setCloudProjectNumber(projectNumber)
            .build()
        return manager.prepareIntegrityToken(request).awaitTask()
    }

    private suspend fun StandardIntegrityManager.StandardIntegrityTokenProvider.requestToken(requestHash: String): String {
        val request = StandardIntegrityManager.StandardIntegrityTokenRequest.builder()
            .setRequestHash(requestHash)
            .build()
        return request(request).awaitTask().token()
    }

    private suspend fun <T> Task<T>.awaitTask(): T = suspendCancellableCoroutine { cont ->
        addOnSuccessListener { result -> if (cont.isActive) cont.resume(result) }
        addOnFailureListener { error -> if (cont.isActive) cont.resumeWithException(error) }
    }
}
