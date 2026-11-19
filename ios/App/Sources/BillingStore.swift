import Foundation
import OyobidashiKit
import StoreKit

/// サブスクリプション表示とサーバー同期。ローカルでは何も解放せず、表示はサーバーの状態に従う。
@MainActor
final class BillingStore: ObservableObject {
    @Published private(set) var status: BillingStatus?
    @Published private(set) var products: [Product] = []
    @Published private(set) var isAssigned = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var productErrorMessage: String?
    @Published private(set) var noticeMessage: String?
    @Published private(set) var renewalPeriods: [BillingRenewalPeriod] = []
    @Published private(set) var isWorking = false
    @Published private(set) var isLoadingProducts = false

    private let model: AppModel
    private let attestor = AppAttestor()
    private let keyStore = UserDefaultsAttestKeyStore()
    private var updatesTask: Task<Void, Never>?
    private var storefrontTask: Task<Void, Never>?
    private var syncTail: Task<Void, Never>?
    private var syncSequence = 0
    private var displayedCredentials: Credentials?
    private var refreshQueued = false
    private var statusRevision = 0
    private var revokedJWS: [String] = []
    private var revokedTransactions: [Transaction] = []
    private var started = false

    init(model: AppModel) {
        self.model = model
    }

    private var client: RelayClient? {
        guard let credentials = model.credentials, credentials.endpoint.isOfficialCloud else { return nil }
        return RelayClient(endpoint: credentials.endpoint, deviceToken: credentials.deviceToken)
    }

    var productIDs: [String] { status?.apple?.productIDs ?? [] }
    var product: Product? { products.first }
    var planPresentation: BillingPlanPresentation {
        guard let displayedCredentials, displayedCredentials == model.credentials,
              displayedCredentials.endpoint.isOfficialCloud else {
            return BillingPlanPresentation(status: .disabled)
        }
        return BillingPlanPresentation(status: status ?? .disabled, renewalPeriods: renewalPeriods, isAssigned: isAssigned)
    }

    func start() {
        guard !started else { return }
        started = true
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handleUpdate(result)
            }
        }
        storefrontTask = Task { [weak self] in
            for await _ in Storefront.updates {
                await self?.refresh()
            }
        }
        Task { await refreshAndSync() }
    }

    func refresh() async {
        let credentials = model.credentials
        if displayedCredentials != credentials {
            displayedCredentials = credentials
            status = nil
            products = []
            renewalPeriods = []
            isAssigned = false
            errorMessage = nil
            productErrorMessage = nil
            noticeMessage = nil
            statusRevision += 1
        }
        guard !isLoadingProducts else {
            refreshQueued = true
            return
        }
        guard let credentials, let client else { return }
        let revision = statusRevision
        isLoadingProducts = true
        defer {
            isLoadingProducts = false
            if refreshQueued || model.credentials != credentials {
                refreshQueued = false
                Task { [weak self] in await self?.refresh() }
            }
        }
        do {
            let fetched = try await client.billingStatus()
            guard model.credentials == credentials else { return }
            // 同期が先に完了したとき、古い GET の応答でその結果を上書きしない。
            if revision == statusRevision { status = fetched }
            let configuration = status ?? fetched
            guard configuration.enabled, let ids = configuration.apple?.productIDs, !ids.isEmpty else {
                products = []
                renewalPeriods = []
                return
            }
            let loaded = try await Product.products(for: ids)
            guard model.credentials == credentials else { return }
            products = ids.compactMap { id in loaded.first { $0.id == id } }
            productErrorMessage = nil
            await refreshRenewalPeriods(credentials: credentials)
        } catch is CancellationError {
            return
        } catch {
            if model.credentials == credentials { productErrorMessage = Self.message(for: error) }
        }
    }

    func refreshAndSync() async {
        if status?.enabled == true, displayedCredentials == model.credentials {
            await syncCurrentEntitlements()
            await refresh()
        } else {
            await refresh()
            await syncCurrentEntitlements()
        }
    }

    func refreshAtExpiration() async {
        guard status?.active == true, let deadline = status?.expiresAt else { return }
        do {
            try await Task.sleep(for: .seconds(max(1, deadline.timeIntervalSinceNow + 1)))
        } catch { return }
        guard !Task.isCancelled, status?.expiresAt == deadline else { return }
        await refreshAndSync()
    }

    func purchase(using startPurchase: @MainActor (Product, UUID) async throws -> Product.PurchaseResult) async {
        guard let product, let credentials = model.credentials, displayedCredentials == credentials,
              let client, !isWorking else { return }
        isWorking = true
        clearFeedback()
        defer { isWorking = false }
        do {
            let latest = try await client.billingStatus()
            guard model.credentials == credentials else { return }
            statusRevision += 1
            status = latest
            guard latest.enabled, !latest.active, latest.apple?.productIDs.contains(product.id) == true else { return }
            guard let accountID = latest.purchaseAccountID else {
                errorMessage = "購入に必要なアカウント情報を取得できませんでした。"
                return
            }
            switch try await startPurchase(product, accountID) {
            case .success(let verification):
                guard case .verified = verification else {
                    errorMessage = "購入を確認できませんでした"
                    return
                }
                guard model.credentials == credentials else { return }
                await syncCurrentEntitlements(including: verification)
                guard model.credentials == credentials else { return }
                if errorMessage == nil && status?.active != true {
                    errorMessage = "有効な購読を確認できませんでした。購入を復元してもう一度お試しください。"
                }
            case .userCancelled, .pending:
                break
            @unknown default:
                break
            }
        } catch {
            if model.credentials == credentials { errorMessage = Self.message(for: error) }
        }
    }

    func restore() async {
        guard planPresentation.isEnabled, let credentials = model.credentials, !isWorking else { return }
        isWorking = true
        clearFeedback()
        defer { isWorking = false }
        do {
            try await AppStore.sync()
            guard model.credentials == credentials else { return }
            await refreshAndSync()
            guard model.credentials == credentials else { return }
            if errorMessage == nil && productErrorMessage == nil {
                let restored = status?.active == true && (status?.activeStores?.contains("apple") ?? true)
                noticeMessage = restored ? "購入情報を確認しました。" : "App Storeで復元できる購入は見つかりませんでした。"
            }
        } catch {
            if model.credentials == credentials { errorMessage = Self.message(for: error) }
        }
    }

    func sandboxRefundTransactionID() async -> UInt64? {
        guard let credentials = displayedCredentials, credentials == model.credentials,
              let status, status.active == true, let accountID = status.purchaseAccountID,
              let products = status.apple?.productIDs else { return nil }
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  transaction.environment == .sandbox, transaction.ownershipType == .purchased,
                  transaction.appAccountToken == accountID, products.contains(transaction.productID) else { continue }
            return model.credentials == credentials && self.status == status ? transaction.id : nil
        }
        return nil
    }

    func clearFeedback() {
        errorMessage = nil
        noticeMessage = nil
    }

    func syncCurrentEntitlements() async {
        await syncCurrentEntitlements(including: nil)
    }

    private func syncCurrentEntitlements(including purchase: VerificationResult<Transaction>?) async {
        // purchase と Transaction.updates が重なっても、アテステーションや
        // アサーションを並行送信しない。後から届いた更新も順に処理する。
        let previous = syncTail
        syncSequence += 1
        let sequence = syncSequence
        let credentials = model.credentials
        let task = Task<Void, Never> { [weak self] in
            if let previous { await previous.value }
            guard let self, self.model.credentials == credentials else { return }
            await self.performSync(including: purchase)
        }
        syncTail = task
        await task.value
        if sequence == syncSequence { syncTail = nil }
    }

    private func performSync(including purchase: VerificationResult<Transaction>?) async {
        guard let credentials = model.credentials, credentials.endpoint.isOfficialCloud else { return }
        if status == nil || displayedCredentials != credentials { await refresh() }
        guard model.credentials == credentials, displayedCredentials == credentials,
              let client, let status, status.enabled, let apple = status.apple else { return }
        let ids = Set(apple.productIDs)
        var jws: [String] = []
        var transactions: [Transaction] = []
        var assigned = false
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, ids.contains(transaction.productID) else { continue }
            jws.append(result.jwsRepresentation)
            transactions.append(transaction)
            if transaction.ownershipType == .assigned { assigned = true }
        }
        // StoreKit の購入結果や更新が届いても、購入一覧への反映が遅れることがある。
        if let purchase, case .verified(let transaction) = purchase,
           ids.contains(transaction.productID), !jws.contains(purchase.jwsRepresentation) {
            jws.append(purchase.jwsRepresentation)
            if !transactions.contains(where: { $0.id == transaction.id }) { transactions.append(transaction) }
        }
        guard model.credentials == credentials else { return }
        isAssigned = assigned
        let reportedRevokedJWS = Set(revokedJWS)
        let reportedRevokedIDs = Set(revokedTransactions.map(\.id))
        for revoked in reportedRevokedJWS where !jws.contains(revoked) { jws.append(revoked) }
        transactions.append(contentsOf: revokedTransactions.filter { revoked in !transactions.contains { $0.id == revoked.id } })
        // 報告するものが無ければ端末の確認も送信もしない。空の報告はサーバーの状態を変えない。
        guard !jws.isEmpty else { return }
        do {
            let sync = BillingSync(client: client, attestor: attestor, keyStore: keyStore)
            let updated = try await sync.sync(transactions: jws)
            guard model.credentials == credentials else { return }
            statusRevision += 1
            self.status = updated
            if updated.enabled {
                for transaction in transactions { await transaction.finish() }
                revokedJWS.removeAll { reportedRevokedJWS.contains($0) }
                revokedTransactions.removeAll { reportedRevokedIDs.contains($0.id) }
            }
            errorMessage = nil
            await refreshRenewalPeriods(credentials: credentials)
        } catch {
            if model.credentials == credentials { errorMessage = Self.message(for: error) }
        }
    }

    private func refreshRenewalPeriods(credentials: Credentials) async {
        guard status?.active == true else {
            renewalPeriods = []
            return
        }
        let ids = Set(productIDs)
        var groups: Set<String> = []
        var periods: [BillingRenewalPeriod] = []
        var unverifiedTransaction = false
        do {
            for product in products {
                guard let subscription = product.subscription,
                      groups.insert(subscription.subscriptionGroupID).inserted else { continue }
                for subscriptionStatus in try await subscription.status {
                    guard case .verified(let transaction) = subscriptionStatus.transaction else {
                        unverifiedTransaction = true
                        continue
                    }
                    guard ids.contains(transaction.productID), !transaction.isUpgraded,
                          transaction.revocationDate == nil,
                          let expiration = transaction.expirationDate, expiration > Date() else { continue }
                    let autoRenew: Bool?
                    if case .verified(let renewal) = subscriptionStatus.renewalInfo {
                        autoRenew = renewal.willAutoRenew
                    } else {
                        autoRenew = nil
                    }
                    periods.append(.init(expiresAt: expiration, willAutoRenew: autoRenew))
                }
            }
            guard model.credentials == credentials else { return }
            renewalPeriods = unverifiedTransaction ? [] : periods
        } catch {
            // 更新情報を確認できないときは、解約済みの表示を推測しない。
            if model.credentials == credentials { renewalPeriods = [] }
        }
    }

    private func handleUpdate(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result else { return }
        if transaction.revocationDate != nil, !revokedJWS.contains(result.jwsRepresentation) {
            revokedJWS.append(result.jwsRepresentation)
            revokedTransactions.append(transaction)
        }
        await syncCurrentEntitlements(including: result)
    }

    static func message(for error: Error) -> String {
        if let relayError = error as? RelayError { return relayError.userMessage }
        if let billingError = error as? BillingError, billingError == .attestationRequired { return "端末の確認が必要です。もう一度お試しください" }
        return error.localizedDescription
    }
}
