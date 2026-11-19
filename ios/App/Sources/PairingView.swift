import OyobidashiKit
import SwiftUI

struct PairingView: View {
    var onClose: (() -> Void)? = nil
    var onPaired: (() -> Void)? = nil
    @Environment(AppModel.self) private var model
    @State private var urlText = ""
    @State private var codeText = ""
    @State private var inputError: String?
    @State private var showingScanner = false

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
                        showingScanner = true
                    } label: {
                        Label("QRコードを読み取る", systemImage: "qrcode.viewfinder")
                    }
                } footer: {
                    Text("Macで中継サーバーのペアリング用QRコードを表示し、読み取ってください。iPhoneとMacは同じWi‑Fiに接続している必要があります。")
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

                Section {
                    NavigationLink("プライバシーポリシー") { PrivacyPolicyView() }
                }

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
            .navigationTitle("ペアリング")
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

    private func pair(_ info: PairingInfo) {
        inputError = nil
        Task {
            if await model.pair(info) { onPaired?() }
        }
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
