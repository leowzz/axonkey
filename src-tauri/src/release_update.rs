use semver::Version;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

pub(crate) fn is_newer_release(current: &Version, next: &Version) -> bool {
    next.major == current.major && next.pre.is_empty() && next.cmp_precedence(current).is_gt()
}

fn release_endpoint(current: &Version) -> tauri::Url {
    format!(
        "https://raw.githubusercontent.com/leowzz/axonkey/updates/v{}/latest.json",
        current.major
    )
    .parse()
    .expect("Update manifest URL has a fixed origin and numeric major version")
}

#[tauri::command]
pub(crate) async fn check_release_update(
    webview: tauri::Webview,
) -> Result<Option<serde_json::Value>, String> {
    let endpoint = release_endpoint(&webview.package_info().version);
    let update = webview
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    Ok(update.map(|update| {
        // Keep the plugin's resource and signed download/install path.
        let mut metadata = serde_json::json!({
            "currentVersion": update.current_version,
            "version": update.version,
            "body": update.body,
            "rawJson": update.raw_json,
        });
        metadata["rid"] = webview.resources_table().add(update).into();
        metadata
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_only_newer_stable_releases_within_the_same_major() {
        for (current, next, expected) in [
            ("0.3.31", "0.4.0", true),
            ("0.3.31", "1.0.0", false),
            ("1.0.0", "0.9.9", false),
            ("1.0.0", "1.1.0", true),
            ("1.0.0", "2.0.0", false),
            ("1.0.0-rc.1", "1.0.0", true),
            ("0.9.0-rc.1", "1.0.0", false),
            ("1.0.0", "1.1.0-beta.1", false),
            ("1.0.0", "1.0.0", false),
            ("1.0.0", "1.0.0+build", false),
            ("1.0.1", "1.0.0", false),
        ] {
            assert_eq!(
                is_newer_release(
                    &Version::parse(current).unwrap(),
                    &Version::parse(next).unwrap()
                ),
                expected,
                "{current} -> {next}",
            );
        }
    }

    #[test]
    fn uses_the_fixed_manifest_for_the_installed_major() {
        for (version, major) in [("0.3.31", 0), ("1.0.0", 1), ("1.2.0-rc.1", 1), ("2.0.0", 2)] {
            assert_eq!(
                release_endpoint(&Version::parse(version).unwrap()).as_str(),
                format!(
                    "https://raw.githubusercontent.com/leowzz/axonkey/updates/v{major}/latest.json"
                ),
            );
        }
    }
}
