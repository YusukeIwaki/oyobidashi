import OyobidashiKit
import Network
import Observation
import UIKit

/// アプリ全体で共有するオブジェクトの組み立て。ロジックは OyobidashiKit 側にある。
@MainActor
final class AppEnvironment {
    static let shared = AppEnvironment()

    let model: AppModel
    let billingStore: BillingStore
    private let voiceAccess = VoiceAccessManager()
    let router = Router()
    let notifications: NotificationCoordinator
    let callKit: CallKitCoordinator
    private let connectivity = ConnectivityMonitor()

    private init() {
        #if DEBUG
        let pushEnvironment = PushEnvironment.development
        #else
        let pushEnvironment = PushEnvironment.production
        #endif
        let notifications = NotificationCoordinator()
        self.notifications = notifications
        let callKit = CallKitCoordinator()
        self.callKit = callKit
        model = AppModel(
            credentialStore: KeychainCredentialStore(),
            configuration: AppModelConfiguration(deviceName: UIDevice.current.name, pushEnvironment: pushEnvironment, pushClientID: try? KeychainPushClientIdentity.loadOrCreate()),
            notifications: notifications,
            draftPersistence: UserDefaultsDraftPersistence(),
            voiceAIConsentStore: UserDefaultsVoiceAIConsentStore()
        )
        model.voiceAccessProvider = { [voiceAccess] credentials in
            try await voiceAccess.token(for: credentials)
        }
        billingStore = BillingStore(model: model)
        notifications.attach(model: model, router: router)
        callKit.attach(model: model)
        connectivity.start { [weak model] in model?.connectivityChanged() }
        billingStore.start()
    }
}

/// 画面遷移の状態。
@MainActor
@Observable
final class Router {
    /// 一覧からの遷移先 (request id)。
    var path: [String] = []
    /// ディープリンクで受け取り、ユーザーの確認待ちのペアリング情報。
    var pendingPairing: PairingInfo?
    var deepLinkError: String?
    var answerCompletion: AnswerSubmission?

    func open(requestID: String) {
        answerCompletion = nil
        path = [requestID]
    }

    func showAnswerCompletion(_ submission: AnswerSubmission) {
        guard path.last == submission.requestID else { return }
        answerCompletion = submission
    }

    func finishAnswerCompletion(_ submission: AnswerSubmission) {
        guard answerCompletion?.id == submission.id else { return }
        answerCompletion = nil
        // A newly opened notification must not be dismissed by an older send.
        guard path.last == submission.requestID else { return }
        path = []
    }

    /// 公式クラウドのペアリングを始め、ブラウザで開くページを返す。
    /// ブラウザにいる間にアプリが終了しても戻れるよう、控えは保存しておく。
    func beginCloudPairing() -> URL {
        let attempt = PairingAttempt.begin(endpoint: .officialCloud)
        if let data = try? JSONEncoder().encode(attempt) { UserDefaults.standard.set(data, forKey: Self.attemptKey) }
        return attempt.pageURL
    }

    /// リンクは外部から誰でも開ける。このアプリが始めたペアリングへの戻りだけを受け付ける。
    func handleDeepLink(_ url: URL) {
        do {
            guard let data = UserDefaults.standard.data(forKey: Self.attemptKey),
                  let attempt = try? JSONDecoder().decode(PairingAttempt.self, from: data) else {
                // 形式の誤りはその内容を伝える。正しい形式なら、始めていないことを伝える。
                _ = try PairingInfo.parse(url: url)
                throw PairingParseError.notStartedInApp
            }
            pendingPairing = try attempt.accept(uri: url.absoluteString)
            // 1回限り。合わなかったリンクでは消さず、進行中の正規のペアリングを妨げさせない。
            UserDefaults.standard.removeObject(forKey: Self.attemptKey)
        } catch let error as PairingParseError {
            deepLinkError = error.userMessage
        } catch {
            deepLinkError = PairingParseError.malformed.userMessage
        }
    }

    private static let attemptKey = "pairingAttempt"
}

/// ネットワーク経路が使えるようになったら (Wi‑Fi に戻った等) 通知する。
final class ConnectivityMonitor: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private var lastStatus: NWPath.Status?

    func start(onRestored: @escaping @MainActor () -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let previous = self.lastStatus
            self.lastStatus = path.status
            // 初回の通知は無視し、「使えない → 使える」またはインターフェースの切り替わりだけ拾う。
            guard previous != nil, path.status == .satisfied else { return }
            DispatchQueue.main.async { onRestored() }
        }
        monitor.start(queue: DispatchQueue(label: "oyobidashi.connectivity"))
    }
}
