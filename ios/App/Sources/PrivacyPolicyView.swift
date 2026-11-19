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
