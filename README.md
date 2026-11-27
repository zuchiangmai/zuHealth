# zuHealth

Health data app for desktop (macOS, Windows, Linux), iPhone/iPad and Android: a Rust core inside one Tauri 2 project.
The layout and the seams are described in [docs/architecture.md](docs/architecture.md).

```sh
cargo test                                            # core, runtime, sidecar
(cd gui && npm ci && npx tauri dev)                   # desktop (stages the `health` sidecar first)

. scripts/mobile-env.sh                               # Android SDK/NDK/JDK paths
(cd gui && npx tauri android build --debug --apk --target aarch64 --target x86_64)
(cd gui && npx tauri android dev --open)              # Android Studio: keep this running while it builds
(cd gui && npx tauri ios build --debug --target aarch64-sim)
(cd gui && npx tauri ios dev --open)                  # Xcode: same
```

MIT licensed.
