import OyobidashiKit
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var router = router
        @Bindable var model = model
        Group {
            if model.isPaired {
                NavigationStack(path: $router.path) {
                    RequestListView()
                        .navigationDestination(for: String.self) { requestID in
                            RequestDetailView(requestID: requestID)
                        }
                }
                .tint(PagerTheme.orange)
                .task { await AppEnvironment.shared.notifications.requestAuthorization() }
            } else {
                PairingView()
            }
        }
        .background(PagerTheme.cream.ignoresSafeArea())
        .onChange(of: model.lastAnswerSubmission) { _, submission in
            guard let submission else { return }
            router.showAnswerCompletion(submission)
            if scenePhase != .active { router.finishAnswerCompletion(submission) }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active, let submission = router.answerCompletion {
                router.finishAnswerCompletion(submission)
            }
        }
        .onChange(of: router.path) { _, path in
            if let submission = router.answerCompletion, path.last != submission.requestID {
                router.answerCompletion = nil
            }
        }
        .onChange(of: model.isPaired) { _, paired in
            if !paired {
                router.answerCompletion = nil
                router.path = []
            }
        }
        // 応答後の通話画面、またはCallKitが使えない場合の着信画面。
        .fullScreenCover(item: Binding(
            get: { model.fallbackCallRequest.map { FallbackItem(request: $0) } },
            set: { if $0 == nil { model.fallbackCallRequest = nil } }
        )) { item in
            InAppCallView(request: item.request)
                .environment(model)
                .environment(AppEnvironment.shared.callKit)
        }
        // ディープリンクは外部から勝手に開けるので、接続先を見せて確認してからペアリングする。
        .alert(
            "ペアリングしますか?",
            isPresented: Binding(get: { router.pendingPairing != nil }, set: { if !$0 { router.pendingPairing = nil } }),
            presenting: router.pendingPairing
        ) { info in
            Button("ペアリング") { Task { await model.pair(info) } }
            Button("キャンセル", role: .cancel) {}
        } message: { info in
            Text(model.isPaired
                ? "\(info.endpoint.description) に接続します。現在のペアリングは解除されます。"
                : "\(info.endpoint.description) に接続します。")
        }
        .alert(
            "ペアリングできません",
            isPresented: Binding(get: { router.deepLinkError != nil }, set: { if !$0 { router.deepLinkError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(router.deepLinkError ?? "")
        }
        .alert(
            "ペアリングに失敗しました",
            isPresented: Binding(
                get: { model.isPaired && model.pairingFailure != nil },
                set: { if !$0 { model.clearPairingError() } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.pairingFailure?.userMessage ?? "")
        }
    }
}

private struct FallbackItem: Identifiable {
    let request: AgentRequest
    var id: String { request.id }
}

private extension AppModel {
    var pairingFailure: RelayError? {
        if case .failed(let error) = pairingState { return error }
        return nil
    }
}
