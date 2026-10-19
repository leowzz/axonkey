use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyComponents {
    pub interception: bool,
    pub interception_fix: bool,
}

#[derive(serde::Deserialize)]
struct StatusResponse {
    action: String,
    components: LegacyComponents,
}

fn parse_status(bytes: &[u8]) -> Result<LegacyComponents, String> {
    let response: StatusResponse = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid legacy driver status: {error}"))?;
    if response.action != "status" {
        return Err("Unexpected legacy driver helper response".into());
    }
    Ok(response.components)
}

/// Process-local result/checked flag. Reset on every application launch;
/// explicit rechecks replace the cached result, including a previous error.
#[derive(Default)]
pub(crate) struct LegacyProbeState(Mutex<Option<Result<LegacyComponents, String>>>);

impl LegacyProbeState {
    pub fn check(
        &self,
        refresh: bool,
        probe: impl FnOnce() -> Result<LegacyComponents, String>,
    ) -> Result<LegacyComponents, String> {
        let mut cached = self
            .0
            .lock()
            .map_err(|_| "Legacy driver status lock poisoned")?;
        if refresh || cached.is_none() {
            *cached = Some(probe());
        }
        cached.as_ref().unwrap().clone()
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn probe(resource_dir: &std::path::Path) -> Result<LegacyComponents, String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let helper = crate::find_driver_helper("legacy", "status", resource_dir)?;
    let output = Command::new(helper)
        .arg("--status")
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("Cannot launch the legacy driver status helper: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Legacy driver status helper failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_status(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_requires_both_driver_results_and_the_status_action() {
        let result = parse_status(
            br#"{"action":"status","components":{"interception":false,"interceptionFix":true}}"#,
        )
        .unwrap();
        assert!(!result.interception);
        assert!(result.interception_fix);
        assert!(
            parse_status(br#"{"action":"status","components":{"interception":false}}"#).is_err()
        );
        assert!(parse_status(
            br#"{"action":"cleanup","components":{"interception":false,"interceptionFix":false}}"#
        )
        .is_err());
        assert!(parse_status(b"not JSON").is_err());
    }

    #[test]
    fn checks_once_per_launch_and_refreshes_after_cleanup() {
        let state = LegacyProbeState::default();
        let present = LegacyComponents {
            interception: false,
            interception_fix: true,
        };
        let clear = LegacyComponents {
            interception: false,
            interception_fix: false,
        };
        assert_eq!(
            state.check(false, || Ok(present.clone())),
            Ok(present.clone())
        );
        assert_eq!(
            state.check(false, || panic!("must use startup result")),
            Ok(present)
        );
        assert_eq!(state.check(true, || Ok(clear.clone())), Ok(clear.clone()));
        assert_eq!(
            state.check(false, || panic!("must use refreshed result")),
            Ok(clear)
        );
        let next_launch = LegacyProbeState::default();
        assert_eq!(
            next_launch.check(false, || Err("new launch".into())),
            Err("new launch".into())
        );
    }

    #[test]
    fn a_failed_check_is_not_reported_as_clear_or_retried_by_polling() {
        let state = LegacyProbeState::default();
        assert!(state.check(false, || Err("access denied".into())).is_err());
        assert!(state
            .check(false, || panic!("must wait for explicit recheck"))
            .is_err());
        assert!(state
            .check(true, || Ok(LegacyComponents {
                interception: false,
                interception_fix: false,
            }))
            .is_ok());
    }
}
