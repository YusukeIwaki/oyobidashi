import OyobidashiKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingUnpair = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        PagerIconView(size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("お呼び出し")
                                .font(.headline)
                                .foregroundStyle(PagerTheme.ink)
                            Text("ページャーでエージェントとつながります")
                                .font(.caption)
                                .foregroundStyle(PagerTheme.inkSoft)
                        }
                    }
                }
                .listRowBackground(PagerTheme.cream)

                Section("あなたの状態") {
                    Picker("状態", selection: Binding(
                        get: { model.effectivePresenceAvailability() },
                        set: { v in Task { await model.updatePresence(availability: v, until: nil) } }
                    )) {
                        ForEach([PresenceAvailability.available, .busy, .away], id: \.rawValue) { v in
                            Label(v.japaneseLabel, systemImage: v.systemImage).tag(v)
                        }
                    }
                    .pickerStyle(.segmented)
                    Button {
                        Task { await model.setBusyFor30Minutes() }
                    } label: {
                        Label("30分だけ取り込み中にする", systemImage: "timer")
                    }
                    .tint(PagerTheme.orange)
                    if let until = model.presenceUntil, model.presenceAvailability != .available {
                        LabeledContent("期限", value: until.formatted(date: .omitted, time: .shortened))
                    }
                    if let error = model.presenceError {
                        Label(error.userMessage, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .font(.caption)
                        Button("再送信") {
                            Task { _ = await model.updatePresence(availability: model.presenceAvailability, until: model.presenceUntil, note: model.presenceNote) }
                        }
                        .tint(PagerTheme.orange)
                    }
                    Text("取り込み中・離席中は通話が文字回答に切り替わります")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("音声通話") {
                    VoicePermissionsView()
                }

                Section("中継サーバー") {
                    LabeledContent("URL", value: model.credentials?.endpoint.description ?? "-")
                    LabeledContent("デバイスID", value: model.credentials?.deviceID ?? "-")
                    LabeledContent("接続状態", value: connectionText)
                }

                Section {
                    Button("ペアリングを解除", role: .destructive) {
                        confirmingUnpair = true
                    }
                } footer: {
                    Text("MacのIPアドレスが変わった場合は、解除してからもう一度ペアリングしてください。")
                }

                Section {
                    LabeledContent("バージョン", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-")
                }
            }
            .scrollContentBackground(.hidden)
            .background(PagerTheme.cream.ignoresSafeArea())
            .navigationTitle("設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .confirmationDialog("ペアリングを解除しますか?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("解除する", role: .destructive) {
                    Task {
                        await model.unpair()
                        dismiss()
                    }
                }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("このiPhoneには質問が届かなくなります。")
            }
        }
    }

    private var connectionText: String {
        switch model.store.connection {
        case .connected: return "接続中"
        case .connecting: return "接続しています…"
        case .reconnecting: return "接続できません (再接続を待っています)"
        case .disconnected: return model.store.reachability == .unreachable ? "接続できません" : "未接続"
        }
    }
}
