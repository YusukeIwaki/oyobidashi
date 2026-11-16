#!/usr/bin/env swift
// ページャー + AI スパークルのベクターアイコンを CoreGraphics で描画して PNG 化する。
// 使い方: swift Scripts/GenerateIcon.swift [出力PNGパス]
// 画像生成モデルは使わず、ネイティブのベクター描画のみで生成する。
import CoreGraphics
import Foundation
import ImageIO

let outputPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
let size = 1024
let scale: CGFloat = CGFloat(size) / 100.0

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: r, green: g, blue: b, alpha: a)
}
let cream = color(0.992, 0.965, 0.906)
let ink = color(0.11, 0.11, 0.14)
let inkBody = color(0.18, 0.18, 0.22)
let orange = color(0.91, 0.36, 0.15)
let lcd = color(0.66, 0.84, 0.64)
let lcdDeep = color(0.25, 0.45, 0.28)

guard let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { fatalError("context") }
// CG は下原点。UIKit 風の上原点に合わせる。
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: 1, y: -1)

func roundedRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat, _ fill: CGColor) {
    let rect = CGRect(x: x * scale, y: y * scale, width: w * scale, height: h * scale)
    let path = CGPath(roundedRect: rect, cornerWidth: r * scale, cornerHeight: r * scale, transform: nil)
    ctx.addPath(path)
    ctx.setFillColor(fill)
    ctx.fillPath()
}

// 背景 (クリーム) + 薄いドット
ctx.setFillColor(cream)
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

// ページャー本体
roundedRect(8, 22, 84, 62, 14, ink)
roundedRect(11, 25, 78, 56, 11, inkBody)
// LCD
roundedRect(18, 32, 64, 22, 5, lcd)
for i in 0..<5 {
    roundedRect(23 + CGFloat(i) * 11, 40, 7, 5, 1, lcdDeep)
}
// 3キー (オレンジ)
for i in 0..<3 {
    roundedRect(20 + CGFloat(i) * 22, 62, 16, 12, 4, orange)
}
// キーのハイライト
ctx.setFillColor(color(1, 1, 1, 0.25))
for i in 0..<3 {
    let rect = CGRect(x: (22 + CGFloat(i) * 22) * scale, y: 64 * scale, width: 12 * scale, height: 3 * scale)
    ctx.fill(rect)
}
// AI スパークル (4-point star)
let cx: CGFloat = 82, cy: CGFloat = 18
ctx.beginPath()
for i in 0..<8 {
    let angle = Double(i) * .pi / 4 - .pi / 2
    let r: CGFloat = i % 2 == 0 ? 11 : 3.2
    let p = CGPoint(x: (cx + CGFloat(cos(angle)) * r) * scale, y: (cy + CGFloat(sin(angle)) * r) * scale)
    if i == 0 { ctx.move(to: p) } else { ctx.addLine(to: p) }
}
ctx.closePath()
ctx.setFillColor(orange)
ctx.fillPath()
// 小さな相棒スパークル
ctx.beginPath()
for i in 0..<8 {
    let angle = Double(i) * .pi / 4 - .pi / 2
    let r: CGFloat = i % 2 == 0 ? 5 : 1.6
    let p = CGPoint(x: (70 + CGFloat(cos(angle)) * r) * scale, y: (26 + CGFloat(sin(angle)) * r) * scale)
    if i == 0 { ctx.move(to: p) } else { ctx.addLine(to: p) }
}
ctx.closePath()
ctx.setFillColor(color(0.91, 0.36, 0.15, 0.7))
ctx.fillPath()

guard let image = ctx.makeImage() else { fatalError("image") }
let url = URL(fileURLWithPath: outputPath)
try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { fatalError("dest") }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("finalize") }
print("wrote \(outputPath)")
