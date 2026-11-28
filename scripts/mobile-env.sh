# Environment for `tauri android ...` and command-line iOS builds (source it: `. scripts/mobile-env.sh`). Defaults fit
# Android Studio's install on macOS; set any of these yourself to override.
# Plugins' Swift is compiled by Tauri's build script with this minimum (else iOS 13, raised to 15 by Xcode 27), not
# the app's: keep it the app's (gen/apple/project.yml, iOS 17), or iOS 16+ APIs such as HealthKit's newer types fail.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-17.0}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)}"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
# NDK r23+ ships only llvm-ranlib, but the vendored OpenSSL build (SQLCipher) asks for <target>-ranlib.
case "$(uname -s)" in Darwin) host=darwin-x86_64 ;; *) host=linux-x86_64 ;; esac
ranlib="$NDK_HOME/toolchains/llvm/prebuilt/$host/bin/llvm-ranlib"
export RANLIB_aarch64_linux_android="$ranlib" RANLIB_x86_64_linux_android="$ranlib"
export RANLIB_armv7_linux_androideabi="$ranlib" RANLIB_i686_linux_android="$ranlib"
unset host ranlib
