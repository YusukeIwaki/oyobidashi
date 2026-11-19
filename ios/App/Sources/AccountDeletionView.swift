import AuthenticationServices
import LocalAuthentication
import OyobidashiKit
import SwiftUI

struct AccountDeletionView: View {
    @Environment(AppModel.self) private var model
    @Environment(CallKitCoordinator.self) private var callKit
    @Environment(\.webAuthenticationSession) private var authenticationSession
    @State private var confirming = false
    @State private var deleting = false
    @State private var errorMessage: String?

    var body: some View {
        Form {
            Section("削除されるデータ") {
                Text("お呼び出しのクラウドアカウント、質問と回答の履歴、連携済みの端末とMCP接続を削除します。この操作は取り消せません。")
                Text("購入の重複利用を防ぐため、ストア取引と削除済みアカウントの照合に必要な情報は保持します。")
            }
            Section("サブスクリプション") {
                Text("アカウントを削除してもストアで購入した定期購入の更新は続きます。購入したストアで解約できます。")
                Link("App Storeのサブスクリプションを管理", destination: URL(string: "https://apps.apple.com/account/subscriptions")!)
                Link("Google Playの定期購入を管理", destination: URL(string: "https://play.google.com/store/account/subscriptions")!)
            }
            Section {
                if deleting {
                    ProgressView("アカウントを削除中")
                } else {
                    Button("アカウントを削除", role: .destructive) { confirming = true }
                }
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("アカウント削除")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(deleting)
        .alert("アカウントを削除しますか？", isPresented: $confirming) {
            Button("削除する", role: .destructive) { Task { await deleteAccount() } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("すべての連携端末から利用できなくなり、質問と回答の履歴が削除されます。")
        }
    }

    private func deleteAccount() async {
        guard let previous = model.credentials, previous.endpoint.supportsCloudAccountDeletion else { return }
        deleting = true
        errorMessage = nil
        defer { deleting = false }
        do {
            let context = LAContext()
            var policyError: NSError?
            if context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) {
                guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "お呼び出しのクラウドアカウントを削除するために本人確認します。") else { return }
            } else if (policyError as? LAError)?.code != .passcodeNotSet {
                throw RelayError.forbidden
            }
            guard model.credentials == previous else { return }
            let client = RelayClient(endpoint: previous.endpoint, deviceToken: previous.deviceToken)
            let result = try await client.beginAccountDeletion()
            if result.status == .reauthentication {
                guard let ticket = result.ticket, ticket.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
                    throw RelayError.decoding("invalid account deletion ticket")
                }
                var page = URLComponents(url: previous.endpoint.url(segments: ["account", "delete"]), resolvingAgainstBaseURL: false)!
                page.fragment = "ticket=" + ticket
                let callback = try await authenticationSession.authenticate(
                    using: page.url!, callbackURLScheme: "oyobidashi", preferredBrowserSession: .ephemeral
                )
                guard callback.host == "account-deleted", callback.fragment == page.fragment else {
                    throw RelayError.forbidden
                }
            }
            callKit.voice.endConversation()
            callKit.endActiveCallViaSystem()
            model.completeAccountDeletion(for: previous)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            return
        } catch let error as LAError where [.userCancel, .systemCancel, .appCancel].contains(error.code) {
            return
        } catch let error as RelayError {
            errorMessage = error.userMessage
        } catch {
            errorMessage = "アカウント削除を完了できませんでした。もう一度お試しください。"
        }
    }
}
