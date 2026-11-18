import OyobidashiKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var billingStore: BillingStore
    @State private var confirmingUnpair = false
    @State private var presentedSheet: SettingsSheet?

    private enum SettingsSheet: String, Identifiable {
        case pairing, plan
        var id: String { rawValue }
    }

    init() {
        _billingStore = ObservedObject(wrappedValue: AppEnvironment.shared.billingStore)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("接続先")
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(isOyobidashiCloud ? "Oyobidashiクラウド" : model.credentials?.endpoint.description ?? "-")
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                            Spacer(minLength: 0)
                            if !isOyobidashiCloud {
                                Button("変更") { presentedSheet = .pairing }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel("接続先を変更")
                            }
                        }
                    }
                    LabeledContent("接続状態", value: connectionText)
                    Button("ペアリングを解除", role: .destructive) { confirmingUnpair = true }
                } header: {
                    Text("ペアリング")
                } footer: {
                    if !isOyobidashiCloud {
                        Text("接続先の変更が完了するまでは、現在のペアリングを維持します。")
                    }
                }
                PermissionSettingsView()
                if billingStore.planPresentation.isEnabled {
                    Section {
                        CurrentPlanRow(presentation: billingStore.planPresentation) {
                            presentedSheet = .plan
                        }
                    } header: {
                        Text("現在のプラン")
                    }
                }
                Section {
                    LabeledContent("バージョン", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-")
                }
            }
            .task(id: model.credentials?.endpoint) { await billingStore.refreshAndSync() }
            .task(id: billingStore.status?.expiresAt) { await billingStore.refreshAtExpiration() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await billingStore.refreshAndSync() } }
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
            .sheet(item: $presentedSheet) { sheet in
                switch sheet {
                case .pairing:
                    PairingView(onClose: { presentedSheet = nil }, onPaired: {
                        presentedSheet = nil
                        dismiss()
                    })
                case .plan:
                    PlanChangeSheet(store: billingStore)
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

    private var isOyobidashiCloud: Bool {
        model.credentials?.endpoint.host.lowercased() == "api.oyobidashi.me"
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
