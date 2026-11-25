import Foundation

/// StoreKit で検証できた購読期間。更新情報が検証できない場合は nil とし、解約済みとは扱わない。
public struct BillingRenewalPeriod: Equatable, Sendable {
    public var expiresAt: Date
    public var willAutoRenew: Bool?

    public init(expiresAt: Date, willAutoRenew: Bool?) {
        self.expiresAt = expiresAt
        self.willAutoRenew = willAutoRenew
    }
}

/// 表示と操作の選択だけを担う。利用権限は常にサーバーの active に従う。
public struct BillingPlanPresentation: Equatable, Sendable {
    public enum Plan: String, CaseIterable, Identifiable, Sendable {
        case free, standard

        public var id: String { rawValue }
        public var title: String {
            self == .free ? "FREE" : "PLUS"
        }
        public func priceText(displayPrice: String?) -> String? {
            self == .free ? nil : displayPrice.map { "\($0)/月" }
        }
    }

    public enum Action: Equatable, Sendable {
        case none, purchase, manageSubscriptions
    }

    public let isEnabled: Bool
    public let currentPlan: Plan
    public let isAssigned: Bool
    public let hasGoogleSubscription: Bool
    private let canManageInAppStore: Bool
    public let expiresAt: Date?
    public let nextRenewalDate: Date?
    public let freePlanStartsAt: Date?
    private let voiceTraining: BillingVoiceTraining?
    private let voicePlanProviders: [String: String]?
    private let usesLinkedClaude: Bool

    public init(status: BillingStatus, renewalPeriods: [BillingRenewalPeriod] = [], isAssigned: Bool = false, now: Date = Date()) {
        isEnabled = status.enabled
        voiceTraining = status.voiceTraining
        voicePlanProviders = status.voicePlanProviders
        usesLinkedClaude = status.voiceProvider == "anthropic-linked"
        currentPlan = status.enabled && status.active ? .standard : .free
        self.isAssigned = isAssigned
        hasGoogleSubscription = status.active && status.activeStores?.contains("google") == true
        canManageInAppStore = status.activeStores?.contains("apple") ?? true
        expiresAt = status.enabled && status.active ? status.expiresAt : nil

        let periods = renewalPeriods.filter { $0.expiresAt > now }
        if currentPlan == .standard, !isAssigned, canManageInAppStore {
            nextRenewalDate = periods.filter { $0.willAutoRenew == true }.map(\.expiresAt).min()
            if !hasGoogleSubscription, let deadline = status.expiresAt, deadline > now,
               let lastPeriod = periods.map(\.expiresAt).max(),
               abs(lastPeriod.timeIntervalSince(deadline)) < 1,
               periods.allSatisfy({ $0.willAutoRenew == false }) {
                freePlanStartsAt = deadline
            } else {
                freePlanStartsAt = nil
            }
        } else {
            nextRenewalDate = nil
            freePlanStartsAt = nil
        }
    }

    public var title: String { currentPlan.title }
    public var privacyNotice: String { privacyNotice(for: currentPlan) }

    public func privacyNotice(for plan: Plan) -> String {
        if usesLinkedClaude { return "通話には連携したClaudeを使い、APIの利用分はAnthropicから直接請求されます。" }
        let training: String
        switch plan == .free ? voiceTraining?.free : voiceTraining?.plus {
        case true?: training = "通話の内容がAIモデルの学習に使われる場合があります。"
        case false?: training = "通話の内容はAIモデルの学習に使われません。"
        case nil: training = "通話の学習利用は確認できません。"
        }
        guard let provider = voicePlanProviders?[plan == .free ? "free" : "plus"] else { return training }
        let recipient = VoiceAIDisclosure(provider: provider).recipientName
        return "通話の文字起こしと質問・会話履歴を\(recipient)へ送信します。\n\(training)"
    }
    public var changeTitle: String { "変更" }
    public var restoreTitle: String { "購入を復元" }

    public func periodDescription(formatDate: (Date) -> String) -> String? {
        if let freePlanStartsAt {
            return "\(formatDate(freePlanStartsAt))からFREEになります。"
        }
        if let nextRenewalDate {
            return "次回更新日：\(formatDate(nextRenewalDate))"
        }
        if let expiresAt {
            return "現在の有効期限：\(formatDate(expiresAt))"
        }
        return nil
    }

    public func action(for selection: Plan) -> Action {
        guard isEnabled, !isAssigned else { return .none }
        switch (currentPlan, selection) {
        case (.free, .free): return .none
        case (.free, .standard): return .purchase
        case (.standard, .free): return canManageInAppStore && freePlanStartsAt == nil ? .manageSubscriptions : .none
        case (.standard, .standard): return canManageInAppStore ? .manageSubscriptions : .none
        }
    }

    public func actionTitle(for selection: Plan) -> String {
        if isAssigned { return "組織で管理されています" }
        if currentPlan == .standard && !canManageInAppStore { return "現在のプラン" }
        switch (currentPlan, selection) {
        case (.free, .free): return "現在のプラン"
        case (.free, .standard): return "アップグレード"
        case (.standard, .free): return freePlanStartsAt == nil ? "FREEに戻す" : "FREEへの変更を予約済み"
        case (.standard, .standard): return "サブスクリプションを管理"
        }
    }

    public func isActionEnabled(for selection: Plan, hasProduct: Bool, isLoadingProducts: Bool, isWorking: Bool) -> Bool {
        guard !isWorking else { return false }
        switch action(for: selection) {
        case .none: return false
        case .purchase: return hasProduct && !isLoadingProducts
        case .manageSubscriptions: return true
        }
    }

    public func canRestore(isWorking: Bool) -> Bool { isEnabled && !isWorking }
}
