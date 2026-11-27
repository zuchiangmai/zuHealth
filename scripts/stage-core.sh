#!/bin/sh
# Builds `health` and puts it where Tauri's externalBin expects it: gui/src-tauri/binaries/health-<host triple>.
# Usage: scripts/stage-core.sh [debug|release]
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
profile=${1:-debug}
triple=$(rustc -vV | sed -n 's/^host: //p')
ext=""
case "$triple" in *windows*) ext=".exe" ;; esac
if [ "$profile" = release ]; then
  cargo build --manifest-path "$root/Cargo.toml" -p health --release
else
  cargo build --manifest-path "$root/Cargo.toml" -p health
fi
mkdir -p "$root/gui/src-tauri/binaries"
cp "$root/target/$profile/health$ext" "$root/gui/src-tauri/binaries/health-$triple$ext"
