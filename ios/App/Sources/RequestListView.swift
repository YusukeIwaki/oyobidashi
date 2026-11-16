import OyobidashiKit
import SwiftUI

struct RequestListView: View {
    @Environment(AppModel.self) private var model
    @State private var showingSettings = false

    var body: some View {
        let store = model.store
        ScrollView {
            VStack(spacing: 14) {
                headerCard
                availabilityCard
                VoicePermissionsView(hidesWhenReady: true)
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
                if model.presenceError != nil {
                    banner(icon: "person.crop.circle.badge.exclamationmark", text: model.presenceError!.userMessage, detail: "状態の送信に失敗しました。再試行できます", color: .red) {
                        Task { await resendPresence() }
                    }
                }

                sectionHeader("未回答")
                if store.pending.isEmpty {
                    Text("未回答の質問はありません")
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

                if !store.history.isEmpty {
                    sectionHeader("履歴")
                    ForEach(store.history) { request in
                        NavigationLink(value: request.id) {
                            RequestRow(request: request, hasDraft: false, resolvedLocally: store.locallyResolvedIDs.contains(request.id))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(16)
        }
        .background(PagerTheme.cream.ignoresSafeArea())
        .navigationTitle("お呼び出し")
        .refreshable { await model.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                PagerIconView(size: 30)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingSettings = true
                } label: {
                    Label("設定", systemImage: "gearshape")
                }
                .tint(PagerTheme.ink)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
    }

    private var headerCard: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("お呼び出し")
                    .font(.title2.bold())
                    .foregroundStyle(PagerTheme.ink)
                Text(connectionLabel)
                    .font(.caption.bold())
                    .foregroundStyle(connectionColor)
            }
            Spacer()
            // 小さな緑 LCD モチーフ
            HStack(spacing: 3) {
                ForEach(0..<4, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 1).fill(PagerTheme.lcdDeep.opacity(0.7)).frame(width: 10, height: 7)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(PagerTheme.lcd, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(PagerTheme.ink.opacity(0.6), lineWidth: 1))
        }
        .padding(16)
        .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(PagerTheme.ink.opacity(0.08)))
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
                set: { newValue in Task { await model.updatePresence(availability: newValue, until: nil) } }
            )) {
                ForEach([PresenceAvailability.available, .busy, .away], id: \.rawValue) { value in
                    Label(value.japaneseLabel, systemImage: value.systemImage).tag(value)
                }
            }
            .pickerStyle(.segmented)
            HStack(spacing: 8) {
                Button {
                    Task { await model.setBusyFor30Minutes() }
                } label: {
                    Label("30分 取り込み中", systemImage: "timer")
                        .font(.caption.bold())
                }
                .buttonStyle(.bordered)
                .tint(PagerTheme.orange)
                if let until = model.presenceUntil, model.presenceAvailability != .available {
                    Text("〜 \(until, style: .time) まで")
                        .font(.caption)
                        .foregroundStyle(PagerTheme.inkSoft)
                }
                Spacer()
                Text(model.effectivePresenceAvailability().japaneseLabel)
                    .font(.caption.bold())
                    .foregroundStyle(PagerTheme.orange)
            }
            Text("取り込み中・離席中は通話が文字に切り替わります")
                .font(.caption2)
                .foregroundStyle(PagerTheme.inkSoft)
        }
        .padding(16)
        .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(PagerTheme.ink.opacity(0.08)))
    }

    private func resendPresence() async {
        let until = model.presenceUntil
        _ = await model.updatePresence(availability: model.presenceAvailability, until: until, note: model.presenceNote)
    }

    private var connectionLabel: String {
        switch model.store.connection {
        case .connected: return "接続中"
        case .connecting: return "接続しています…"
        case .reconnecting: return "再接続を待っています"
        case .disconnected: return model.store.reachability == .unreachable ? "接続できません" : "未接続"
        }
    }
    private var connectionColor: Color {
        model.store.connection == .connected ? PagerTheme.lcdDeep : PagerTheme.orange
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.headline)
            .foregroundStyle(PagerTheme.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
    }

    private func banner(icon: String, text: String, detail: String, color: Color, retry: @escaping () -> Void) -> some View {
        Button(action: retry) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: icon).foregroundStyle(color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(text).font(.callout.bold()).foregroundStyle(PagerTheme.ink).multilineTextAlignment(.leading)
                    Text(detail).font(.caption).foregroundStyle(PagerTheme.inkSoft).multilineTextAlignment(.leading)
                }
                Spacer()
                Image(systemName: "arrow.clockwise").foregroundStyle(color)
            }
            .padding(14)
            .background(Color.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(color.opacity(0.35)))
        }
        .buttonStyle(.plain)
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
