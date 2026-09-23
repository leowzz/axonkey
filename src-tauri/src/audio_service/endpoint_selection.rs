//! Endpoint identity and routing policy, independent of Windows and audio I/O.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioEndpoint {
    pub id: String,
    pub name: String,
    pub direction: String,
    pub state: String,
    pub adapter_id: String,
    pub hardware_ids: Vec<String>,
    pub service: String,
    pub channels: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EndpointBinding {
    pub schema_version: u32,
    pub render_endpoint_id: String,
    pub capture_endpoint_id: Option<String>,
    pub adapter_instance_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EndpointSelectionError {
    pub state: String,
    pub error: String,
}

impl EndpointSelectionError {
    fn new(state: &str, error: impl Into<String>) -> Self {
        Self {
            state: state.into(),
            error: error.into(),
        }
    }
}

// These are PnP hardware/service identities, never user-visible endpoint names.
// Additional driver families need separately verified identities before support.
pub fn is_supported_adapter(hardware_ids: &[String], service: &str) -> bool {
    hardware_ids
        .iter()
        .any(|id| id.eq_ignore_ascii_case("VBAudioVACWDM"))
        && service.eq_ignore_ascii_case("VBAudioVACMME")
}

fn supported(endpoint: &AudioEndpoint) -> bool {
    !endpoint.id.is_empty()
        && !endpoint.adapter_id.is_empty()
        && is_supported_adapter(&endpoint.hardware_ids, &endpoint.service)
}

/// Validate user-supplied/persisted IDs against fresh native metadata. A saved
/// capture endpoint describes an association, not proof of a working loopback.
pub fn validate_binding(
    endpoints: &[AudioEndpoint],
    binding: &EndpointBinding,
) -> Result<(), EndpointSelectionError> {
    if binding.schema_version != 1 || binding.adapter_instance_id.is_empty() {
        return Err(EndpointSelectionError::new(
            "selectionRequired",
            "已保存的音频设备配置无效，请重新选择。",
        ));
    }
    let belongs_to_binding = |endpoint: &&AudioEndpoint| {
        supported(endpoint)
            && endpoint
                .adapter_id
                .eq_ignore_ascii_case(&binding.adapter_instance_id)
    };
    if !endpoints
        .iter()
        .filter(belongs_to_binding)
        .any(|endpoint| endpoint.id == binding.render_endpoint_id && endpoint.direction == "render")
    {
        return Err(EndpointSelectionError::new(
            "endpointUnavailable",
            "已选择的播放设备不可用，请等待设备恢复或重新选择。",
        ));
    }
    if let Some(capture_id) = &binding.capture_endpoint_id {
        if !endpoints
            .iter()
            .filter(belongs_to_binding)
            .any(|endpoint| endpoint.id == *capture_id && endpoint.direction == "capture")
        {
            return Err(EndpointSelectionError::new(
                "endpointUnavailable",
                "已选择的录音设备不可用或不属于同一适配器，请重新选择。",
            ));
        }
    }
    Ok(())
}

pub fn select_render_endpoint(
    endpoints: &[AudioEndpoint],
    binding: Option<&EndpointBinding>,
) -> Result<AudioEndpoint, EndpointSelectionError> {
    let endpoint = if let Some(binding) = binding {
        validate_binding(endpoints, binding)?;
        endpoints
            .iter()
            .find(|endpoint| {
                endpoint.id == binding.render_endpoint_id
                    && endpoint.direction == "render"
                    && supported(endpoint)
                    && endpoint
                        .adapter_id
                        .eq_ignore_ascii_case(&binding.adapter_instance_id)
            })
            .ok_or_else(|| {
                EndpointSelectionError::new("endpointUnavailable", "已选择的播放设备不可用。")
            })?
    } else {
        // Count every state: a disabled second port is still ambiguous, and
        // enabling it later must not silently change the user's audio route.
        let candidates: Vec<_> = endpoints
            .iter()
            .filter(|endpoint| endpoint.direction == "render" && supported(endpoint))
            .collect();
        match candidates.as_slice() {
            [] if endpoints.iter().any(supported) => {
                return Err(EndpointSelectionError::new(
                    "endpointUnavailable",
                    "已发现虚拟音频适配器，但没有可用的播放端点。",
                ))
            }
            [] => {
                return Err(EndpointSelectionError::new(
                    "adapterMissing",
                    "未发现受支持的 VB-CABLE 音频设备。",
                ))
            }
            [endpoint] => *endpoint,
            _ => {
                return Err(EndpointSelectionError::new(
                    "selectionRequired",
                    "发现多个语音输出端点，请选择要使用的设备。",
                ))
            }
        }
    };
    match endpoint.state.as_str() {
        "active" => Ok(endpoint.clone()),
        "disabled" => Err(EndpointSelectionError::new(
            "endpointDisabled",
            "已选择的播放设备被禁用，请在 Windows 声音设置中启用。",
        )),
        _ => Err(EndpointSelectionError::new(
            "endpointUnavailable",
            "已选择的播放设备已断开或不可用，请等待恢复或重新选择。",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(id: &str, adapter: &str, direction: &str) -> AudioEndpoint {
        AudioEndpoint {
            id: id.into(),
            name: "CABLE Input".into(),
            direction: direction.into(),
            state: "active".into(),
            adapter_id: adapter.into(),
            hardware_ids: vec!["VBAudioVACWDM".into()],
            service: "VBAudioVACMME".into(),
            channels: Some(2),
        }
    }
    fn binding(id: &str, adapter: &str) -> EndpointBinding {
        EndpointBinding {
            schema_version: 1,
            render_endpoint_id: id.into(),
            capture_endpoint_id: None,
            adapter_instance_id: adapter.into(),
        }
    }
    fn error_state(endpoints: &[AudioEndpoint], binding: Option<&EndpointBinding>) -> String {
        select_render_endpoint(endpoints, binding)
            .unwrap_err()
            .state
    }

    #[test]
    fn renamed_endpoint_is_discovered_by_identity() {
        let mut candidate = endpoint("render-1", "adapter-1", "render");
        candidate.name = "扬声器".into();
        assert_eq!(
            select_render_endpoint(&[candidate.clone()], None).unwrap(),
            candidate
        );
        candidate.name = "任意名称".into();
        assert_eq!(
            select_render_endpoint(
                &[candidate.clone()],
                Some(&binding("render-1", "adapter-1"))
            )
            .unwrap(),
            candidate
        );
    }
    #[test]
    fn duplicate_names_and_enumeration_order_do_not_change_binding() {
        let first = endpoint("render-1", "adapter-1", "render");
        let second = endpoint("render-2", "adapter-1", "render");
        let saved = binding("render-2", "adapter-1");
        for endpoints in [
            vec![first.clone(), second.clone()],
            vec![second.clone(), first.clone()],
        ] {
            assert_eq!(
                select_render_endpoint(&endpoints, Some(&saved)).unwrap().id,
                "render-2"
            );
            assert_eq!(error_state(&endpoints, None), "selectionRequired");
        }
    }
    #[test]
    fn multiple_instances_require_selection_and_never_replace_a_missing_binding() {
        let first = endpoint("render-1", "adapter-1", "render");
        let second = endpoint("render-2", "adapter-2", "render");
        assert_eq!(
            error_state(&[first, second.clone()], None),
            "selectionRequired"
        );
        assert_eq!(
            error_state(&[second], Some(&binding("render-1", "adapter-1"))),
            "endpointUnavailable"
        );
    }
    #[test]
    fn capture_endpoints_are_never_playback_candidates() {
        let capture = endpoint("capture-1", "adapter-1", "capture");
        assert_eq!(error_state(&[capture.clone()], None), "endpointUnavailable");
        assert_eq!(
            error_state(&[capture], Some(&binding("capture-1", "adapter-1"))),
            "endpointUnavailable"
        );
    }
    #[test]
    fn selected_capture_must_exist_and_belong_to_the_same_adapter() {
        let render = endpoint("render-1", "adapter-1", "render");
        let mut saved = binding("render-1", "adapter-1");
        saved.capture_endpoint_id = Some("capture-1".into());
        let capture = endpoint("capture-1", "adapter-1", "capture");
        assert!(validate_binding(&[render.clone(), capture], &saved).is_ok());
        for invalid in [
            endpoint("capture-1", "adapter-2", "capture"),
            endpoint("capture-1", "adapter-1", "render"),
        ] {
            assert!(validate_binding(&[render.clone(), invalid], &saved).is_err());
        }
        assert!(validate_binding(&[render], &saved).is_err());
    }
    #[test]
    fn disabled_and_disconnected_endpoints_are_not_driver_missing() {
        let mut candidate = endpoint("render-1", "adapter-1", "render");
        for (state, expected) in [
            ("disabled", "endpointDisabled"),
            ("unplugged", "endpointUnavailable"),
            ("notPresent", "endpointUnavailable"),
        ] {
            candidate.state = state.into();
            assert_eq!(error_state(&[candidate.clone()], None), expected);
            assert_eq!(
                error_state(
                    &[candidate.clone()],
                    Some(&binding("render-1", "adapter-1"))
                ),
                expected
            );
        }
    }
    #[test]
    fn a_disabled_alternative_still_requires_explicit_selection() {
        let first = endpoint("render-1", "adapter-1", "render");
        let mut second = endpoint("render-2", "adapter-1", "render");
        second.state = "disabled".into();
        assert_eq!(error_state(&[first, second], None), "selectionRequired");
    }
    #[test]
    fn a_speaker_named_cable_input_is_not_a_candidate() {
        let mut impostor = endpoint("speaker", "speaker-adapter", "render");
        impostor.hardware_ids = vec!["HDAUDIO\\REALTEK".into()];
        impostor.service = "Realtek".into();
        assert_eq!(error_state(&[impostor.clone()], None), "adapterMissing");
        assert_eq!(
            error_state(&[impostor], Some(&binding("speaker", "speaker-adapter"))),
            "endpointUnavailable"
        );
    }
    #[test]
    fn both_driver_identity_fields_and_saved_adapter_must_match() {
        let mut candidate = endpoint("render-1", "adapter-1", "render");
        assert_eq!(
            error_state(
                &[candidate.clone()],
                Some(&binding("render-1", "adapter-2"))
            ),
            "endpointUnavailable"
        );
        candidate.service = "unverified-driver".into();
        assert_eq!(error_state(&[candidate], None), "adapterMissing");
        assert!(is_supported_adapter(
            &["vbaudiovacwdm".into()],
            "VBAUDIOVACMME"
        ));
    }
    #[test]
    fn raw_endpoint_id_is_opaque_and_schema_is_validated() {
        let candidate = endpoint("RAW-Endpoint-ID", "adapter-1", "render");
        assert_eq!(
            error_state(
                &[candidate.clone()],
                Some(&binding("raw-endpoint-id", "adapter-1"))
            ),
            "endpointUnavailable"
        );
        let mut saved = binding("RAW-Endpoint-ID", "adapter-1");
        saved.schema_version = 2;
        assert_eq!(error_state(&[candidate], Some(&saved)), "selectionRequired");
    }
}
