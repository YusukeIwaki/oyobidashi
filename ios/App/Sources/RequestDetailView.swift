import OyobidashiKit
import SwiftUI

struct RequestDetailView: View {
    let requestID: String
    @Environment(AppModel.self) private var model
    @State private var loaded = false

    var body: some View {
        Group {
            if let request = model.store.request(id: requestID) {
                content(request)
            } else if loaded {
                ContentUnavailableView(
                    "質問が見つかりません",
                    systemImage: "questionmark.circle",
                    description: Text(model.store.reachability == .unreachable ? RelayError.unreachableMessage : "すでに削除された可能性があります")
                )
            } else {
                ProgressView()
            }
        }
        .background(PagerTheme.cream.ignoresSafeArea())
        .navigationTitle("お呼び出し")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: requestID) {
            await model.refreshRequest(id: requestID)
            loaded = true
        }
    }

    @ViewBuilder
    private func content(_ request: AgentRequest) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header(request)
                if request.status.isTerminal || !model.store.isPending(request) && request.status == .pending {
                    // 409 後などで手元が解決済み扱いの場合も含め、古い詳細は送信不可にする。
                    if !model.store.isPending(request) {
                        closedBanner(request)
                    }
                }
                Text(request.question)
                    .font(.title3.bold())
                    .foregroundStyle(PagerTheme.ink)
                    .textSelection(.enabled)
                if let context = request.context, !context.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("補足")
                            .font(.caption.bold())
                            .foregroundStyle(PagerTheme.inkSoft)
                        Text(context)
                            .font(.callout)
                            .foregroundStyle(PagerTheme.ink)
                            .textSelection(.enabled)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 12))
                }

                if let call = request.call {
                    callCard(request: request, call: call)
                }

                if model.store.isPending(request) {
                    AnswerPanel(request: request, model: model)
                        .id(request.id)
                } else {
                    resolved(request)
                }
            }
            .padding()
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func closedBanner(_ request: AgentRequest) -> some View {
        Label("この質問は終了しています (送信できません)", systemImage: "lock.fill")
            .font(.callout.bold())
            .foregroundStyle(PagerTheme.inkSoft)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PagerTheme.lcd.opacity(0.45), in: RoundedRectangle(cornerRadius: 12))
    }

    private func callCard(request: AgentRequest, call: CallSession) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("通話", systemImage: "phone.fill")
                    .font(.subheadline.bold())
                    .foregroundStyle(PagerTheme.ink)
                Spacer()
                Text(callStateLabel(call))
                    .font(.caption.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(call.state == .ringing ? PagerTheme.orange : (call.state == .active ? Color.green : PagerTheme.inkSoft), in: Capsule())
            }
            if let outcome = call.outcome {
                Text("結果: \(outcomeLabel(outcome))")
                    .font(.caption)
                    .foregroundStyle(PagerTheme.inkSoft)
            }
            if !call.transcript.isEmpty {
                ForEach(Array(call.transcript.enumerated()), id: \.offset) { _, entry in
                    HStack(alignment: .top, spacing: 6) {
                        Text(entry.role == .user ? "あなた" : "エージェント")
                            .font(.caption2.bold())
                            .foregroundStyle(entry.role == .user ? PagerTheme.orange : PagerTheme.lcdDeep)
                        Text(entry.text).font(.callout).foregroundStyle(PagerTheme.ink)
                    }
                }
            }
            if call.state == .ringing {
                Button {
                    model.fallbackCallRequest = request
                } label: {
                    Label("通話画面を開く", systemImage: "phone.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(PagerTheme.orange)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(PagerTheme.ink.opacity(0.08)))
    }

    private func callStateLabel(_ call: CallSession) -> String {
        switch call.state {
        case .ringing: return "着信中"
        case .active: return "通話中"
        case .ended: return "終了"
        case .unknown(let r): return r
        }
    }
    private func outcomeLabel(_ outcome: CallOutcome) -> String {
        switch outcome {
        case .resolved: return "解決"
        case .declined: return "拒否"
        case .hangup: return "終了"
        case .missed: return "不在"
        case .cancelled: return "取り消し"
        case .expired: return "期限切れ"
        case .failed: return "失敗"
        case .unknown(let r): return r
        }
    }

    private func header(_ request: AgentRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(request.agent?.name ?? "エージェント")
                    .font(.headline)
                    .foregroundStyle(PagerTheme.ink)
                Text("優先度: \(request.priority.japaneseLabel)")
                    .font(.caption2.bold())
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(PagerTheme.priorityColor(request.priority), in: Capsule())
                if request.urgency == .high {
                    Text("緊急")
                        .font(.caption2.bold())
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(.red, in: Capsule())
                        .foregroundStyle(.white)
                }
                Spacer()
                Text(request.createdAt, style: .time)
                    .font(.caption)
                    .foregroundStyle(PagerTheme.inkSoft)
            }
            HStack(spacing: 6) {
                Text(deliveryText(request))
                    .font(.caption.bold())
                    .foregroundStyle(PagerTheme.ink)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(PagerTheme.orangeSoft, in: Capsule())
                Text(StatusText.label(for: request, resolvedLocally: model.store.locallyResolvedIDs.contains(request.id)))
                    .font(.caption)
                    .foregroundStyle(PagerTheme.inkSoft)
            }
            if let cwd = request.agent?.cwd, !cwd.isEmpty {
                Text(cwd)
                    .font(.caption.monospaced())
                    .foregroundStyle(PagerTheme.inkSoft)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
        }
    }

    private func deliveryText(_ request: AgentRequest) -> String {
        switch request.deliveryMode {
        case .actions: return "ボタンで回答"
        case .text: return "文字で回答"
        case .call: return "通話で回答"
        case .unknown(let r): return r
        }
    }

    @ViewBuilder
    private func resolved(_ request: AgentRequest) -> some View {
        Divider()
        if let answer = request.answer {
            VStack(alignment: .leading, spacing: 4) {
                Text("回答 (\(StatusText.label(for: answer.inputMethod)))")
                    .font(.caption.bold())
                    .foregroundStyle(PagerTheme.inkSoft)
                Text(answer.text)
                    .foregroundStyle(PagerTheme.ink)
                    .textSelection(.enabled)
                if let answeredAt = answer.answeredAt {
                    Text(answeredAt, style: .time)
                        .font(.caption)
                        .foregroundStyle(PagerTheme.inkSoft)
                }
            }
        } else if request.kind == .notification {
            Label("お知らせ (回答は不要です)", systemImage: "bell")
                .foregroundStyle(PagerTheme.inkSoft)
        } else if request.status == .pending {
            Label(RelayError.alreadyResolved.userMessage, systemImage: "checkmark.circle")
                .foregroundStyle(PagerTheme.inkSoft)
        } else {
            Label("終了: \(StatusText.label(for: request, resolvedLocally: false))", systemImage: "xmark.circle")
                .foregroundStyle(PagerTheme.inkSoft)
        }
        // 終端では送信 UI を出さない (stale detail disabled)。
    }
}

/// 回答の入力欄 (選択肢・テキスト・音声)。状態は `AnswerViewModel` が持つ。
struct AnswerPanel: View {
    let request: AgentRequest
    @Environment(AppModel.self) private var model
    @State private var viewModel: AnswerViewModel
    @State private var speech = SpeechInput()
    @FocusState private var textFocused: Bool

    init(request: AgentRequest, model: AppModel) {
        self.request = request
        _viewModel = State(initialValue: AnswerViewModel(requestID: request.id, submitter: model, drafts: model.drafts))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            statusBanner

            let choices = request.effectiveChoices
            if !choices.isEmpty {
                if request.deliveryMode == .actions {
                    Text("ボタンを選んで回答")
                        .font(.caption.bold())
                        .foregroundStyle(PagerTheme.inkSoft)
                }
                ForEach(Array(choices.enumerated()), id: \.offset) { index, choice in
                    Button {
                        speech.stop()
                        Task { await viewModel.submitChoice(index: index, choices: choices) }
                    } label: {
                        Text(choice)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(request.deliveryMode == .actions ? PagerTheme.orange : PagerTheme.ink)
                    .controlSize(.large)
                    .disabled(!viewModel.canSubmitChoice)
                }
            }

            // text モードは通常の文字回答を主にする。actions でも自由記述は補助として残す。
            TextField(
                "回答を入力",
                text: Binding(get: { viewModel.draft }, set: { viewModel.userEdited($0) }),
                axis: .vertical
            )
            .lineLimit(3...10)
            .textFieldStyle(.roundedBorder)
            .focused($textFocused)
            .disabled(viewModel.phase == .submitting)

            if viewModel.isDraftTooLong {
                Text("回答は\(AnswerBody.maxTextLength)文字以内で入力してください")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let message = speech.errorMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            HStack {
                Button {
                    toggleSpeech()
                } label: {
                    Label(speech.isRecording ? "停止" : "音声入力", systemImage: speech.isRecording ? "stop.circle.fill" : "mic")
                }
                .buttonStyle(.bordered)
                .tint(speech.isRecording ? .red : PagerTheme.orange)
                .disabled(viewModel.phase == .submitting)

                Spacer()

                Button {
                    speech.stop()
                    textFocused = false
                    Task { await viewModel.submitText() }
                } label: {
                    if viewModel.phase == .submitting {
                        ProgressView()
                    } else {
                        Label("送信", systemImage: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(PagerTheme.orange)
                .disabled(!viewModel.canSubmitText)
            }
            if viewModel.phase == .unreachable || viewModel.isFailed {
                Button {
                    Task {
                        if viewModel.canSubmitText { await viewModel.submitText() }
                    }
                } label: {
                    Label("再送信", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .tint(PagerTheme.orange)
                .disabled(!viewModel.canSubmitText)
            }
        }
        .onDisappear { speech.stop() }
    }

    @ViewBuilder
    private var statusBanner: some View {
        switch viewModel.phase {
        case .unreachable:
            banner(RelayError.unreachableMessage + "。入力内容は保存されています。接続できる場所でもう一度送信してください。", systemImage: "wifi.slash", color: .orange)
        case .failed(let error):
            banner(error.userMessage + " 入力は保持されています。再送信できます。", systemImage: "exclamationmark.circle", color: .red)
        case .resolvedElsewhere:
            banner(RelayError.alreadyResolved.userMessage, systemImage: "checkmark.circle", color: .secondary)
        case .signedOut:
            banner(RelayError.unauthorized.userMessage, systemImage: "exclamationmark.triangle", color: .red)
        case .editing where model.store.reachability == .unreachable:
            banner(RelayError.unreachableMessage, systemImage: "wifi.slash", color: .orange)
        case .editing, .submitting, .answered:
            EmptyView()
        }
    }

    private func banner(_ text: String, systemImage: String, color: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.callout)
            .foregroundStyle(color)
    }

    private func toggleSpeech() {
        if speech.isRecording {
            speech.stop()
            return
        }
        textFocused = false
        let base = viewModel.draft
        let viewModel = viewModel
        Task {
            await speech.start { transcript in
                viewModel.applyDictation(base + transcript)
            }
        }
    }
}

private extension AnswerViewModel {
    var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }
}
