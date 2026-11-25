import OyobidashiKit
import StoreKit
import SwiftUI

struct CurrentPlanRow: View {
    let presentation: BillingPlanPresentation
    let change: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(presentation.title)
                    .fontWeight(.semibold)
                Text(presentation.voiceSummary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let period = presentation.periodDescription(formatDate: billingDateText) {
                    Text(period)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if presentation.isAssigned {
                    Text("組織から割り当てられています")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
            Spacer(minLength: 0)
            Button(presentation.changeTitle, action: change)
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
                .accessibilityLabel("プランを変更")
                .accessibilityIdentifier("billing.change")
        }
    }
}

struct PlanChangeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.purchase) private var purchase
    @ObservedObject var store: BillingStore
    @State private var selection: BillingPlanPresentation.Plan
    @State private var showingManagement = false
    @State private var sandboxRefundTransactionID: UInt64?

    init(store: BillingStore) {
        self.store = store
        _selection = State(initialValue: store.planPresentation.currentPlan)
    }

    var body: some View {
        NavigationStack {
            PlanPickerContent(
                presentation: store.planPresentation,
                displayPrice: store.product?.displayPrice,
                isLoadingProducts: store.isLoadingProducts,
                isWorking: store.isWorking || showingManagement,
                errorMessage: store.errorMessage ?? store.productErrorMessage,
                noticeMessage: store.noticeMessage,
                selection: $selection,
                confirm: confirm,
                restore: { Task { await store.restore() } },
                reload: { Task { await store.refresh() } },
                sandboxRefundTransactionID: sandboxRefundTransactionID
            )
            .navigationTitle("プランを変更")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("閉じる", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                        .disabled(store.isWorking || showingManagement)
                        .accessibilityLabel("プラン選択を閉じる")
                }
            }
        }
        .tint(PagerTheme.orange)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(store.isWorking || showingManagement)
        .manageSubscriptionsSheet(isPresented: $showingManagement)
        .onChange(of: showingManagement) { wasPresented, isPresented in
            if wasPresented && !isPresented {
                Task { await store.refreshAndSync() }
            }
        }
        .onChange(of: store.planPresentation.currentPlan) { old, new in
            selection = new
            if old == .free && new == .standard { dismiss() }
        }
        .onChange(of: store.planPresentation.isEnabled) { _, enabled in
            if !enabled { dismiss() }
        }
        .task(id: store.status?.expiresAt) { await store.refreshAtExpiration() }
        .task(id: store.status) {
            sandboxRefundTransactionID = await store.sandboxRefundTransactionID()
        }
        .task {
            store.clearFeedback()
            await store.refreshAndSync()
        }
    }

    private func confirm() {
        switch store.planPresentation.action(for: selection) {
        case .none: break
        case .purchase:
            Task {
                await store.purchase { product, accountID in
                    try await purchase(product, options: [.appAccountToken(accountID)])
                }
            }
        case .manageSubscriptions: showingManagement = true
        }
    }
}

private struct PlanPickerContent: View {
    let presentation: BillingPlanPresentation
    let displayPrice: String?
    let isLoadingProducts: Bool
    let isWorking: Bool
    let errorMessage: String?
    let noticeMessage: String?
    @Binding var selection: BillingPlanPresentation.Plan
    let confirm: () -> Void
    let restore: () -> Void
    let reload: () -> Void
    var sandboxRefundTransactionID: UInt64? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(BillingPlanPresentation.Plan.allCases) { plan in
                    PlanOptionCard(
                        plan: plan,
                        voiceSummary: presentation.voiceSummary(for: plan),
                        price: plan.priceText(displayPrice: displayPrice),
                        isLoading: plan == .standard && isLoadingProducts,
                        isSelected: selection == plan,
                        isCurrent: presentation.currentPlan == plan
                    ) { selection = plan }
                    .disabled(isWorking || presentation.isAssigned)
                }

                if let period = presentation.periodDescription(formatDate: billingDateText) {
                    Text(period)
                        .font(.subheadline)
                        .foregroundStyle(PagerTheme.ink)
                        .accessibilityIdentifier("billing.period")
                }

                if presentation.isAssigned {
                    Text("組織から割り当てられた購読は、組織の管理者が変更します。")
                        .font(.footnote)
                        .foregroundStyle(PagerTheme.inkSoft)
                } else if presentation.currentPlan == .standard && selection == .free && presentation.action(for: .free) == .manageSubscriptions {
                    Text("App Storeで解約の手続きを行います。有効期限までは現在のプランをご利用いただけます。")
                        .font(.footnote)
                        .foregroundStyle(PagerTheme.inkSoft)
                } else if selection == .standard && presentation.currentPlan == .free {
                    Text("毎月自動更新されます。解約はApp Storeで手続きできます。")
                        .font(.footnote)
                        .foregroundStyle(PagerTheme.inkSoft)
                }

                if presentation.hasGoogleSubscription {
                    Text("Google Playで購入した購読は、AndroidのGoogle Playで管理できます。")
                        .font(.footnote)
                        .foregroundStyle(PagerTheme.inkSoft)
                }

                if presentation.currentPlan == .free && displayPrice == nil && !isLoadingProducts {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("料金を取得できませんでした。再読み込みしてください。")
                            .font(.footnote)
                            .foregroundStyle(PagerTheme.inkSoft)
                        Button("再読み込み", action: reload)
                            .font(.subheadline)
                            .disabled(isWorking)
                    }
                }

                Button(action: confirm) {
                    HStack(spacing: 10) {
                        if isWorking { ProgressView().tint(.white) }
                        Text(presentation.actionTitle(for: selection))
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity, minHeight: 28)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(!presentation.isActionEnabled(for: selection, hasProduct: displayPrice != nil, isLoadingProducts: isLoadingProducts, isWorking: isWorking))
                .accessibilityIdentifier("billing.confirm")

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                if let noticeMessage {
                    Text(noticeMessage)
                        .font(.footnote)
                        .foregroundStyle(PagerTheme.inkSoft)
                }

                Button(action: restore) {
                    Text(presentation.restoreTitle)
                        .underline()
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .font(.footnote)
                .foregroundStyle(PagerTheme.inkSoft)
                .buttonStyle(.plain)
                .disabled(!presentation.canRestore(isWorking: isWorking))
                .accessibilityIdentifier("billing.restore")

                if let sandboxRefundTransactionID {
                    SandboxRefundButton(transactionID: sandboxRefundTransactionID)
                        .disabled(isWorking)
                }
            }
            .frame(maxWidth: 560)
            .padding(24)
            .frame(maxWidth: .infinity)
        }
        .background(PagerTheme.cream.ignoresSafeArea())
    }
}

private struct SandboxRefundButton: View {
    let transactionID: UInt64
    @State private var showingRefund = false

    var body: some View {
        Button("Sandboxの返金をテスト") { showingRefund = true }
            .font(.footnote)
            .accessibilityIdentifier("billing.sandboxRefund")
            .refundRequestSheet(for: transactionID, isPresented: $showingRefund)
    }
}

private struct PlanOptionCard: View {
    let plan: BillingPlanPresentation.Plan
    let voiceSummary: String
    let price: String?
    let isLoading: Bool
    let isSelected: Bool
    let isCurrent: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(plan.title).font(.headline)
                        if isLoading {
                            ProgressView("料金を読み込んでいます")
                                .font(.footnote)
                        } else if let price {
                            Text(price).font(.title3.weight(.semibold))
                        }
                    }
                    Spacer(minLength: 0)
                    Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                        .font(.title2)
                        .foregroundStyle(isSelected ? PagerTheme.orange : PagerTheme.inkSoft)
                        .accessibilityHidden(true)
                }
                Text(voiceSummary)
                    .font(.subheadline)
                    .foregroundStyle(PagerTheme.inkSoft)
                if isCurrent {
                    Text("現在のプラン")
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(PagerTheme.creamDeep, in: Capsule())
                }
            }
            .foregroundStyle(PagerTheme.ink)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(PagerTheme.card, in: RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(isSelected ? PagerTheme.orange : PagerTheme.ink.opacity(0.18), lineWidth: isSelected ? 2 : 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("billing.plan.\(plan.rawValue)")
    }
}

private func billingDateText(_ date: Date) -> String {
    date.formatted(.dateTime.year().month(.wide).day().hour().minute().locale(Locale(identifier: "ja_JP")))
}

#if DEBUG
private enum PlanPreview {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let end = now.addingTimeInterval(86_400)
    static let free = BillingPlanPresentation(status: .init(enabled: true), now: now)
    static let cancelling = BillingPlanPresentation(status: .init(enabled: true, active: true, expiresAt: end), renewalPeriods: [.init(expiresAt: end, willAutoRenew: false)], now: now)
}

#Preview("プラン選択・無料") {
    NavigationStack {
        PlanPickerContent(presentation: PlanPreview.free, displayPrice: "¥150", isLoadingProducts: false, isWorking: false, errorMessage: nil, noticeMessage: nil, selection: .constant(.standard), confirm: {}, restore: {}, reload: {})
            .navigationTitle("プランを変更")
    }
    .tint(PagerTheme.orange)
}

#Preview("プラン選択・解約予約中") {
    NavigationStack {
        PlanPickerContent(presentation: PlanPreview.cancelling, displayPrice: "¥150", isLoadingProducts: false, isWorking: false, errorMessage: nil, noticeMessage: nil, selection: .constant(.free), confirm: {}, restore: {}, reload: {})
            .navigationTitle("プランを変更")
    }
    .tint(PagerTheme.orange)
}

#Preview("プラン選択・料金読み込み中") {
    PlanPickerContent(presentation: PlanPreview.free, displayPrice: nil, isLoadingProducts: true, isWorking: false, errorMessage: nil, noticeMessage: nil, selection: .constant(.standard), confirm: {}, restore: {}, reload: {})
}
#endif
