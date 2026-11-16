import AVFoundation
import Observation
import Speech

/// 音声入力 (SFSpeechRecognizer + AVAudioEngine)。認識途中の結果を逐次 `onText` に渡す。
@MainActor
@Observable
final class SpeechInput {
    private(set) var isRecording = false
    var errorMessage: String?

    @ObservationIgnored private var engine: SpeechEngine?

    /// 録音を開始する。`onText` には認識結果の全文 (途中経過を含む) が渡される。
    func start(onText: @escaping @MainActor (String) -> Void) async {
        guard !isRecording else { return }
        errorMessage = nil
        guard await SpeechPermissions.requestSpeech() else {
            errorMessage = "音声認識が許可されていません。設定アプリで許可してください"
            return
        }
        guard await SpeechPermissions.requestMicrophone() else {
            errorMessage = "マイクの使用が許可されていません。設定アプリで許可してください"
            return
        }
        guard let recognizer = SFSpeechRecognizer() ?? SFSpeechRecognizer(locale: Locale(identifier: "ja-JP")), recognizer.isAvailable else {
            errorMessage = "音声認識を利用できません"
            return
        }
        let engine = SpeechEngine(recognizer: recognizer)
        do {
            try engine.start(
                onText: { text in DispatchQueue.main.async { onText(text) } },
                onFinish: { [weak self] message in
                    DispatchQueue.main.async {
                        guard let self, self.engine === engine else { return }
                        self.engine = nil
                        self.isRecording = false
                        if let message { self.errorMessage = message }
                    }
                }
            )
            self.engine = engine
            isRecording = true
        } catch {
            engine.stop()
            errorMessage = "録音を開始できませんでした"
        }
    }

    func stop() {
        engine?.stop()
        engine = nil
        isRecording = false
    }
}

enum SpeechPermissions {
    static func requestSpeech() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    static func requestMicrophone() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}

/// オーディオのコールバックはメインスレッド外で呼ばれるので、actor に属さないクラスに閉じ込める。
final class SpeechEngine: @unchecked Sendable {
    private let recognizer: SFSpeechRecognizer
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let lock = NSLock()
    private var finished = false
    private var onFinish: ((String?) -> Void)?

    init(recognizer: SFSpeechRecognizer) {
        self.recognizer = recognizer
    }

    func start(onText: @escaping (String) -> Void, onFinish: @escaping (String?) -> Void) throws {
        self.onFinish = onFinish
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        self.request = request

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "oyobidashi.speech", code: 1)
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            if let result {
                let text = result.bestTranscription.formattedString
                if !text.isEmpty { onText(text) }
                if result.isFinal { self?.finish(message: nil) }
            }
            if error != nil {
                // 無音のまま終了した場合などもここに来る。途中までの結果は onText で渡し済み。
                self?.finish(message: nil)
            }
        }
    }

    /// ユーザー操作による停止。
    func stop() {
        finish(message: nil)
    }

    private func finish(message: String?) {
        let callback: ((String?) -> Void)? = lock.withLock {
            guard !finished else { return nil }
            finished = true
            return onFinish
        }
        guard let callback else { return }
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        callback(message)
    }
}
