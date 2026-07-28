// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "Taskloop",
  platforms: [.iOS(.v17)],
  targets: [.target(name: "Taskloop", path: "Sources")]
)
