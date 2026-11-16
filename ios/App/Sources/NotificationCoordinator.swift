import OyobidashiKit
import UIKit
import UserNotifications

/// `UNUserNotificationCenter` との橋渡し。判断は OyobidashiKit (`AppModel` / `RequestListStore` / `PushPayload`) に任せる。
@MainActor
final class NotificationCoordinator: NSObject, NotificationManaging {
    private let center = UNUserNotificationCenter.current()
    private let delegateProxy = NotificationDelegateProxy()
    private weak var model: AppModel?
    private weak var router: Router?
    /// WebSocket 経由で受けてローカル通知として出した request。同じ内容の Push を二重に鳴らさないために使う。
    private var locallyPresented: Set<String> = []
    /// 終端で削除済みの request。二重の非同期レースで古い通知が復活しないようにする。
    private var terminalRemovedIDs: Set<String> = []
    private var dynamicCategories: [String: UNNotificationCategory] = [:]

    func attach(model: AppModel, router: Router) {
        self.model = model
        self.router = router
    }

    func install() {
        delegateProxy.coordinator = self
        center.delegate = delegateProxy
        rebuildCategories()
    }

    private func baseCategories() -> [UNNotificationCategory] {
        let reply = UNTextInputNotificationAction(
            identifier: PushCategory.replyAction, title: "返信", options: [],
            textInputButtonTitle: "送信", textInputPlaceholder: "回答を入力"
        )
        var categories: [UNNotificationCategory] = [
            UNNotificationCategory(identifier: PushCategory.question, actions: [reply], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: PushCategory.notification, actions: [], intentIdentifiers: [], options: []),
        ]
        // リモート Push 用の静的 actions カテゴリ (汎用名 + 1〜3件)。タイトルは汎用だが index は正確に送る。
        // ローカル通知ではリクエストごとの動的カテゴリで正確な選択肢文言を表示する。
        let genericActions = (0..<3).map { i in
            UNNotificationAction(identifier: PushCategory.choiceActionIdentifier(index: i), title: "選択肢 \(i + 1)", options: [])
        }
        categories.append(UNNotificationCategory(identifier: PushCategory.actions, actions: genericActions, intentIdentifiers: [], options: []))
        for count in 1...3 {
            let actions = (0..<count).map { i in
                UNNotificationAction(identifier: PushCategory.choiceActionIdentifier(index: i), title: "選択肢 \(i + 1)", options: [])
            }
            categories.append(UNNotificationCategory(identifier: "\(PushCategory.actions)_\(count)", actions: actions, intentIdentifiers: [], options: []))
        }
        categories.append(contentsOf: dynamicCategories.values)
        return categories
    }

    private func rebuildCategories() {
        let wanted = Set(baseCategories())
        center.getNotificationCategories { [center] registered in
            let newIDs = Set(wanted.map(\.identifier))
            center.setNotificationCategories(Set(registered.filter { !newIDs.contains($0.identifier) }).union(wanted))
        }
    }

    /// actions モード (<=3) 用に正確な選択肢文言で動的カテゴリを登録する。
    func registerActionsCategory(for request: AgentRequest) {
        guard request.isActionsEligible else { return }
        let id = PushCategory.actionsCategoryIdentifier(requestID: request.id)
        let actions = request.effectiveChoices.enumerated().map { index, choice in
            UNNotificationAction(identifier: PushCategory.choiceActionIdentifier(index: index), title: choice, options: [])
        }
        dynamicCategories[id] = UNNotificationCategory(identifier: id, actions: actions, intentIdentifiers: [], options: [])
        rebuildCategories()
    }

    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    private static func replyFailureIdentifier(_ requestID: String) -> String { "reply-failed-\(requestID)" }

    // MARK: NotificationManaging

    func removeDelivered(requestIDs: [String]) {
        guard !requestIDs.isEmpty else { return }
        let targets = Set(requestIDs)
        for id in requestIDs { terminalRemovedIDs.insert(id) }
        locallyPresented.subtract(targets)
        let center = self.center
        Task { @MainActor [weak self] in
            guard let self else { return }
            // APNs の identifier は任意なので userInfo.request_id で照合する。
            let delivered = await center.deliveredNotifications()
            let deliveredPairs: [(identifier: String, userInfo: [AnyHashable: Any])] = delivered.map { ($0.request.identifier, $0.request.content.userInfo) }
            var identifiers = Set(NotificationPolicy.matchingIdentifiers(delivered: deliveredPairs, requestIDs: targets))
            #if DEBUG
            print("[oyobidashi.notifications] remove ids=\(targets.sorted().joined(separator: ",")) matches=\(identifiers.count)")
            #endif
            // 直接 identifier が一致するものと返信失敗通知も対象。
            for id in targets {
                identifiers.insert(id)
                identifiers.insert(Self.replyFailureIdentifier(id))
            }
            center.removeDeliveredNotifications(withIdentifiers: Array(identifiers))
            let pending = await center.pendingNotificationRequests()
            let pendingPairs: [(identifier: String, userInfo: [AnyHashable: Any])] = pending.map { ($0.identifier, $0.content.userInfo) }
            var pendingIDs = Set(NotificationPolicy.matchingIdentifiers(delivered: pendingPairs, requestIDs: targets))
            for id in targets {
                pendingIDs.insert(id)
                pendingIDs.insert(Self.replyFailureIdentifier(id))
            }
            center.removePendingNotificationRequests(withIdentifiers: Array(pendingIDs))
        }
        // 同期で分かるものは即座にも消す (identifier 一致ケース)。
        let direct = requestIDs + requestIDs.map(Self.replyFailureIdentifier)
        center.removeDeliveredNotifications(withIdentifiers: direct)
        center.removePendingNotificationRequests(withIdentifiers: direct)
    }

    func removeAllDelivered() {
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        locallyPresented = []
        terminalRemovedIDs = []
    }

    func presentIncoming(_ request: AgentRequest) {
        // 終端は提示しない。通話は CallKit/アプリ内画面が担うので通常通知は出さない。
        guard NotificationPolicy.shouldPresent(request: request) else { return }
        if request.deliveryMode == .call && request.hasLiveCall { return }
        guard !terminalRemovedIDs.contains(request.id) else { return }

        if request.isActionsEligible {
            registerActionsCategory(for: request)
        }
        let content = UNMutableNotificationContent()
        content.title = NotificationText.title(for: request)
        content.body = NotificationText.body(for: request)
        content.sound = .default
        content.threadIdentifier = PushCategory.threadID
        content.userInfo = PushPayload.userInfo(for: request)
        switch NotificationPolicy.interruption(for: request) {
        case .passive: content.interruptionLevel = .passive
        case .active: content.interruptionLevel = .active
        case .timeSensitive: content.interruptionLevel = .timeSensitive
        }
        if request.kind == .notification {
            content.categoryIdentifier = PushCategory.notification
        } else if request.isActionsEligible {
            content.categoryIdentifier = PushCategory.actionsCategoryIdentifier(requestID: request.id)
        } else {
            content.categoryIdentifier = PushCategory.question
        }
        locallyPresented.insert(request.id)
        let center = self.center
        let requestID = request.id
        Task { @MainActor [weak self] in
            guard let self else { return }
            // 非同期レース対策: 追加直前に終端/削除済みでないか再確認する。
            if self.terminalRemovedIDs.contains(requestID) { return }
            if let current = self.model?.store.request(id: requestID), current.status.isTerminal { return }
            if let current = self.model?.store.request(id: requestID), !NotificationPolicy.shouldPresent(request: current) { return }
            let delivered = await center.deliveredNotifications()
            // userInfo.request_id で二重提示を防ぐ (APNs identifier は任意)。
            let pairs: [(identifier: String, userInfo: [AnyHashable: Any])] = delivered.map { ($0.request.identifier, $0.request.content.userInfo) }
            if !NotificationPolicy.matchingIdentifiers(delivered: pairs, requestIDs: [requestID]).isEmpty { return }
            // 取得後にもう一度終端チェック (await の間に更新が来た場合)。
            if self.terminalRemovedIDs.contains(requestID) { return }
            if let current = self.model?.store.request(id: requestID), current.status.isTerminal { return }
            try? await center.add(UNNotificationRequest(identifier: requestID, content: content, trigger: nil))
            // 追加後に終端になっていたら即座に消す (競合ウィンドウを閉じる)。
            if self.terminalRemovedIDs.contains(requestID) {
                center.removeDeliveredNotifications(withIdentifiers: [requestID])
                center.removePendingNotificationRequests(withIdentifiers: [requestID])
            }
        }
    }

    func presentReplyFailure(requestID: String, reason: ReplyFailureReason) {
        let content = UNMutableNotificationContent()
        content.sound = .default
        content.threadIdentifier = PushCategory.threadID
        content.userInfo = ["request_id": requestID, "kind": "question"]
        switch reason {
        case .unreachable:
            content.title = "回答を送信できませんでした"
            content.body = RelayError.unreachableMessage + "。入力内容は下書きとして保存しました。タップして送り直せます"
        case .failed:
            content.title = "回答を送信できませんでした"
            content.body = "入力内容は下書きとして保存しました。タップして送り直せます"
        case .alreadyResolved:
            content.title = "回答は送信されませんでした"
            content.body = RelayError.alreadyResolved.userMessage
        case .signedOut:
            content.title = "回答を送信できませんでした"
            content.body = RelayError.unauthorized.userMessage
        }
        center.add(UNNotificationRequest(identifier: Self.replyFailureIdentifier(requestID), content: content, trigger: nil))
    }

    // MARK: Delegate callbacks (メインスレッドで呼ばれる)

    fileprivate func presentationOptions(payload: PushPayload?, isRemote: Bool) -> UNNotificationPresentationOptions {
        let show: UNNotificationPresentationOptions = [.banner, .list, .sound]
        guard let payload, isRemote else { return show }
        // フォアグラウンドで Push が届いた: 一覧を更新する。WebSocket 経由ですでに通知済みなら重ねて出さない。
        let alreadyPresented = locallyPresented.contains(payload.requestID)
        Task { await model?.refreshRequest(id: payload.requestID) }
        return alreadyPresented ? [] : show
    }

    fileprivate func handleResponse(payload: PushPayload?, actionIdentifier: String, replyText: String?) async {
        guard let payload, let model else { return }
        if let choiceIndex = PushCategory.choiceIndex(fromActionIdentifier: actionIdentifier) {
            // actions モード: 正確な choice_index で回答する。失敗時は通常の回答失敗導線に乗せるため
            // 結果に応じて処理する (圏外でもリクエストは pending のまま残る)。
            let task = UIApplication.shared.beginBackgroundTask(withName: "oyobidashi.choice")
            _ = await model.submitChoiceFromNotification(requestID: payload.requestID, choiceIndex: choiceIndex)
            UIApplication.shared.endBackgroundTask(task)
            return
        }
        if actionIdentifier == PushCategory.replyAction {
            guard let replyText else { return }
            // バックグラウンドで送信する。失敗時の下書き保存と通知は AppModel が行う。
            let task = UIApplication.shared.beginBackgroundTask(withName: "oyobidashi.reply")
            await model.submitNotificationReply(requestID: payload.requestID, text: replyText)
            UIApplication.shared.endBackgroundTask(task)
        } else if actionIdentifier == UNNotificationDefaultActionIdentifier {
            // text モード / 通常タップ: 詳細を開く。
            terminalRemovedIDs.remove(payload.requestID)
            router?.open(requestID: payload.requestID)
            await model.refreshRequest(id: payload.requestID)
        }
    }
}

/// delegate メソッドは任意のスレッドから呼ばれうるので、actor に属さないクラスで受けてメインに渡す。
final class NotificationDelegateProxy: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    weak var coordinator: NotificationCoordinator?

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let payload = PushPayload(userInfo: notification.request.content.userInfo)
        let isRemote = notification.request.trigger is UNPushNotificationTrigger
        DispatchQueue.main.async { [coordinator] in
            completionHandler(coordinator?.presentationOptions(payload: payload, isRemote: isRemote) ?? [.banner, .list, .sound])
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = PushPayload(userInfo: response.notification.request.content.userInfo)
        let actionIdentifier = response.actionIdentifier
        let replyText = (response as? UNTextInputNotificationResponse)?.userText
        Task { @MainActor [coordinator] in
            await coordinator?.handleResponse(payload: payload, actionIdentifier: actionIdentifier, replyText: replyText)
            completionHandler()
        }
    }
}
