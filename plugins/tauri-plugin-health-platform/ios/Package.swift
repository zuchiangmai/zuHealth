// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "tauri-plugin-health-platform",
  platforms: [
    .iOS(.v17)
  ],
  products: [
    .library(name: "tauri-plugin-health-platform", type: .static, targets: ["tauri-plugin-health-platform"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(name: "tauri-plugin-health-platform", dependencies: [.byName(name: "Tauri")], path: "Sources")
  ]
)
