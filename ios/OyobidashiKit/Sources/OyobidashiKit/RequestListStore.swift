import Foundation
import Observation

/// 通知まわりの副作用。アプリ側が `UNUserNotificationCenter` で実装する。
@MainActor
public protocol NotificationManaging: AnyObject {
    /// 解決済みになった request の配信済み通知を消す (通知の identifier = request id)。
    func removeDelivered(requestIDs: [String])
    func removeAllDelivered()
    /// WebSocket で新着を受けたときに通知として提示する (APNs 資格情報が無くてもアプリ起動中は鳴らすため)。
    func presentIncoming(_ request: AgentRequest)
    /// 通知からの返信を送信できなかったことをローカル通知で知らせる。
    func presentReplyFailure(requestID: String, reason: ReplyFailureReason)
}

public enum ReplyFailureReason: Equatable, Sendable {
    /// 中継サーバーに届かなかった (圏外)。入力内容は下書きとして保存済み。
    case unreachable
    /// その他のエラー。入力内容は下書きとして保存済み。
    case failed
    /// すでに回答済み・取消・期限切れ。
    case alreadyResolved
    /// ペアリングが無効。
    case signedOut
}

/// 中継サーバー (LAN 内) に届くかどうか。
public enum RelayReachability: Equatable, Sendable {
    case unknown
    case reachable
    /// 圏外・別のネットワーク・relay 停止。ペアリングは有効なまま。
    case unreachable
}

public enum ConnectionStatus: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting(retryIn: Double)
}

public enum LoadState: Equatable, Sendable {
    case idle
    case loading
    case failed(RelayError)
}

public enum UpsertResult: Equatable, Sendable {
    case inserted
    case updated
    /// 同一内容 (重複イベント)
    case unchanged
    /// 手元のほうが新しい / 終端状態から pending へは戻さない
    case ignoredStale
}

/// request 一覧の状態。`created_at` 降順で保持する。
@MainActor
@Observable
public final class RequestListStore {
    public private(set) var requests: [AgentRequest] = []
    public private(set) var homeNotice: HomeNotice?
    /// 回答時に 409 を受けたが、サーバー上の最終状態をまだ取得できていない request。未回答一覧からは外す。
    public private(set) var locallyResolvedIDs: Set<String> = []
    public internal(set) var loadState: LoadState = .idle
    public internal(set) var connection: ConnectionStatus = .disconnected
    public internal(set) var reachability: RelayReachability = .unknown

    @ObservationIgnored private weak var notifications: (any NotificationManaging)?
    @ObservationIgnored private let drafts: DraftStore?

    /// `drafts` を渡すと、解決済みになった request の下書きを破棄する。
    public init(notifications: (any NotificationManaging)? = nil, drafts: DraftStore? = nil) {
        self.notifications = notifications
        self.drafts = drafts
    }

    // MARK: Queries

    public func isPending(_ request: AgentRequest) -> Bool {
        request.isAnswerable && !locallyResolvedIDs.contains(request.id)
    }

    /// 未回答の質問 (新しい順)。
    public var pending: [AgentRequest] { requests.filter { isPending($0) } }

    /// それ以外 (回答済み・取消・期限切れ・お知らせ)。
    public var history: [AgentRequest] { requests.filter { !isPending($0) } }

    public func request(id: String) -> AgentRequest? {
        requests.first { $0.id == id }
    }

    // MARK: Mutations

    /// 1件を取り込む。
    ///
    /// - 同一内容なら何もしない (重複イベントに対して冪等)。
    /// - 手元が終端状態で、届いたものが終端でなければ無視 (古いイベントで pending に戻さない)。
    /// - `updated_at` が手元より古ければ無視。ただし「手元が非終端 → 届いたものが終端」は常に採用。
    @discardableResult
    public func upsert(_ incoming: AgentRequest) -> UpsertResult {
        guard let index = requests.firstIndex(where: { $0.id == incoming.id }) else {
            requests.append(incoming)
            sort()
            didChange(incoming)
            return .inserted
        }
        let existing = requests[index]
        if existing == incoming { return .unchanged }
        if existing.status.isTerminal && !incoming.status.isTerminal { return .ignoredStale }
        let resolves = !existing.status.isTerminal && incoming.status.isTerminal
        if incoming.updatedAt < existing.updatedAt && !resolves { return .ignoredStale }
        requests[index] = incoming
        sort()
        didChange(incoming)
        return .updated
    }

    /// 一覧取得 (`GET /v1/requests`) の結果を取り込む。
    public func merge(_ list: [AgentRequest]) {
        for request in list { upsert(request) }
    }

    /// WebSocket イベントを反映する。
    public func apply(_ event: RelayEvent) {
        switch event {
        case .hello(let pendingNow, let notice):
            homeNotice = notice
            // hello の pending が「いま未回答のもの」の全量。手元で未回答扱いなのに含まれないものは
            // 切断中に解決されているので取り除く (最終状態は直後の一覧再取得で履歴に戻る)。
            let ids = Set(pendingNow.map(\.id))
            let gone = requests.filter { $0.isAnswerable && !ids.contains($0.id) }.map(\.id)
            if !gone.isEmpty {
                requests.removeAll { gone.contains($0.id) }
                locallyResolvedIDs.subtract(gone)
                gone.forEach { drafts?.remove($0) }
                notifications?.removeDelivered(requestIDs: gone)
            }
            for request in pendingNow { upsert(request) }
        case .created(let request):
            if upsert(request) == .inserted, request.kind == .notification || request.isAnswerable {
                notifications?.presentIncoming(request)
            }
        case .updated(let request):
            let wasCall = self.request(id: request.id)?.hasLiveCall == true
            upsert(request)
            if wasCall, request.isAnswerable, request.deliveryMode == .text, request.call?.state == .ended {
                notifications?.presentIncoming(request)
            }
        case .homeNoticeUpdated(let notice):
            homeNotice = notice
        case .pong, .unknown:
            break
        }
    }

    /// 回答が 409 `already_resolved` だった request を未回答一覧から外す。
    public func markResolvedLocally(id: String) {
        guard let request = request(id: id), request.isAnswerable else { return }
        locallyResolvedIDs.insert(id)
        drafts?.remove(id)
        notifications?.removeDelivered(requestIDs: [id])
    }

    public func remove(id: String) {
        requests.removeAll { $0.id == id }
        locallyResolvedIDs.remove(id)
        drafts?.remove(id)
        notifications?.removeDelivered(requestIDs: [id])
    }

    public func reset() {
        requests = []
        homeNotice = nil
        locallyResolvedIDs = []
        loadState = .idle
        connection = .disconnected
        reachability = .unknown
    }

    // MARK: Private

    private func sort() {
        requests.sort { lhs, rhs in
            lhs.createdAt != rhs.createdAt ? lhs.createdAt > rhs.createdAt : lhs.id > rhs.id
        }
    }

    private func didChange(_ request: AgentRequest) {
        if request.status != .pending {
            locallyResolvedIDs.remove(request.id)
            drafts?.remove(request.id)
            // Preserve a delivered one-way notice only while it is still notified.
            // Cancelled/expired notices must disappear just like withdrawn questions.
            if request.kind != .notification || request.status != .notified {
                notifications?.removeDelivered(requestIDs: [request.id])
            }
        }
    }
}
