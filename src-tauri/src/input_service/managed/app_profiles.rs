use super::Instance;
use crate::foreground::Application;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationProfile {
    pub application: Application,
    pub profile_id: String,
}

pub(super) fn effective_instance<'a>(
    instance: &'a Instance,
    app_id: Option<&str>,
) -> Cow<'a, Instance> {
    if let Some(index) = application_binding(instance, app_id) {
        let profile_id = &instance.application_profiles[index].profile_id;
        if profile_id != &instance.active_profile_id {
            let mut effective = instance.clone();
            effective.active_profile_id = profile_id.clone();
            return Cow::Owned(effective);
        }
    }
    Cow::Borrowed(instance)
}

pub(super) fn application_binding(instance: &Instance, app_id: Option<&str>) -> Option<usize> {
    if !instance.app_profile_switching {
        return None;
    }
    instance
        .application_profiles
        .iter()
        .position(|binding| Some(binding.application.id.as_str()) == app_id)
}

pub(super) fn validate(instance: &Instance) -> Result<(), String> {
    if instance.application_profiles.len() > 128 {
        return Err("每台设备最多关联 128 个应用".into());
    }
    let mut ids = std::collections::HashSet::new();
    for binding in &instance.application_profiles {
        let app = &binding.application;
        if app.id.is_empty()
            || app.id.len() > 4096
            || app.name.trim().is_empty()
            || app.name.len() > 200
            || app.path.is_empty()
            || app.path.len() > 32768
            || !ids.insert(&app.id)
            || !instance
                .profiles
                .iter()
                .any(|profile| profile.id == binding.profile_id)
        {
            return Err("应用关联的配置文件或应用信息无效".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_profiles_are_per_device_and_do_not_replace_global_selection() {
        let mut first = super::super::tests::instance("first", "one");
        first.profiles.push(super::super::Profile {
            id: "browser".into(),
            name: "浏览器".into(),
            behaviors: serde_json::json!({"xbox.a": {"click": [{"type": "key", "key": "A"}]}}),
        });
        first.application_profiles.push(ApplicationProfile {
            application: Application {
                id: "chrome".into(),
                name: "Chrome".into(),
                path: "/Chrome.app".into(),
            },
            profile_id: "browser".into(),
        });
        first.app_profile_switching = true;
        let second = super::super::tests::instance("second", "two");
        assert_eq!(
            effective_instance(&first, Some("chrome")).active_profile_id,
            "browser"
        );
        assert_eq!(
            effective_instance(&second, Some("chrome")).active_profile_id,
            "default"
        );
        assert_eq!(
            effective_instance(&first, Some("other")).active_profile_id,
            "default"
        );
        assert_eq!(
            effective_instance(&first, None).active_profile_id,
            "default"
        );
        assert_eq!(first.active_profile_id, "default");
        assert!(
            super::super::active_mappings(&effective_instance(&first, Some("chrome")))
                .contains_key("xbox.a")
        );
        assert!(
            super::super::active_mappings(&effective_instance(&first, Some("other"))).is_empty()
        );
        first.app_profile_switching = false;
        assert_eq!(
            effective_instance(&first, Some("chrome")).active_profile_id,
            "default"
        );
        first.application_profiles[0].profile_id = "missing".into();
        assert!(validate(&first).is_err());
    }
}
