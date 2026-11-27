#!/usr/bin/env bash
# Plan §2.2: only health-connect may open network connections. No other crate may depend on a networking
# crate; the binary may reach one only through health-connect (pruned from its tree here).
# zbus (Linux Secret Service) talks D-Bus over a local socket; that is IPC, not network.
set -euo pipefail
banned='^(reqwest|hyper|ureq|isahc|curl|surf|attohttpc|tokio|async-std|mio|socket2|h2|rustls|native-tls|openssl-probe|tungstenite|str0m|if-addrs) '
for crate in health-core health-api health-ocr health-proto health-runtime health; do
  prune=()
  case "$crate" in health | health-runtime) prune=(--prune health-connect) ;; esac
  tree=$(cargo tree -p "$crate" -e normal --target all --prefix none --format '{p}' ${prune[@]+"${prune[@]}"})
  if sort -u <<<"$tree" | grep -E "$banned"; then
    echo "error: $crate depends on a networking crate (only health-connect may)" >&2
    exit 1
  fi
done
# The Tauri shell links a web view (which needs sockets of its own), so the rule there is narrower: no HTTP client
# crate and no HTTP plugin among the shell's and plugins' own dependencies, on any target; and the native plugin code
# opens no connections either. tauri itself is pruned: on mobile it links reqwest only for `tauri ios|android dev`
# (#[cfg(all(dev, mobile))], fetching the UI from the dev server), never in a release build.
shell=$(cargo tree -p health-app -e normal --target all --prefix none --format '{p}' --prune health-connect --prune tauri)
if sort -u <<<"$shell" | grep -E '^(reqwest|ureq|isahc|attohttpc|surf|tauri-plugin-http|tauri-plugin-upload|tauri-plugin-websocket) '; then
  echo "error: the shell depends on an HTTP client (only health-connect may connect)" >&2
  exit 1
fi
if grep -rnE 'URLSession|NSURLConnection|OkHttp|HttpURLConnection|java\.net\.(URL|Socket)' "$(dirname "$0")/../plugins" --include=*.swift --include=*.kt; then
  echo "error: native plugin code opens a connection (only health-connect may)" >&2
  exit 1
fi
echo "no networking crates outside health-connect"
