package io.github.yusukeiwaki.oyobidashi.call

import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccountHandle
import android.util.Log
import io.github.yusukeiwaki.oyobidashi.graph

/**
 * 自前管理 (self-managed) の通話接続。着信は [CallManager] が
 * TelecomManager.addNewIncomingCall で積み、ここで [OyobidashiConnection] を作る。
 * システムの通話 UI は出ないため、応答・拒否の UI は自前の CallStyle 通知と [CallActivity] が担う。
 * Bluetooth 等からの応答・切断要求は [Connection.onAnswer]/[Connection.onReject]/[Connection.onDisconnect]
 * で受けて [CallManager] に回す。
 */
class OyobidashiConnectionService : ConnectionService() {
    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ): Connection {
        val extras = request?.extras
        val requestId = extras?.getString(CallManager.EXTRA_REQUEST_ID)
        val callId = extras?.getString(CallManager.EXTRA_CALL_ID)
        Log.i(CallManager.TAG, "onCreateIncomingConnection request=$requestId call=$callId")
        val conn = OyobidashiConnection(
            requestId = requestId,
            callId = callId,
            onAnswerCallback = {
                try {
                    applicationContext.graph.callManager.onConnectionAnswer(requestId, callId)
                } catch (e: RuntimeException) {
                    Log.w(CallManager.TAG, "answer callback failed", e)
                }
            },
            onRejectCallback = {
                try {
                    applicationContext.graph.callManager.onConnectionReject(requestId, callId)
                } catch (e: RuntimeException) {
                    Log.w(CallManager.TAG, "reject callback failed", e)
                }
            },
            onDisconnectCallback = {
                try {
                    applicationContext.graph.callManager.onConnectionDisconnect(requestId, callId)
                } catch (e: RuntimeException) {
                    Log.w(CallManager.TAG, "disconnect callback failed", e)
                }
            },
        )
        conn.setRinging()
        try {
            applicationContext.graph.callManager.onConnectionCreated(conn, requestId, callId)
        } catch (e: RuntimeException) {
            Log.w(CallManager.TAG, "callManager unavailable", e)
            conn.setDisconnected(DisconnectCause(DisconnectCause.ERROR))
            conn.destroy()
        }
        return conn
    }

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?,
    ) {
        Log.w(CallManager.TAG, "onCreateIncomingConnectionFailed")
        val requestId = request?.extras?.getString(CallManager.EXTRA_REQUEST_ID)
        val callId = request?.extras?.getString(CallManager.EXTRA_CALL_ID)
        if (requestId != null && callId != null) applicationContext.graph.callManager.postFailed(requestId, callId, "システムが通話を受け付けられませんでした")
    }
}

class OyobidashiConnection(
    val requestId: String?,
    val callId: String?,
    private val onAnswerCallback: () -> Unit = {},
    private val onRejectCallback: () -> Unit = {},
    private val onDisconnectCallback: () -> Unit = {},
) : Connection() {
    init {
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
    }

    override fun onAnswer() = onAnswerCallback()
    override fun onReject() = onRejectCallback()

    override fun onDisconnect() {
        try {
            setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        } catch (e: RuntimeException) {
            Unit
        }
        try {
            destroy()
        } catch (e: RuntimeException) {
            Unit
        }
        onDisconnectCallback()
    }

    override fun onAbort() {
        try {
            setDisconnected(DisconnectCause(DisconnectCause.CANCELED))
        } catch (e: RuntimeException) {
            Unit
        }
        try {
            destroy()
        } catch (e: RuntimeException) {
            Unit
        }
    }

    /** 切断して破棄する。既に破棄済みでも落ちない。 */
    fun setDisconnectedAndDestroy() {
        try {
            setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        } catch (e: RuntimeException) {
            Unit
        }
        try {
            destroy()
        } catch (e: RuntimeException) {
            Unit
        }
    }
}
