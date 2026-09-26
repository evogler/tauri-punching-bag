// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-audio-session",
  platforms: [
    .iOS(.v14)
  ],
  products: [
    .library(
      name: "tauri-plugin-audio-session",
      type: .static,
      targets: ["tauri-plugin-audio-session"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-audio-session",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
