// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DerNativePanel",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "DerNativePanel",
            path: "Sources/DerNativePanel"
        ),
        .testTarget(
            name: "DerNativePanelTests",
            dependencies: ["DerNativePanel"],
            path: "Tests/DerNativePanelTests"
        ),
    ]
)
