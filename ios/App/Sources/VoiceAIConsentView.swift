import OyobidashiKit
import SwiftUI

/// 音声会話の内容をAIへ送ることへの同意。ペアリングのときに1回だけ見せる。
/// 通話中には何も尋ねない。
struct VoiceAIConsentView: View {
    /// 送信先が分かっていれば渡す。nil なら接続先に問い合わせる。
    var known: VoiceAIDisclosure? = nil
    let endpoint: RelayEndpoint
    let acceptTitle: String
    let declineTitle: String
    let onAccept: (VoiceAIDisclosure) -> Void
    let onDecline: () -> Void
    @Environment(AppModel.self) private var model
    @State private var disclosure: VoiceAIDisclosure?

    var body: some View {
        NavigationStack {
            List {
                if let disclosure {
                    Section {
                        ForEach(disclosure.paragraphs, id: \.self) { Text($0) }
                    } header: {
                        Text("送信先: \(disclosure.recipientName)")
                    } footer: {
                        Text("接続先: \(endpoint.description)")
                    }
                    Section {
                        NavigationLink("プライバシーポリシー") { PrivacyPolicyView() }
                    }
                    Section {
                        Button(acceptTitle) { onAccept(disclosure) }
                            .buttonStyle(.borderedProminent)
                            .frame(maxWidth: .infinity)
                        Button(declineTitle, role: .cancel, action: onDecline)
                            .frame(maxWidth: .infinity)
                    }
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        HStack {
                            ProgressView()
                            Text("送信先を確認しています…")
                        }
                    }
                }
            }
            .navigationTitle(VoiceAIDisclosure.title)
            .navigationBarTitleDisplayMode(.inline)
            .scrollContentBackground(.hidden)
            .background(PagerTheme.cream.ignoresSafeArea())
            .tint(PagerTheme.orange)
        }
        .interactiveDismissDisabled()
        .task {
            if let known { disclosure = known } else { disclosure = await model.voiceAIDisclosure(for: endpoint) }
        }
    }
}

/// 同意を待っているペアリング。QR・手入力・ディープリンクのどれも同じ画面を通る。
struct PendingPairing: Identifiable {
    let info: PairingInfo
    var id: String { info.endpoint.description + "#" + info.code }
}
