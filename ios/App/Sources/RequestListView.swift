import OyobidashiKit
import SwiftUI

struct RequestListView: View {
    @Environment(AppModel.self) private var model
    @State private var sheet: HomeSheet?

    private var voiceNotice: HomeNotice? {
        model.store.homeNotice.flatMap { $0.requiresVoicePlanConsent ? $0 : nil }
    }

    var body: some View {
        let store = model.store
        ScrollView {
            VStack(spacing: 14) {
                availabilityCard
                if let notice = voiceNotice, let endpoint = model.credentials?.endpoint {
                    banner(icon: "phone", text: "音声通話の送信先を確認", detail: "同意すると、次の通話から音声で応答できます。", color: PagerTheme.orange, actionIcon: "chevron.right") {
                        sheet = .voiceNotice(notice, endpoint)
                    }
                    .accessibilityIdentifier("home.voiceNotice")
                }
                if store.reachability == .unreachable {
                    banner(icon: "wifi.slash", text: RelayError.unreachableMessage, detail: "接続できるようになると自動的に再接続します。入力中の回答は保存されます。", color: PagerTheme.orange) {
                        Task { await model.refresh() }
                    }
                }
                if case .failed(let error) = store.loadState {
                    banner(icon: "exclamationmark.circle", text: error.userMessage, detail: "タップして再試行できます", color: .red) {
                        Task { await model.refresh() }
                    }
                }
                sectionHeader("未回答の通知")
                if store.pending.isEmpty {
                    Text("未回答の通知はありません")
                        .font(.callout)
                        .foregroundStyle(PagerTheme.inkSoft)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                        .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 14))
                } else {
                    ForEach(store.pending) { request in
                        NavigationLink(value: request.id) {
                            RequestRow(request: request, hasDraft: model.drafts.draft(for: request.id) != nil, resolvedLocally: false)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(16)
        }
        .background(PagerTheme.cream.ignoresSafeArea())
        .navigationTitle("お呼び出し")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    sheet = .settings
                } label: {
                    Label("設定", systemImage: "gearshape")
                }
                .tint(PagerTheme.ink)
            }
        }
        .sheet(item: $sheet) { destination in
            switch destination {
            case .settings:
                SettingsView()
            case .voiceNotice(let notice, let endpoint):
                VoiceNoticeSheet(notice: notice, endpoint: endpoint)
            }
        }
        .onChange(of: voiceNotice) { _, notice in
            if notice == nil, case .voiceNotice = sheet { sheet = nil }
        }
    }

    private var availabilityCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("あなたの状態", systemImage: "person.crop.circle")
                    .font(.subheadline.bold())
                    .foregroundStyle(PagerTheme.ink)
                Spacer()
                if model.isUpdatingPresence {
                    ProgressView().controlSize(.small)
                }
            }
            Picker("状態", selection: Binding(
                get: { model.effectivePresenceAvailability() },
                set: { newValue in
                    Task {
                        if newValue == .busy { await model.setBusyFor30Minutes() }
                        else { await model.updatePresence(availability: newValue, until: nil) }
                    }
                }
            )) {
                ForEach([PresenceAvailability.available, .busy, .away], id: \.rawValue) { value in
                    Label(value.japaneseLabel, systemImage: value.systemImage).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .disabled(model.isUpdatingPresence)
            if model.effectivePresenceAvailability() != .available, let until = model.presenceUntil {
                Label {
                    Text("\(until, style: .time) まで")
                } icon: {
                    Image(systemName: "timer")
                }
                .font(.caption)
                .foregroundStyle(PagerTheme.inkSoft)
            }
            Text(presenceExplanation)
                .font(.caption2)
                .foregroundStyle(PagerTheme.inkSoft)
            if let error = model.presenceError {
                Button {
                    Task { await resendPresence() }
                } label: {
                    Label(error.userMessage + " タップして再送信", systemImage: "arrow.clockwise")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .padding(16)
        .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(PagerTheme.ink.opacity(0.08)))
    }

    private var presenceExplanation: String {
        if model.isUpdatingPresence { return "エージェントに状態を共有しています…" }
        switch model.effectivePresenceAvailability() {
        case .available: return voiceNotice == nil ? "通話や通知で連絡を受け取れます" : "質問や通知を文字で受け取れます"
        case .busy: return "取り込み中は、通話の代わりに文字で連絡が届きます"
        case .away: return "離席中は、通話の代わりに文字で連絡が届きます"
        case .unknown: return "状態を選ぶとエージェントに共有されます"
        }
    }

    private func resendPresence() async {
        let until = model.presenceUntil
        _ = await model.updatePresence(availability: model.presenceAvailability, until: until, note: model.presenceNote)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(PagerTheme.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }

    private func banner(icon: String, text: String, detail: String, color: Color, actionIcon: String = "arrow.clockwise", action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon).foregroundStyle(color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(text).font(.callout.bold()).foregroundStyle(PagerTheme.ink).multilineTextAlignment(.leading)
                    Text(detail).font(.caption).foregroundStyle(PagerTheme.inkSoft).multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: actionIcon).foregroundStyle(color)
            }
            .padding(14)
            .background(Color.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(color.opacity(0.35)))
        }
        .buttonStyle(.plain)
    }
}

private enum HomeSheet: Identifiable {
    case settings
    case voiceNotice(HomeNotice, RelayEndpoint)

    var id: String {
        switch self {
        case .settings: "settings"
        case .voiceNotice: "voiceNotice"
        }
    }
}

private struct VoiceNoticeSheet: View {
    let notice: HomeNotice
    let endpoint: RelayEndpoint
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("現在は、通話での質問もテキストで届きます。音声で応答したときは、文字起こしと質問・会話履歴を利用プランの送信先へ送ります。")
                }
                Section("プランごとの送信先") {
                    LabeledContent("FREE", value: VoiceAIDisclosure(provider: notice.providers["free"]).recipientName)
                    LabeledContent("PLUS", value: VoiceAIDisclosure(provider: notice.providers["plus"]).recipientName)
                }
                Section {
                    Button("送信先を確認して同意") {
                        openURL(endpoint.url(segments: ["pair"], query: [URLQueryItem(name: "voice", value: "1")]))
                        dismiss()
                    }
                    .tint(PagerTheme.orange)
                }
            }
            .navigationTitle("音声通話の送信先")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("あとで") { dismiss() }
                }
            }
        }
    }
}

struct RequestRow: View {
    let request: AgentRequest
    let hasDraft: Bool
    let resolvedLocally: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                priorityBadge
                deliveryBadge
                Spacer()
                Text(request.createdAt, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(PagerTheme.inkSoft)
            }
            Text(request.question)
                .font(.body.bold())
                .foregroundStyle(PagerTheme.ink)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            HStack(spacing: 6) {
                Text(request.agent?.name ?? "エージェント")
                if hasDraft {
                    Text("下書きあり").foregroundStyle(PagerTheme.orange).bold()
                } else {
                    Text(StatusText.label(for: request, resolvedLocally: resolvedLocally))
                }
                if request.hasLiveCall, let call = request.call {
                    Text(call.state == .ringing ? "着信中" : "通話中")
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color.green, in: Capsule())
                }
            }
            .font(.caption)
            .foregroundStyle(PagerTheme.inkSoft)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(PagerTheme.ink.opacity(0.08)))
    }

    private var priorityBadge: some View {
        Text("優先度: \(request.priority.japaneseLabel)")
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(PagerTheme.priorityColor(request.priority), in: Capsule())
    }
    private var deliveryBadge: some View {
        Text(deliveryLabel)
            .font(.caption2.bold())
            .foregroundStyle(PagerTheme.ink)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(PagerTheme.orangeSoft, in: Capsule())
    }
    private var deliveryLabel: String {
        switch request.deliveryMode {
        case .actions: return "ボタン回答"
        case .text: return "文字回答"
        case .call: return "通話"
        case .unknown(let r): return r
        }
    }
}

enum StatusText {
    static func label(for request: AgentRequest, resolvedLocally: Bool) -> String {
        if request.kind == .notification { return "お知らせ" }
        switch request.status {
        case .pending: return resolvedLocally ? "解決済み" : "未回答"
        case .answered: return "回答済み"
        case .cancelled: return "終了 (取り消し)"
        case .expired: return "終了 (期限切れ)"
        case .notified: return "お知らせ"
        case .unknown(let raw): return raw
        }
    }

    static func label(for method: InputMethod) -> String {
        switch method {
        case .text: return "テキスト"
        case .voice: return "音声"
        case .choice: return "選択肢"
        case .unknown(let raw): return raw
        }
    }
}
