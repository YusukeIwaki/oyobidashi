package me.oyobidashi.android.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

/**
 * SpeechRecognizer の薄いラッパー。途中結果 (partial results) も [start] の onText に流すので、
 * そのままテキスト欄に反映して送信前に編集できる。メインスレッド専用。
 */
class VoiceInput(private val context: Context) {
    val available: Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    var listening by mutableStateOf(false)
        private set

    private var recognizer: SpeechRecognizer? = null

    fun start(onText: (String) -> Unit, onError: (String) -> Unit) {
        if (!available || listening) return
        val sr = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { recognizer = it }
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onPartialResults(partialResults: Bundle?) = deliver(partialResults)
            override fun onResults(results: Bundle?) {
                deliver(results)
                listening = false
            }

            override fun onError(error: Int) {
                listening = false
                // ユーザーが停止した場合 (CLIENT) はエラー表示しない
                if (error != SpeechRecognizer.ERROR_CLIENT) onError(errorMessage(error))
            }

            private fun deliver(bundle: Bundle?) {
                val text = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (text.isNotEmpty()) onText(text)
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        try {
            sr.startListening(intent)
            listening = true
        } catch (e: RuntimeException) {
            listening = false
            onError("音声入力を開始できませんでした")
        }
    }

    /** 聞き取りを終えて、そこまでの結果を確定させる。 */
    fun stop() {
        if (listening) recognizer?.stopListening()
    }

    fun destroy() {
        listening = false
        recognizer?.destroy()
        recognizer = null
    }

    private fun errorMessage(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "音声を認識できませんでした"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "マイクの権限がありません"
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER ->
            "音声認識サービスに接続できません"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "音声認識が使用中です。少し待ってからお試しください"
        else -> "音声入力でエラーが発生しました"
    }
}
