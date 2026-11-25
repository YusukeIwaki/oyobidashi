import XCTest
@testable import OyobidashiKit

final class BillingPlanPresentationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var end: Date { now.addingTimeInterval(86_400) }

    private func paid(_ periods: [BillingRenewalPeriod] = [], assigned: Bool = false, expiresAt: Date? = nil) -> BillingPlanPresentation {
        BillingPlanPresentation(status: .init(enabled: true, active: true, expiresAt: expiresAt ?? end, voiceTraining: .init(free: true, plus: false)), renewalPeriods: periods, isAssigned: assigned, now: now)
    }

    func testDisabledDeploymentDoesNotOfferPlansOrRestore() {
        let p = BillingPlanPresentation(status: .disabled, now: now)
        XCTAssertFalse(p.isEnabled)
        XCTAssertEqual(p.action(for: .standard), .none)
        XCTAssertFalse(p.canRestore(isWorking: false))
    }

    func testFreePlanShowsRequestedSummaryAndUpgradeAction() {
        let p = BillingPlanPresentation(status: .init(enabled: true, voiceTraining: .init(free: true, plus: false)), now: now)
        XCTAssertEqual(p.title, "FREE")
        XCTAssertEqual(p.voiceSummary, "日常会話に適したモデルを使います。")
        XCTAssertEqual(p.changeTitle, "変更")
        XCTAssertEqual(p.restoreTitle, "購入を復元")
        XCTAssertEqual(p.actionTitle(for: .free), "現在のプラン")
        XCTAssertEqual(p.action(for: .free), .none)
        XCTAssertEqual(p.actionTitle(for: .standard), "アップグレード")
        XCTAssertEqual(p.action(for: .standard), .purchase)
        XCTAssertNil(p.periodDescription { _ in "終了日" })
    }

    func testRenewingPlanShowsPaidSummaryAndRenewalDate() {
        let p = paid([.init(expiresAt: end, willAutoRenew: true)])
        XCTAssertEqual(p.title, "PLUS")
        XCTAssertEqual(p.voiceSummary, "より高精度なモデルを使います。")
        XCTAssertEqual(p.nextRenewalDate, end)
        XCTAssertEqual(p.periodDescription { _ in "11月30日" }, "次回更新日：11月30日")
        XCTAssertNil(p.freePlanStartsAt)
        XCTAssertEqual(p.actionTitle(for: .free), "FREEに戻す")
        XCTAssertEqual(p.action(for: .free), .manageSubscriptions)
    }

    func testCancellationKeepsPaidPlanUntilTheVerifiedDeadline() {
        let p = paid([.init(expiresAt: end, willAutoRenew: false)])
        XCTAssertEqual(p.currentPlan, .standard)
        XCTAssertEqual(p.title, "PLUS")
        XCTAssertEqual(p.freePlanStartsAt, end)
        XCTAssertEqual(p.periodDescription { _ in "11月30日" }, "11月30日からFREEになります。")
        XCTAssertEqual(p.actionTitle(for: .free), "FREEへの変更を予約済み")
        XCTAssertEqual(p.action(for: .free), .none)
        // App Store の管理画面から更新の再開も行える。
        XCTAssertEqual(p.actionTitle(for: .standard), "サブスクリプションを管理")
        XCTAssertEqual(p.action(for: .standard), .manageSubscriptions)
    }

    func testSelectingFreeDoesNotChangeTheCurrentPaidPlan() {
        let p = paid([.init(expiresAt: end, willAutoRenew: true)])
        XCTAssertEqual(p.action(for: .free), .manageSubscriptions)
        XCTAssertEqual(p.currentPlan, .standard)
        XCTAssertNil(p.freePlanStartsAt)
    }

    func testGooglePurchaseShowsPlusWithoutOpeningAppStoreManagement() {
        let p = BillingPlanPresentation(status: .init(enabled: true, active: true, expiresAt: end, activeStores: ["google"]), now: now)
        XCTAssertEqual(p.title, "PLUS")
        XCTAssertTrue(p.hasGoogleSubscription)
        XCTAssertEqual(p.action(for: .free), .none)
        XCTAssertEqual(p.action(for: .standard), .none)
    }

    func testAppleCancellationDoesNotPromiseFreeWhileGooglePlayAlsoGrantsPlus() {
        let p = BillingPlanPresentation(
            status: .init(enabled: true, active: true, expiresAt: end, activeStores: ["apple", "google"]),
            renewalPeriods: [.init(expiresAt: end, willAutoRenew: false)], now: now
        )
        XCTAssertTrue(p.hasGoogleSubscription)
        XCTAssertNil(p.freePlanStartsAt)
        XCTAssertEqual(p.action(for: .free), .manageSubscriptions)
    }

    func testExpiredServerStatusShowsFreeDespiteCachedRenewalInformation() {
        let p = BillingPlanPresentation(status: .init(enabled: true, active: false, expiresAt: end), renewalPeriods: [.init(expiresAt: end, willAutoRenew: false)], now: now)
        XCTAssertEqual(p.title, "FREE")
        XCTAssertEqual(p.voiceSummary, "日常会話に適したモデルを使います。")
        XCTAssertNil(p.freePlanStartsAt)
        XCTAssertNil(p.periodDescription { _ in "終了日" })
        XCTAssertEqual(p.action(for: .standard), .purchase)
    }

    func testUnknownRenewalOnlyShowsTheServerExpiration() {
        let p = paid([.init(expiresAt: end, willAutoRenew: nil)])
        XCTAssertNil(p.freePlanStartsAt)
        XCTAssertNil(p.nextRenewalDate)
        XCTAssertEqual(p.periodDescription { _ in "11月30日" }, "現在の有効期限：11月30日")
        XCTAssertEqual(p.action(for: .free), .manageSubscriptions)
    }

    func testPlansShowModelBenefitsAndRecipientsWithIdenticalTrainingTerms() throws {
        let json = Data(#"{"enabled":true,"voice_training":{"free":false,"plus":false},"voice_plan_providers":{"free":"meta","plus":"gemini"}}"#.utf8)
        let status = try OyobidashiJSON.makeDecoder().decode(BillingStatus.self, from: json)
        let p = BillingPlanPresentation(status: status, now: now)
        XCTAssertEqual(p.voiceSummary(for: .free), "日常会話に適したモデルを使います。\n通話の文字起こしと質問・会話履歴をMetaへ送信します。")
        XCTAssertEqual(p.voiceSummary(for: .standard), "より高精度なモデルを使います。\n通話の文字起こしと質問・会話履歴をGoogle（Gemini）へ送信します。")
    }

    func testLinkedClaudeShowsItsOwnBillingAndRecipient() {
        let status = BillingStatus(enabled: true, voiceProvider: "anthropic-linked", voicePlanProviders: ["free": "meta", "plus": "gemini"])
        let p = BillingPlanPresentation(status: status, now: now)
        XCTAssertEqual(p.voiceSummary(for: .free), "通話には連携したClaudeを使い、APIの利用分はAnthropicから直接請求されます。")
        XCTAssertEqual(p.voiceSummary(for: .standard), p.voiceSummary(for: .free))
    }

    func testMissingRenewalDoesNotClaimCancellation() {
        XCTAssertNil(paid().freePlanStartsAt)
        XCTAssertNil(paid().nextRenewalDate)
    }

    func testMissingServerExpirationDoesNotInventAFreePlanDate() {
        let p = BillingPlanPresentation(status: .init(enabled: true, active: true), renewalPeriods: [.init(expiresAt: end, willAutoRenew: false)], now: now)
        XCTAssertNil(p.freePlanStartsAt)
        XCTAssertNil(p.periodDescription { _ in "11月30日" })
    }

    func testAnotherRenewingPeriodPreventsAnIncorrectFreePlanPromise() {
        let p = paid([.init(expiresAt: end, willAutoRenew: false), .init(expiresAt: end.addingTimeInterval(-100), willAutoRenew: true)])
        XCTAssertNil(p.freePlanStartsAt)
        XCTAssertNotNil(p.nextRenewalDate)
    }

    func testAnUnverifiedRenewalPreventsAnIncorrectFreePlanPromise() {
        let p = paid([.init(expiresAt: end, willAutoRenew: false), .init(expiresAt: end, willAutoRenew: nil)])
        XCTAssertNil(p.freePlanStartsAt)
    }

    func testLaterServerEntitlementPreventsEarlyDowngradeMessage() {
        let p = paid([.init(expiresAt: end, willAutoRenew: false)], expiresAt: end.addingTimeInterval(100))
        XCTAssertNil(p.freePlanStartsAt)
    }

    func testExpiredLocalPeriodDoesNotConfirmCancellation() {
        let p = paid([.init(expiresAt: now, willAutoRenew: false)])
        XCTAssertNil(p.freePlanStartsAt)
    }

    func testAssignedPlanCannotBePurchasedOrCancelledPersonally() {
        let p = paid([.init(expiresAt: end, willAutoRenew: false)], assigned: true)
        XCTAssertEqual(p.currentPlan, .standard)
        XCTAssertNil(p.freePlanStartsAt)
        XCTAssertEqual(p.action(for: .free), .none)
        XCTAssertEqual(p.action(for: .standard), .none)
        XCTAssertEqual(p.actionTitle(for: .free), "組織で管理されています")
    }

    func testUpgradeRequiresLoadedProductAndCannotDoubleSubmit() {
        let p = BillingPlanPresentation(status: .init(enabled: true), now: now)
        XCTAssertFalse(p.isActionEnabled(for: .standard, hasProduct: false, isLoadingProducts: false, isWorking: false))
        XCTAssertFalse(p.isActionEnabled(for: .standard, hasProduct: true, isLoadingProducts: true, isWorking: false))
        XCTAssertFalse(p.isActionEnabled(for: .standard, hasProduct: true, isLoadingProducts: false, isWorking: true))
        XCTAssertTrue(p.isActionEnabled(for: .standard, hasProduct: true, isLoadingProducts: false, isWorking: false))
    }

    func testPaidManagementAndRestoreWorkWithoutProductInformation() {
        let p = paid()
        XCTAssertTrue(p.isActionEnabled(for: .free, hasProduct: false, isLoadingProducts: true, isWorking: false))
        XCTAssertTrue(p.canRestore(isWorking: false))
        XCTAssertFalse(p.isActionEnabled(for: .free, hasProduct: true, isLoadingProducts: false, isWorking: true))
        XCTAssertFalse(p.canRestore(isWorking: true))
    }

    func testPriceTextPreservesTheStoreKitCurrency() {
        XCTAssertNil(BillingPlanPresentation.Plan.free.priceText(displayPrice: nil))
        XCTAssertNil(BillingPlanPresentation.Plan.free.priceText(displayPrice: "¥150"))
        XCTAssertEqual(BillingPlanPresentation.Plan.standard.priceText(displayPrice: "¥150"), "¥150/月")
        XCTAssertEqual(BillingPlanPresentation.Plan.standard.priceText(displayPrice: "$0.99"), "$0.99/月")
        XCTAssertNil(BillingPlanPresentation.Plan.standard.priceText(displayPrice: nil))
    }
}
