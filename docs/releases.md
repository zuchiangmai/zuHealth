# Releases

The Android app checks for updates when the person taps More › Check for updates. It reads the latest release of
`https://github.com/zuchiangmai/PhysiMind` and offers its APK if that is newer than the app. iOS updates through
the App Store, so the button is hidden there. A computer will update through Tauri's updater, with its own format
(not yet set up).

Code: `crates/health-runtime/src/update.rs` (the rules, with tests), `crates/health-connect` (`latest_release`, the
only network call), and `gui/src-tauri/src/mobile.rs` (`check_update` and `open_update`, which opens the download
in the browser; Android then offers to install it).

## Format

A release is found only if all of these hold:

- **Published**: not a draft and not a pre-release. GitHub's "latest release" skips both, and so does the check.
- **Tag** `v<version>`, for example `v0.2.0`. `<version>` is `major.minor.patch`, the same as `version` in
  `gui/src-tauri/tauri.conf.json` of the build. The check compares the numbers part by part (`0.10.0` is newer than
  `0.9.0`); a suffix after `-` or `+` is ignored.
- **Asset** named exactly `PhysiMind-<version>-android.apk`: one universal APK (all ABIs), for example
  `PhysiMind-0.2.0-android.apk`. Other assets (an `.aab` for Play, checksums) may sit beside it.
- **Signed with the same release key every time.** Android installs an update only over an app signed with the same
  key, so a debug-signed APK can't update a release one, and losing the key means a fresh install (and the data's
  key with it: see docs/shells.md, Backups). Keep the keystore out of the repo.
- **Body**: the release notes. The first 600 characters are shown in the update dialog.

The download is opened only if its URL starts with `https://github.com/zuchiangmai/PhysiMind/releases/download/`.

## Making one

1. Set `version` in `gui/src-tauri/tauri.conf.json` (and `CFBundleShortVersionString` in `gen/apple/project.yml`).
2. Build the signed universal APK: `(cd gui && npx tauri android build --apk)`, with the release signing configured
   in `gen/android` from the keystore kept outside the repo.
3. Rename it to `PhysiMind-<version>-android.apk`.
4. Create the release on GitHub: tag `v<version>`, the APK attached, notes in the body, published (not draft, not
   pre-release). `gh release create v0.2.0 PhysiMind-0.2.0-android.apk --title "PhysiMind 0.2.0" --notes "…"`
