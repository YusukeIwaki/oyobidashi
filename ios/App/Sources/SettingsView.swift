import OyobidashiKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingUnpair = false
    @State private var showingPairing = false

    var body: some View {
        NavigationStack {
            Form {
                Section("ペアリング") {
                    LabeledContent("接続先", value: model.credentials?.endpoint.description ?? "-")
                        .textSelection(.enabled)
                    LabeledContent("接続状態", value: connectionText)
                    Button("ペアリングし直す") { showingPairing = true }
                    Button("ペアリングを解除", role: .destructive) { confirmingUnpair = true }
                }
                PermissionSettingsView()
                Section {
                    LabeledContent("バージョン", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-")
                }
            }
            .tint(PagerTheme.orange)
            .scrollContentBackground(.hidden)
            .background(PagerTheme.cream.ignoresSafeArea())
            .navigationTitle("設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .sheet(isPresented: $showingPairing) {
                PairingView(onClose: { showingPairing = false }, onPaired: {
                    showingPairing = false
                    dismiss()
                })
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
