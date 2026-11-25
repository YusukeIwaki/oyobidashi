import OyobidashiKit
import SwiftUI

/// 応答後の通話状態・字幕・終了操作と、CallKitが使えない環境の着信画面。
struct InAppCallView: View {
    let request: AgentRequest
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(CallKitCoordinator.self) private var callKit
    @State private var answering = false
    @State private var actionError: String?
    @State private var hasAnswered = false

    init(request: AgentRequest) {
        self.request = request
        _hasAnswered = State(initialValue: request.call?.state == .active)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                header
                if !CallKitCoordinator.isCallKitAvailable {
                    Label("シミュレータのため、アプリ内通話画面で表示しています", systemImage: "iphone")
                        .font(.caption)
                        .foregroundStyle(PagerTheme.inkSoft)
                        .padding(10)
                        .frame(maxWidth: .infinity)
                        .background(PagerTheme.lcd.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
                } else if let err = callKit.lastReportError {
                    Label("通話画面を表示できませんでした (\(err))。アプリ内で応答できます", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if let subject = CallPresentation.singleLine(request.subject) {
                    Text(subject)
                        .font(.headline)
                        .foregroundStyle(PagerTheme.orange)
                        .multilineTextAlignment(.center)
                }

                Text(request.question)
                    .font(.title3.bold())
                    .foregroundStyle(PagerTheme.ink)
                    .multilineTextAlignment(.center)

                if let context = request.context, !context.isEmpty {
                    Text(context)
                        .font(.callout)
                        .foregroundStyle(PagerTheme.inkSoft)
                        .multilineTextAlignment(.center)
                }

                statusArea

                if let actionError {
                    Text(actionError)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                controls
            }
            .padding(24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PagerTheme.cream.ignoresSafeArea())
        .onChange(of: model.store.request(id: request.id)?.call?.state) { _, state in
            if state == .active, model.store.request(id: request.id)?.call?.deviceID == model.myDeviceID {
                hasAnswered = true
            }
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            PagerIconView(size: 44)
            Text(request.agent?.name ?? "エージェント")
                .font(.headline)
                .foregroundStyle(PagerTheme.ink)
            Text(hasAnswered ? "通話中" : "着信中…")
                .font(.subheadline.bold())
                .foregroundStyle(hasAnswered ? Color.green : PagerTheme.orange)
        }
    }

    @ViewBuilder
    private var statusArea: some View {
        let voice = callKit.voice
        VStack(spacing: 8) {
            switch voice.phase {
            case .speaking:
                Label("読み上げ中…", systemImage: "speaker.wave.2.fill").foregroundStyle(PagerTheme.inkSoft)
                if !voice.lastAssistantText.isEmpty {
                    Text(voice.lastAssistantText).font(.callout).foregroundStyle(PagerTheme.ink)
                }
            case .listening:
                Label("聞き取り中… お話しください", systemImage: "mic.fill").foregroundStyle(PagerTheme.orange)
                if !voice.liveTranscript.isEmpty {
                    Text(voice.liveTranscript)
                        .font(.callout)
                        .foregroundStyle(PagerTheme.ink)
                        .padding(10)
                        .frame(maxWidth: .infinity)
                        .background(Color.white.opacity(0.7), in: RoundedRectangle(cornerRadius: 10))
                    Text("※ 確定するまで送信されません")
                        .font(.caption2).foregroundStyle(PagerTheme.inkSoft)
                }
            case .sendingTurn:
                HStack { ProgressView(); Text("送信中…") }.foregroundStyle(PagerTheme.inkSoft)
            case .failed(let message):
                Label(message, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.callout)
            case .idle, .ended:
                EmptyView()
            }
            if !voice.lastUserText.isEmpty {
                Text("あなた: \(voice.lastUserText)")
                    .font(.caption).foregroundStyle(PagerTheme.inkSoft)
            }
        }
    }

    @ViewBuilder
    private var controls: some View {
        let voice = callKit.voice
        if !hasAnswered {
            HStack(spacing: 28) {
                Button(role: .destructive) {
                    Task { await decline() }
                } label: {
                    VStack(spacing: 6) {
                        Image(systemName: "phone.down.fill").font(.title2)
                        Text("拒否").font(.caption.bold())
                    }
                    .frame(width: 76, height: 76)
                    .background(Color.red, in: Circle())
                    .foregroundStyle(.white)
                }
                Button {
                    Task { await answer() }
                } label: {
                    VStack(spacing: 6) {
                        if answering { ProgressView().tint(.white) } else { Image(systemName: "phone.fill").font(.title2) }
                        Text("応答").font(.caption.bold())
                    }
                    .frame(width: 76, height: 76)
                    .background(Color.green, in: Circle())
                    .foregroundStyle(.white)
                }
                .disabled(answering)
            }
        } else {
            VStack(spacing: 12) {
                if callKit.activeCallUUID == nil && (voice.phase == .idle || voice.phase == .ended) {
                    Text("通話が中断されました。再開するか、終了して文字で返信できます")
                        .font(.caption)
                        .foregroundStyle(PagerTheme.inkSoft)
                    Button {
                        Task {
                            let current = model.store.request(id: request.id) ?? request
                            let reply = current.call?.transcript.last(where: { $0.role == .assistant })?.text ?? current.question
                            await callKit.startFallbackConversation(request: current, initialReply: reply)
                        }
                    } label: {
                        Label("通話を再開", systemImage: "mic.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(PagerTheme.orange)
                }
                if voice.phase == .listening {
                    Button {
                        voice.submitCurrentTranscript()
                    } label: {
                        Label("話し終わった (送信)", systemImage: "paperplane.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(PagerTheme.orange)
                    .disabled(voice.liveTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if case .failed = voice.phase {
                    if voice.canRetryLastTurn {
                        Button {
                            voice.retryLastTurn()
                        } label: {
                            Label("前の発話を確認・再送信", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(PagerTheme.orange)
                    }
                    Button {
                        voice.listenAgain()
                    } label: {
                        Label("もう一度聞き取る", systemImage: "mic.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(PagerTheme.orange)
                }
                Button(role: .destructive) {
                    Task { await hangup() }
                } label: {
                    Label("終了して文字で返信", systemImage: "phone.down.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }
        }
    }

    private func answer() async {
        answering = true
        actionError = nil
        defer { answering = false }
        let outcome = await model.answerCall(requestID: request.id)
        switch outcome {
        case .success(let resp):
            hasAnswered = true
            await callKit.startFallbackConversation(request: resp.request, initialReply: resp.reply ?? resp.request.question)
        case .unauthorized:
            actionError = "認証に失敗しました。ペアリングし直してください"
        case .unreachable:
            actionError = RelayError.unreachableMessage
        case .failed(let e):
            actionError = e.userMessage
        }
    }

    private func decline() async {
        _ = await model.declineCall(requestID: request.id)
        model.fallbackCallRequest = nil
    }

    private func hangup() async {
        router.open(requestID: request.id)
        if CallKitCoordinator.isCallKitAvailable, callKit.activeCallUUID != nil {
            callKit.endActiveCallViaSystem()
            return
        }
        callKit.voice.endConversation()
        _ = await model.hangupCall(requestID: request.id)
        model.fallbackCallRequest = nil
    }
}
