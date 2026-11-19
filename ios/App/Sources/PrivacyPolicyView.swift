import OyobidashiKit
import SwiftUI

struct PrivacyPolicyView: View {
    private struct SectionContent: Decodable, Identifiable {
        let title: String
        let paragraphs: [String]
        let link: String?
        var id: String { title }
    }

    private static let publishedURL = URL(string: "https://ai.oyobidashi.me/privacy/")!
    private static let sections: [SectionContent] = {
        guard let url = Bundle.main.url(forResource: "privacy-policy", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([SectionContent].self, from: data)) ?? []
    }()

    var body: some View {
        List {
            ForEach(Self.sections) { section in
                Section(section.title) {
                    ForEach(section.paragraphs, id: \.self) { Text($0) }
                    if let link = section.link, let url = URL(string: link) {
                        Link("問い合わせ窓口を開く", destination: url)
                    }
                }
            }
            Link("Web版を開く", destination: Self.publishedURL)
        }
        .navigationTitle("プライバシーポリシー")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct VoiceConsentNotice: View {
    let disclosure: VoicePrivacyDisclosure
    @State private var showingPolicy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("会話データを \(disclosure.providerName) に送信").font(.headline)
            Text("音声で話すと、発話を文字に変換し、元の質問、補足、選択肢と関連する会話履歴とともに送信します。音声認識のため、Appleが音声を処理する場合があります。")
            Text(disclosure.trainingNotice)
            if disclosure.hasContributorTraining {
                Text("学習利用の対象となる通話には、個人情報や機密情報を含めないでください。こうした情報を含む場合は、文字で返信できます。")
            }
            Button("プライバシーポリシー") { showingPolicy = true }
        }
        .font(.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(PagerTheme.ink)
        .padding(14)
        .background(PagerTheme.lcd.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
        .sheet(isPresented: $showingPolicy) {
            NavigationStack {
                PrivacyPolicyView().toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("閉じる") { showingPolicy = false }
                    }
                }
            }
        }
    }
}

extension VoicePrivacyDisclosure {
    fileprivate var providerName: String {
        switch provider {
        case .anthropic: return "Anthropic"
        case .meta: return "Meta"
        case .claudeCode: return "Anthropic（接続先の Claude Code）"
        }
    }

    fileprivate var trainingNotice: String {
        guard provider != .claudeCode else {
            return "データの取り扱いには、接続先で使用するClaude Codeの設定とAnthropicの条件が適用されます。"
        }
        func description(_ value: Bool?) -> String {
            switch value {
            case true: return "学習利用の可能性があります"
            case false: return "学習には利用されません"
            case nil: return "学習利用の条件を確認できていません"
            }
        }
        let free = training?.free
        let plus = training?.plus
        if free == plus { return description(free) + "。" }
        return "FREEでは" + description(free) + "。PLUSでは" + description(plus) + "。"
    }

    fileprivate var hasContributorTraining: Bool {
        provider == .meta && (training?.free == true || training?.plus == true)
    }

    var spokenPrompt: String {
        let personalDataNotice = hasContributorTraining
            ? "学習利用の対象となる通話に個人情報や機密情報を含めないでください。"
            : ""
        return "発話を文字にして、質問や履歴と一緒に\(providerName)に送ります。音声認識にAppleが音声を処理する場合があります。"
            + trainingNotice + personalDataNotice
            + "音声で続ける場合は、同意します。文字で返信する場合は、同意しません、と話してください。"
    }
}
