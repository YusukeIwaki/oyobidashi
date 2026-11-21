import OyobidashiKit
import SwiftUI

struct PairingView: View {
    var onClose: (() -> Void)? = nil
    var onPaired: (() -> Void)? = nil
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(\.openURL) private var openURL
    @State private var showingSelfHosted = false
    @State private var urlText = ""
    @State private var codeText = ""
    @State private var inputError: String?
    @State private var showingScanner = false
    @State private var awaitingConsent: PendingPairing?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        PagerIconView(size: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("お呼び出し")
                                .font(.title3.bold())
                                .foregroundStyle(PagerTheme.ink)
                            Text("エージェントからの呼び出しを受け取ります")
                                .font(.caption)
                                .foregroundStyle(PagerTheme.inkSoft)
                        }
                    }
                }
                .listRowBackground(PagerTheme.cream)

                if model.signedOutReason == .accountDeleted {
                    Section {
                        Label("クラウドアカウントを削除しました", systemImage: "checkmark.circle")
                    }
                }
                if model.signedOutReason == .unauthorized {
                    Section {
                        Label("ペアリングが無効になりました。もう一度ペアリングしてください。", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    Button {
                        openURL(router.beginCloudPairing())
                    } label: {
                        Label("Oyobidashiクラウドに接続", systemImage: "cloud")
                            .font(.body.weight(.semibold))
                    }
                } footer: {
                    Text("ブラウザが開きます。エージェント（MCP）の接続に使ったアカウントでログインし、「アプリを開く」を押すとペアリングできます。")
                }

                Section {
                    Button {
                        showingSelfHosted = true
                    } label: {
                        HStack {
                            Label("自分で用意したサーバーに接続", systemImage: "server.rack")
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                        }
                    }
                } footer: {
                    Text("LAN内の中継サーバーや、自分で配備したクラウドに、QRコードか手入力で接続します。")
                }

                Section {
                    NavigationLink("プライバシーポリシー") { PrivacyPolicyView() }
                }

                pairingStatus
            }
            .navigationTitle("ペアリング")
            .navigationDestination(isPresented: $showingSelfHosted) { selfHosted }
            .toolbar {
                if let onClose {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("閉じる", action: onClose)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(PagerTheme.cream.ignoresSafeArea())
            .tint(PagerTheme.orange)
            .sheet(isPresented: $showingScanner) {
                ScannerSheet { info in
                    showingScanner = false
                    pair(info)
                }
            }
            // 設定から開いたシートの上では、RootViewの確認が出せない。ブラウザから戻ったリンクをここで確認する。
            .alert(
                "ペアリングしますか?",
                isPresented: Binding(
                    get: { onClose != nil && router.pendingPairing != nil },
                    set: { if !$0 { router.pendingPairing = nil } }
                ),
                presenting: router.pendingPairing
            ) { info in
                Button("ペアリング") { pair(info) }
                Button("キャンセル", role: .cancel) {}
            } message: { info in
                Text(model.isPaired
                    ? "\(info.endpoint.description) に接続します。現在のペアリングは解除されます。"
                    : "\(info.endpoint.description) に接続します。")
            }
            .alert(
                "ペアリングできません",
                isPresented: Binding(
                    get: { onClose != nil && router.deepLinkError != nil },
                    set: { if !$0 { router.deepLinkError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(router.deepLinkError ?? "")
            }
            .sheet(item: $awaitingConsent) { pending in
                VoiceAIConsentView(
                    endpoint: pending.info.endpoint,
                    acceptTitle: VoiceAIDisclosure.acceptTitle, declineTitle: "キャンセル",
                    onAccept: { disclosure in
                        awaitingConsent = nil
                        Task {
                            if await model.pair(pending.info, voiceAIConsent: disclosure) { onPaired?() }
                        }
                    },
                    onDecline: { awaitingConsent = nil }
                )
                .environment(model)
            }
        }
    }

    /// LAN内の中継サーバーや自分で配備したクラウド。QRコードと手入力はここだけで使う。
    private var selfHosted: some View {
        Form {
            Section {
                Button {
                    showingScanner = true
                } label: {
                    Label("QRコードを読み取る", systemImage: "qrcode.viewfinder")
                }
            } footer: {
                Text("サーバーが表示するペアリング用QRコードを読み取ってください。LAN内の中継サーバーに接続するときは、iPhoneを同じWi‑Fiに接続します。")
            }

            Section("手入力") {
                TextField("http://192.168.1.10:8787", text: $urlText)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("ペアリングコード", text: $codeText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.body.monospaced())
                Button("ペアリング") { pairManually() }
                    .disabled(model.pairingState == .pairing)
            }

            pairingStatus
        }
        .navigationTitle("自分で用意したサーバー")
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background(PagerTheme.cream.ignoresSafeArea())
    }

    @ViewBuilder private var pairingStatus: some View {
        if model.pairingState == .pairing {
            Section {
                HStack {
                    ProgressView()
                    Text("ペアリング中…")
                }
            }
        }

        if let message = errorMessage {
            Section {
                Label(message, systemImage: "exclamationmark.circle")
                    .foregroundStyle(.red)
            } footer: {
                if isUnreachable {
                    Text("「ローカルネットワーク」へのアクセスを許可しているか、設定アプリでも確認してください。")
                }
            }
        }
    }

    private var isUnreachable: Bool {
        if case .failed(let error) = model.pairingState { return error.isUnreachable }
        return false
    }

    private var errorMessage: String? {
        if let inputError { return inputError }
        if case .failed(let error) = model.pairingState { return error.userMessage }
        return nil
    }

    private func pairManually() {
        do {
            pair(try PairingInfo.manual(url: urlText, code: codeText))
        } catch let error as PairingParseError {
            model.clearPairingError()
            inputError = error.userMessage
        } catch {
            inputError = PairingParseError.malformed.userMessage
        }
    }

    /// 接続する前に、音声会話の送信先を見せて同意を受け取る。
    private func pair(_ info: PairingInfo) {
        inputError = nil
        model.clearPairingError()
        awaitingConsent = PendingPairing(info: info)
    }
}

/// QR 読み取り用シート。oyobidashi のペアリング用コードを読めたら `onPairingInfo` を呼ぶ。
struct ScannerSheet: View {
    var onPairingInfo: (PairingInfo) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?

    var body: some View {
        NavigationStack {
            QRScannerView { code in
                do {
                    onPairingInfo(try PairingInfo.parse(uri: code))
                } catch let error as PairingParseError {
                    message = error.userMessage
                } catch {
                    message = PairingParseError.malformed.userMessage
                }
            }
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .bottom) {
                if let message {
                    Text(message)
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .padding()
                }
            }
            .navigationTitle("QRコードを読み取る")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
            }
        }
    }
}
