//! Checking for a newer app on GitHub (Android: the APK is installed by hand; iOS updates through the App Store).
//! The release format is in docs/releases.md: a published (not draft, not pre-release) release tagged `v<version>`
//! with an asset `PhysiMind-<version>-android.apk`.

use serde::Serialize;

/// The repository releases come from
pub const REPO: &str = "zuchiangmai/PhysiMind";
/// Where its downloads are: the only addresses an update may be fetched from
pub const DOWNLOADS: &str = "https://github.com/zuchiangmai/PhysiMind/releases/download/";

#[derive(Debug, Serialize, PartialEq)]
pub struct Update {
    /// This app's version
    pub current: String,
    /// The newest published version, if there is a release at all
    pub latest: Option<String>,
    /// Newer than this app, with an Android package to download
    pub newer: bool,
    /// The package (on GitHub's downloads), when newer
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// What the release says about itself (its notes, shortened)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// `1.2.3` (a leading `v` and anything after `-` or `+` dropped) as numbers, for comparing
fn version(v: &str) -> Option<Vec<u64>> {
    let core = v.trim().trim_start_matches('v').split(['-', '+']).next()?;
    core.split('.').map(|p| p.parse().ok()).collect()
}

/// What `release` (GitHub's JSON for the latest release; None: none yet) means for an app at `current`.
pub fn read(current: &str, release: Option<&serde_json::Value>) -> Update {
    let mut u = Update { current: current.to_string(), latest: None, newer: false, url: None, notes: None };
    let Some(r) = release else { return u };
    if r["draft"].as_bool() == Some(true) || r["prerelease"].as_bool() == Some(true) {
        return u;
    }
    let Some(tag) = r["tag_name"].as_str() else { return u };
    let latest = tag.trim_start_matches('v').to_string();
    u.latest = Some(latest.clone());
    let (Some(have), Some(got)) = (version(current), version(&latest)) else { return u };
    if got <= have {
        return u;
    }
    let name = format!("PhysiMind-{latest}-android.apk");
    u.url = r["assets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["name"].as_str() == Some(name.as_str()))
        .filter_map(|a| a["browser_download_url"].as_str())
        .find(|url| url.starts_with(DOWNLOADS))
        .map(str::to_string);
    u.newer = u.url.is_some();
    u.notes = r["body"].as_str().map(|b| b.chars().take(600).collect());
    u
}

/// Asks GitHub for the latest release (the only network call is health-connect's).
pub fn check(current: &str) -> Result<Update, String> {
    let r = health_connect::latest_release(REPO).map_err(|e| e.to_string())?;
    Ok(read(current, r.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(tag: &str, asset: &str) -> serde_json::Value {
        json!({
            "tag_name": tag, "draft": false, "prerelease": false, "body": "Fixes",
            "assets": [{ "name": asset, "browser_download_url": format!("{DOWNLOADS}{tag}/{asset}") }],
        })
    }

    #[test]
    fn a_newer_release_with_its_apk_is_offered() {
        let u = read("0.1.0", Some(&release("v0.2.0", "PhysiMind-0.2.0-android.apk")));
        assert!(u.newer);
        assert_eq!(u.url.as_deref(), Some("https://github.com/zuchiangmai/PhysiMind/releases/download/v0.2.0/PhysiMind-0.2.0-android.apk"));
        // the same version, an older one, none at all: nothing to do
        assert!(!read("0.2.0", Some(&release("v0.2.0", "PhysiMind-0.2.0-android.apk"))).newer);
        assert!(!read("0.10.0", Some(&release("v0.9.0", "PhysiMind-0.9.0-android.apk"))).newer);
        assert_eq!(read("0.1.0", None), Update { current: "0.1.0".into(), latest: None, newer: false, url: None, notes: None });
        // newer but without the package, or a package elsewhere: not offered
        assert!(!read("0.1.0", Some(&release("v0.2.0", "app.apk"))).newer);
        let mut r = release("v0.2.0", "PhysiMind-0.2.0-android.apk");
        r["assets"][0]["browser_download_url"] = json!("https://example.com/PhysiMind-0.2.0-android.apk");
        assert!(!read("0.1.0", Some(&r)).newer);
        // a pre-release isn't one
        r = release("v0.2.0", "PhysiMind-0.2.0-android.apk");
        r["prerelease"] = json!(true);
        assert_eq!(read("0.1.0", Some(&r)).latest, None);
    }
}
