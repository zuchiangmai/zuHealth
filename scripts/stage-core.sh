#!/bin/sh
# Builds `health` and puts it where Tauri's externalBin expects it: gui/src-tauri/binaries/health-<target triple>.
# Usage: scripts/stage-core.sh [debug|release] [target triple]
#   The triple defaults to this machine's; a universal macOS app needs both Mac triples staged:
#   scripts/stage-core.sh release aarch64-apple-darwin && scripts/stage-core.sh release x86_64-apple-darwin
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
profile=${1:-debug}
host=$(rustc -vV | sed -n 's/^host: //p')
triple=${2:-$host}
ext=""
case "$triple" in *windows*) ext=".exe" ;; esac
set -- --manifest-path "$root/Cargo.toml" -p health
[ "$profile" = release ] && set -- "$@" --release
[ "$triple" != "$host" ] && set -- "$@" --target "$triple"
cargo build "$@"
# where cargo puts it: CARGO_TARGET_DIR or build.target-dir may move it from <repo>/target
target_dir=$(cargo metadata --manifest-path "$root/Cargo.toml" --format-version 1 --no-deps | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
out="$target_dir/$profile"
[ "$triple" != "$host" ] && out="$target_dir/$triple/$profile"
mkdir -p "$root/gui/src-tauri/binaries"
cp "$out/health$ext" "$root/gui/src-tauri/binaries/health-$triple$ext"
