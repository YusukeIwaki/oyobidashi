// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "OyobidashiKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "OyobidashiKit", targets: ["OyobidashiKit"]),
    ],
    targets: [
        .target(name: "OyobidashiKit"),
        .testTarget(name: "OyobidashiKitTests", dependencies: ["OyobidashiKit"]),
    ]
)
