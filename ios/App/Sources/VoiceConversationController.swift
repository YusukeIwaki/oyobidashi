import AVFoundation
import OyobidashiKit
import Observation
import Speech

/// CallKit 音声 (didActivate) 上で「読み上げ → 聞き取り → 完了発話だけ送信 → 返答読み上げ」を回す。
/// 部分認識結果は表示専用で、ネットワークへは絶対に送らない。送信は確定 (isFinal) した発話のみ。
@MainActor
@Observable
final class VoiceConversationController: NSObject, AVSpeechSynthesizerDelegate {
    enum Phase: Equatable {
        case idle
        case speaking
        case listening
        case sendingTurn
        case failed(String)
        case ended
    }

    private(set) var phase: Phase = .idle {
        didSet {
            #if DEBUG
            // Record lifecycle only: no recognized words or conversation content in device logs.
            let name: String
            switch phase {
            case .idle: name = "idle"
            case .speaking: name = "speaking"
            case .listening: name = "listening"
            case .sendingTurn: name = "sending_turn"
            case .failed(let reason): name = "failed: \(reason)"
            case .ended: name = "ended"
            }
            print("[oyobidashi.voice] phase=\(name)")
            #endif
        }
    }
    private(set) var isMuted = false
    @ObservationIgnored private var listeningGeneration = 0
    /// 認識中の下書き (部分結果を含む)。送信されるまでは下書き。
    private(set) var liveTranscript: String = ""
    private(set) var lastAssistantText: String = ""
    private(set) var lastUserText: String = ""
    var errorMessage: String? {
        if case .failed(let m) = phase { return m }
        return nil
    }

    /// 読み上げ完了後に通話終了すべきとき、協調クラスが CXEndCallAction を要求するためのフック。
    var onRequestEndCall: (@MainActor () -> Void)?
    /// 権限不足などで会話を開始できないとき (failCall 送信は呼び出し側でも行う)。
    var onConversationFailed: (@MainActor (String) -> Void)?

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private weak var model: AppModel?
    @ObservationIgnored private var requestID: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var pendingResolvedEnd = false
    @ObservationIgnored private var usesCallKitAudio = false
    @ObservationIgnored private var audioEngine: AVAudioEngine?
    @ObservationIgnored private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var recognitionTask: SFSpeechRecognitionTask?
    @ObservationIgnored private var finalSentForCurrentListen = false
    @ObservationIgnored private var silenceTask: Task<Void, Never>?
    @ObservationIgnored private var turnTask: Task<Void, Never>?

    override init() {
        super.init()
        synthesizer.usesApplicationAudioSession = true
        synthesizer.delegate = self
    }

    func attach(model: AppModel) {
        self.model = model
    }

    // MARK: Lifecycle

    /// 会話開始。`initialText` は answer 応答の reply (無ければ質問文)。
    /// 応答したら、確認を挟まずに質問の読み上げから始める。
    func startConversation(requestID: String, initialText: String, usesCallKitAudio: Bool) async {
        // Keep the session that CallKit just activated when resetting recognition.
        self.usesCallKitAudio = usesCallKitAudio
        cancelCurrentWork()
        generation += 1
        let gen = generation
        self.requestID = requestID
        pendingResolvedEnd = false
        liveTranscript = ""
        lastUserText = ""
        lastAssistantText = ""
        // 権限は読み上げの前にまとめて確認する (途中で切れると会話が止まるため)。
        guard await SpeechPermissions.requestSpeech() else {
            failConversation("音声認識が許可されていません。設定アプリで許可してください", gen: gen)
            return
        }
        guard await SpeechPermissions.requestMicrophone() else {
            failConversation("マイクの使用が許可されていません。設定アプリで許可してください", gen: gen)
            return
        }
        guard generation == gen else { return }
        // An interrupted POST may already have been committed. Recover that utterance
        // before recognizing a new one, including after process recreation.
        if let draft = model?.drafts.draft(for: requestID), draft.voiceTurnID != nil {
            finalSentForCurrentListen = false
            sendTurnIfCompleted(draft.text, gen: gen, explicit: true)
            return
        }
        speak(initialText, isFinalReply: false, gen: gen)
    }

    /// ユーザーが終了した/リモート終了したときの後片付け。冪等。
    func endConversation() {
        isMuted = false
        generation += 1
        cancelCurrentWork()
        phase = .ended
        liveTranscript = ""
        lastAssistantText = ""
        lastUserText = ""
        requestID = nil
    }

    func setMuted(_ muted: Bool) {
        guard isMuted != muted else { return }
        isMuted = muted
        if muted && phase == .listening {
            cleanupAudio()
        } else if !muted && phase == .listening {
            startListening(gen: generation)
        }
    }

    func cancel() {
        generation += 1
        cancelCurrentWork()
        phase = .idle
    }

    private func cancelCurrentWork() {
        turnTask?.cancel()
        turnTask = nil
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        stopListening(sendFinal: false)
    }

    private func failConversation(_ message: String, gen: Int) {
        guard generation == gen else { return }
        cancelCurrentWork()
        phase = .failed(message)
        onConversationFailed?(message)
    }

    // MARK: Speaking

    private func speak(_ text: String, isFinalReply: Bool, gen: Int) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            if isFinalReply { finishAfterFinalReply(gen: gen) } else { startListening(gen: gen) }
            return
        }
        stopListening(sendFinal: false)
        lastAssistantText = trimmed
        pendingResolvedEnd = isFinalReply
        phase = .speaking
        let utterance = AVSpeechUtterance(string: trimmed)
        utterance.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        synthesizer.speak(utterance)
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            guard let self, self.phase == .speaking else { return }
            let gen = self.generation
            if self.pendingResolvedEnd {
                self.pendingResolvedEnd = false
                self.finishAfterFinalReply(gen: gen)
            } else {
                self.startListening(gen: gen)
            }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        // cancel() 側で状態遷移するのでここでは何もしない。
    }

    private func finishAfterFinalReply(gen: Int) {
        guard generation == gen else { return }
        // 最終返答を読み終えた後にだけ通話を終える。
        #if DEBUG
        print("[oyobidashi.voice] final_reply_finished")
        #endif
        phase = .ended
        onRequestEndCall?()
    }

    // MARK: Listening

    private func startListening(gen: Int) {
        guard generation == gen, let _ = requestID else { return }
        func failed(_ message: String) {
            phase = .failed(message)
            cleanupAudio()
        }
        guard !isMuted else { phase = .listening; return }
        listeningGeneration += 1
        let listenID = listeningGeneration
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ja-JP")) ?? SFSpeechRecognizer(), recognizer.isAvailable else {
            failed("音声認識を利用できません。文字入力に切り替えてください")
            return
        }
        // オーディオセッション: CallKit 管理下ではカテゴリ変更を最小限にし、自分で有効化しない。
        if !usesCallKitAudio {
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
            try? session.setActive(true, options: [])
        }
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = false
        audioEngine = engine
        recognitionRequest = request
        finalSentForCurrentListen = false
        liveTranscript = ""
        phase = .listening

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            failed("マイクを利用できません")
            return
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            failed("録音を開始できませんでした")
            return
        }
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            // コールバックは任意スレッド。MainActor に寄せる。
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            let hasError = error != nil
            Task { @MainActor [weak self] in
                guard let self, self.generation == gen, self.listeningGeneration == listenID, !self.isMuted, self.phase == .listening else { return }
                if let text, !text.isEmpty {
                    if self.liveTranscript != text {
                        self.liveTranscript = text
                        self.finishAudioAfterSilence(listenID: listenID)
                    }
                }
                if isFinal {
                    // 確定した発話だけを送信する (部分結果は送らない)。
                    let completed = self.liveTranscript
                    self.stopListening(sendFinal: false)
                    self.sendTurnIfCompleted(completed, gen: gen)
                } else if hasError {
                    // 無音終了など。確定テキストがあればそれを完了発話として扱わず、再聞き取り可能にする。
                    // ここで自動送信はしない。
                    self.stopListening(sendFinal: false)
                    if ConversationPolicy.shouldSendTurn(text: self.liveTranscript, isFinal: false) == false {
                        // 部分しか無い場合は送らず、失敗として再試行できる状態にする。
                        if !self.liveTranscript.isEmpty {
                            self.phase = .failed("聞き取りが完了しませんでした。「話し終わった」を押して送信するか、もう一度お話しください")
                        } else {
                            self.phase = .failed("聞き取れませんでした。もう一度お話しください")
                        }
                    }
                }
            }
        }
    }

    private func finishAudioAfterSilence(listenID: Int) {
        silenceTask?.cancel()
        // Speech must still return its final result. The timer only closes the input.
        silenceTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(1400)) } catch { return }
            guard let self, self.listeningGeneration == listenID else { return }
            self.audioEngine?.stop()
            self.recognitionRequest?.endAudio()
        }
    }

    /// アプリ内画面の「話し終わった」: 現在の認識を確定発話として送信する明示操作。
    func submitCurrentTranscript() {
        guard phase == .listening else { return }
        let gen = generation
        let completed = liveTranscript
        stopListening(sendFinal: false)
        sendTurnIfCompleted(completed, gen: gen, explicit: true)
    }

    /// 聞き直し。
    func listenAgain() {
        guard let _ = requestID else { return }
        if case .failed = phase {
            startListening(gen: generation)
        }
    }

    var canRetryLastTurn: Bool {
        if case .failed = phase { return requestID != nil && !lastUserText.isEmpty }
        return false
    }

    /// Reuse the persisted ID when delivery was uncertain; an explicit retry of a
    /// failed model turn gets a new ID through AppModel.
    func retryLastTurn() {
        guard canRetryLastTurn else { return }
        finalSentForCurrentListen = false
        sendTurnIfCompleted(lastUserText, gen: generation, explicit: true)
    }

    private func sendTurnIfCompleted(_ text: String, gen: Int, explicit: Bool = false) {
        // explicit (ボタン) はユーザーの明示確定なので final 扱い。それ以外は isFinal 経由でのみここに来る。
        let isFinal = true
        guard ConversationPolicy.shouldSendTurn(text: text, isFinal: isFinal) else {
            phase = .failed("発話が空でした。もう一度お話しください")
            return
        }
        guard !finalSentForCurrentListen else { return }
        finalSentForCurrentListen = true
        lastUserText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        liveTranscript = ""
        phase = .sendingTurn
        guard let model, let requestID else {
            phase = .failed("接続情報がありません")
            return
        }
        turnTask = Task { @MainActor [weak self] in
            guard let self, self.generation == gen else { return }
            let outcome = await model.sendCallTurn(requestID: requestID, text: text)
            guard self.generation == gen else { return }
            self.turnTask = nil
            switch outcome {
            case .success(let resp):
                let reply = resp.reply ?? ""
                let resolved = resp.resolved ?? (resp.request.status == .answered)
                if !reply.isEmpty {
                    self.speak(reply, isFinalReply: ConversationPolicy.shouldEndAfterSpeaking(resolved: resolved), gen: gen)
                } else if resolved {
                    self.finishAfterFinalReply(gen: gen)
                } else {
                    self.startListening(gen: gen)
                }
            case .unauthorized:
                self.phase = .failed("認証に失敗しました。ペアリングし直してください")
                self.onConversationFailed?("認証に失敗しました")
            case .unreachable:
                self.phase = .failed(RelayError.unreachableMessage + "。もう一度送信できます")
            case .failed(let error):
                self.phase = .failed(error.userMessage)
            }
        }
    }

    private func stopListening(sendFinal: Bool) {
        // sendFinal は使わない (自動送信しないため)。後片付けのみ。
        _ = sendFinal
        cleanupAudio()
        if phase == .listening { /* 呼び出し側が次状態を決める */ }
    }

    private func cleanupAudio() {
        listeningGeneration += 1
        silenceTask?.cancel()
        silenceTask = nil
        if let engine = audioEngine {
            if engine.isRunning { engine.stop() }
            engine.inputNode.removeTap(onBus: 0)
        }
        audioEngine = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        if !usesCallKitAudio {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
