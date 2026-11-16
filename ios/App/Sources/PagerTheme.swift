import OyobidashiKit
import SwiftUI

/// ページャー (ポケベル) テーマ: 温かいクリーム、濃いインク、オレンジ、小さな緑 LCD。
enum PagerTheme {
    static let cream = Color(red: 0.992, green: 0.965, blue: 0.906) // #FDF6E7
    static let creamDeep = Color(red: 0.965, green: 0.918, blue: 0.827)
    static let ink = Color(red: 0.11, green: 0.11, blue: 0.14)
    static let inkSoft = Color(red: 0.38, green: 0.36, blue: 0.33)
    static let orange = Color(red: 0.91, green: 0.36, blue: 0.15) // #E85D26
    static let orangeSoft = Color(red: 1.0, green: 0.92, blue: 0.85)
    static let lcd = Color(red: 0.66, green: 0.84, blue: 0.64)
    static let lcdDeep = Color(red: 0.25, green: 0.45, blue: 0.28)
    static let card = Color.white.opacity(0.72)

    static func priorityColor(_ priority: RequestPriority) -> Color {
        switch priority {
        case .low: return inkSoft
        case .normal: return lcdDeep
        case .high: return orange
        case .urgent: return .red
        case .unknown: return inkSoft
        }
    }
}

extension RequestPriority {
    var japaneseLabel: String {
        switch self {
        case .low: return "低"
        case .normal: return "通常"
        case .high: return "高"
        case .urgent: return "緊急"
        case .unknown(let r): return r
        }
    }
}

extension PresenceAvailability {
    var japaneseLabel: String {
        switch self {
        case .available: return "対応可"
        case .busy: return "取り込み中"
        case .away: return "離席中"
        case .unknown(let r): return r
        }
    }
    var systemImage: String {
        switch self {
        case .available: return "checkmark.circle.fill"
        case .busy: return "moon.fill"
        case .away: return "person.crop.circle.badge.clock"
        case .unknown: return "questionmark.circle"
        }
    }
}

/// ページャー本体のベクターアイコン (3キー + AI スパークル)。資産画像ではなくコード描画。
struct PagerIconView: View {
    var size: CGFloat = 40
    var body: some View {
        Canvas { context, canvasSize in
            let s = min(canvasSize.width, canvasSize.height)
            let scale = s / 100
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> Path {
                Path(roundedRect: CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale), cornerRadius: r * scale)
            }
            // 本体
            context.fill(rect(8, 22, 84, 62, 14), with: .color(PagerTheme.ink))
            context.fill(rect(11, 25, 78, 56, 11), with: .color(Color(red: 0.18, green: 0.18, blue: 0.22)))
            // LCD
            context.fill(rect(18, 32, 64, 22, 5), with: .color(PagerTheme.lcd))
            // LCD テキスト風ドット
            for i in 0..<5 {
                context.fill(rect(23 + CGFloat(i) * 11, 40, 7, 5, 1), with: .color(PagerTheme.lcdDeep.opacity(0.75)))
            }
            // 3キー
            for i in 0..<3 {
                context.fill(rect(20 + CGFloat(i) * 22, 62, 16, 12, 4), with: .color(PagerTheme.orange))
            }
            // AI スパークル (4-point star)
            var star = Path()
            let cx: CGFloat = 82, cy: CGFloat = 18, r1: CGFloat = 11, r2: CGFloat = 3.2
            for i in 0..<8 {
                let angle = Double(i) * .pi / 4 - .pi / 2
                let r = i % 2 == 0 ? r1 : r2
                let p = CGPoint(x: (cx + CGFloat(cos(angle)) * r) * scale, y: (cy + CGFloat(sin(angle)) * r) * scale)
                if i == 0 { star.move(to: p) } else { star.addLine(to: p) }
            }
            star.closeSubpath()
            context.fill(star, with: .color(PagerTheme.orange))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
