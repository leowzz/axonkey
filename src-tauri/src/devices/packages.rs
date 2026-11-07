//! Shared local device declarations. Native protocol implementations remain adapters.
use serde::Deserialize;
use std::{collections::HashSet, sync::OnceLock};

const BUILTIN: &str = include_str!("../../../device-packages/builtin.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Hardware {
    pub id: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub usage_page: u16,
    pub usage: u16,
    pub initial_package_id: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub software_fallback_package_id: Option<String>,
    pub hid_platforms: Vec<String>,
    pub windows: WindowsMatch,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsMatch {
    prefixes: Vec<String>,
    vid_tokens: Vec<String>,
    require_hid_service: bool,
    include_hardware_id: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Package {
    pub id: String,
    pub version: u32,
    pub adapter: String,
    pub hardware_id: String,
    pub name: String,
    pub model: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub software_marker: Option<String>,
    pub capabilities: Capabilities,
    pub presentation: serde_json::Value,
    pub inputs: Vec<Input>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    #[serde(deserialize_with = "Option::deserialize")]
    pub voice: Option<String>,
    pub recording_modes: Vec<String>,
    pub default_recording_mode: String,
}
#[derive(Deserialize)]
pub(crate) struct Input {
    pub id: String,
    label: String,
    icon: String,
    short: Option<String>,
    side: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Registry {
    schema_version: u32,
    pub hardware: Vec<Hardware>,
    pub packages: Vec<Package>,
}

pub(crate) fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Registry::load(BUILTIN).expect("invalid bundled device catalog"))
}

impl Registry {
    pub fn load(json: &str) -> Result<Self, String> {
        let result: Self =
            serde_json::from_str(json).map_err(|e| format!("设备支持包无法读取：{e}"))?;
        result.validate()?;
        Ok(result)
    }

    pub fn get(&self, id: &str) -> Option<&Package> {
        self.packages.iter().find(|pkg| pkg.id == id)
    }

    pub fn hardware_for(&self, id: &str) -> Option<&Hardware> {
        let pkg = self.get(id)?;
        self.hardware.iter().find(|hw| hw.id == pkg.hardware_id)
    }

    pub fn paired_kind(&self, vendor: u16, product: u16) -> Option<&str> {
        self.hardware
            .iter()
            .find(|hw| hw.vendor_id == vendor && hw.product_id == product)
            .map(|hw| hw.initial_package_id.as_str())
    }

    pub fn hid_kind(
        &self,
        vendor: u16,
        product: u16,
        page: u16,
        usage: u16,
        platform: &str,
    ) -> Option<&str> {
        self.hardware
            .iter()
            .find(|hw| {
                hw.vendor_id == vendor
                    && hw.product_id == product
                    && hw.usage_page == page
                    && hw.usage == usage
                    && hw.hid_platforms.iter().any(|p| p == platform)
            })
            .map(|hw| hw.initial_package_id.as_str())
    }

    pub fn software_kind(&self, kind: &str, software: Option<&str>) -> Option<&str> {
        let hardware = self.hardware_for(kind)?;
        let fallback = hardware.software_fallback_package_id.as_deref()?;
        Some(
            self.packages
                .iter()
                .find(|pkg| {
                    pkg.hardware_id == hardware.id
                        && pkg
                            .software_marker
                            .as_ref()
                            .is_some_and(|marker| software.is_some_and(|v| v.contains(marker)))
                })
                .map_or(fallback, |pkg| pkg.id.as_str()),
        )
    }

    pub fn matches_windows(&self, kind: &str, instance_id: &str, hardware_id: &str) -> bool {
        let Some(hw) = self.hardware_for(kind) else {
            return false;
        };
        let id = instance_id.to_ascii_uppercase();
        if !hw
            .windows
            .prefixes
            .iter()
            .any(|prefix| id.starts_with(prefix))
            || (hw.windows.require_hid_service
                && super::shared::bluetooth_hid_service(&id).is_none())
        {
            return false;
        }
        self.matches_windows_hardware(
            hw,
            &id,
            if hw.windows.include_hardware_id {
                hardware_id
            } else {
                ""
            },
        )
    }

    pub fn matches_windows_hardware(
        &self,
        hw: &Hardware,
        instance_id: &str,
        hardware_id: &str,
    ) -> bool {
        let text = format!(
            "{} {}",
            instance_id.to_ascii_uppercase(),
            hardware_id.to_ascii_uppercase()
        );
        let tokens: Vec<_> = text.split(['&', '_', '\\', ' ']).collect();
        let pid = format!("{:04X}", hw.product_id);
        tokens.windows(2).any(|pair| {
            pair[0] == "VID" && hw.windows.vid_tokens.iter().any(|token| token == pair[1])
        }) && tokens
            .windows(2)
            .any(|pair| pair[0] == "PID" && pair[1] == pid)
    }

    fn validate(&self) -> Result<(), String> {
        ensure(self.schema_version == 1, "不支持的 schemaVersion")?;
        unique(self.hardware.iter().map(|hw| hw.id.as_str()), "hardware")?;
        unique(self.packages.iter().map(|pkg| pkg.id.as_str()), "packages")?;
        let mut matches = HashSet::new();
        for hw in &self.hardware {
            ensure(
                matches.insert((hw.vendor_id, hw.product_id)),
                "硬件匹配重复",
            )?;
            self.validate_hardware(hw)?;
        }
        for pkg in &self.packages {
            self.validate_package(pkg)?;
        }
        Ok(())
    }

    fn validate_hardware(&self, hw: &Hardware) -> Result<(), String> {
        for id in
            std::iter::once(&hw.initial_package_id).chain(hw.software_fallback_package_id.iter())
        {
            ensure(
                self.get(id).is_some_and(|pkg| pkg.hardware_id == hw.id),
                "型号引用不属于该硬件",
            )?;
        }
        ensure(
            hw.hid_platforms
                .iter()
                .all(|p| matches!(p.as_str(), "windows" | "macos" | "linux")),
            "hidPlatforms",
        )?;
        ensure(
            !hw.windows.prefixes.is_empty()
                && hw.windows.prefixes.iter().all(|p| !p.trim().is_empty()),
            "Windows 前缀",
        )?;
        ensure(
            !hw.windows.vid_tokens.is_empty()
                && hw.windows.vid_tokens.iter().all(|p| {
                    !p.is_empty()
                        && p.bytes()
                            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
                }),
            "Windows VID",
        )?;
        let mut markers = HashSet::new();
        for marker in self
            .packages
            .iter()
            .filter(|pkg| pkg.hardware_id == hw.id)
            .filter_map(|pkg| pkg.software_marker.as_deref())
        {
            ensure(
                !marker.trim().is_empty() && markers.insert(marker),
                "软件识别标记重复或为空",
            )?;
        }
        Ok(())
    }

    fn validate_package(&self, pkg: &Package) -> Result<(), String> {
        ensure(
            matches!(
                pkg.adapter.as_str(),
                "rc003" | "cmiotA15" | "xmBt29" | "rc313" | "obeRcuR5" | "xboxBluetooth"
            ),
            "未安装的原生适配器",
        )?;
        ensure(pkg.version > 0 && pkg.version <= i32::MAX as u32, "version")?;
        ensure(
            [&pkg.adapter, &pkg.name, &pkg.model]
                .iter()
                .all(|s| !s.trim().is_empty()),
            "adapter/name/model",
        )?;
        ensure(self.hardware_for(&pkg.id).is_some(), "未知硬件引用")?;
        ensure(
            pkg.capabilities
                .voice
                .as_deref()
                .is_none_or(|v| matches!(v, "rc003-atvv" | "a15-g7221" | "obe-sbc")),
            "voice",
        )?;
        ensure(
            pkg.capabilities
                .recording_modes
                .iter()
                .all(|m| matches!(m.as_str(), "hold" | "click"))
                && matches!(
                    pkg.capabilities.default_recording_mode.as_str(),
                    "hold" | "click"
                ),
            "recordingModes",
        )?;
        unique(pkg.inputs.iter().map(|input| input.id.as_str()), "inputs")?;
        for input in &pkg.inputs {
            ensure(
                !input.label.trim().is_empty()
                    && matches!(
                        input.icon.as_str(),
                        "power"
                            | "locate"
                            | "mic"
                            | "up"
                            | "left"
                            | "center"
                            | "right"
                            | "down"
                            | "back"
                            | "volumeUp"
                            | "volumeDown"
                            | "home"
                            | "menu"
                            | "tv"
                            | "mute"
                            | "settings"
                            | "m"
                            | "number"
                            | "delete"
                    ),
                "input label/icon",
            )?;
        }
        validate_presentation(pkg)
    }
}

fn ensure(valid: bool, message: &str) -> Result<(), String> {
    if valid {
        Ok(())
    } else {
        Err(format!("设备支持包无效：{message}"))
    }
}
fn unique<'a>(ids: impl Iterator<Item = &'a str>, name: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for id in ids {
        ensure(
            !id.trim().is_empty() && seen.insert(id),
            &format!("{name}: ID 重复或为空"),
        )?;
    }
    ensure(!seen.is_empty(), name)
}
fn validate_presentation(pkg: &Package) -> Result<(), String> {
    let view = &pkg.presentation;
    ensure(
        view["artwork"]
            .as_str()
            .is_some_and(|s| s.starts_with('/') && !s.starts_with("//") && !s.contains("..")),
        "本地图片地址",
    )?;
    match view["renderer"].as_str() {
        Some("xbox") => Ok(()),
        Some("remote") => {
            ensure(
                view["ariaLabel"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty()),
                "ariaLabel",
            )?;
            for dimension in ["width", "height"] {
                ensure(
                    view["viewBox"][dimension]
                        .as_f64()
                        .is_some_and(|v| v.is_finite() && v > 0.),
                    "viewBox",
                )?;
            }
            ensure(
                view["keyRegions"]
                    .as_object()
                    .is_some_and(|r| r.len() == pkg.inputs.len()),
                "区域与输入数量不一致",
            )?;
            for input in &pkg.inputs {
                ensure(
                    input.short.as_ref().is_some_and(|s| !s.trim().is_empty())
                        && matches!(input.side.as_deref(), Some("left" | "right"))
                        && input.x.is_some_and(f64::is_finite)
                        && input.y.is_some_and(f64::is_finite),
                    "input short/side/x/y",
                )?;
                let region = &view["keyRegions"][&input.id];
                ensure(
                    region["path"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty()),
                    "缺少区域 path",
                )?;
                for axis in ["x", "y"] {
                    ensure(
                        region["anchor"][axis].as_f64().is_some_and(f64::is_finite),
                        "anchor",
                    )?;
                }
            }
            Ok(())
        }
        _ => Err("设备支持包无效：renderer".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_invalid_catalog_fixtures_are_rejected() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/device-catalog-invalid.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let mut catalog: serde_json::Value = serde_json::from_str(BUILTIN).unwrap();
            let path = case["path"].as_array().unwrap();
            let mut parent = &mut catalog;
            for part in &path[..path.len() - 1] {
                parent = if let Some(index) = part.as_u64() {
                    &mut parent[index as usize]
                } else {
                    &mut parent[part.as_str().unwrap()]
                };
            }
            let key = path.last().unwrap().as_str().unwrap();
            if case["remove"] == true {
                parent.as_object_mut().unwrap().remove(key);
            } else {
                parent[key] = case["value"].clone();
            }
            assert!(
                Registry::load(&catalog.to_string()).is_err(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn catalog_matches_hardware_and_software_without_changing_platform_support() {
        let registry = registry();
        assert_eq!(registry.packages.len(), 6);
        assert_eq!(registry.paired_kind(0x0416, 0x0300), Some("cmiotA15"));
        assert_eq!(registry.hid_kind(0x0416, 0x0300, 1, 6, "windows"), None);
        assert_eq!(
            registry.hid_kind(0x0416, 0x0300, 1, 6, "macos"),
            Some("cmiotA15")
        );
        assert_eq!(
            registry.hid_kind(0x045e, 0x02e0, 1, 5, "windows"),
            Some("xboxBluetooth")
        );
        assert_eq!(registry.hid_kind(0x045e, 0x02e0, 1, 6, "windows"), None);
        assert_eq!(
            registry.software_kind("cmiotA15", Some("XFRSD0D_M_R01_761_debug")),
            Some("xmBt29")
        );
        assert_eq!(registry.software_kind("xmBt29", None), Some("rc313"));
        assert_eq!(
            registry.software_kind("cmiotA15", Some("unknown")),
            Some("rc313")
        );
        assert_eq!(registry.paired_kind(0x0416, 0x0301), None);
    }

    #[test]
    fn declarations_cover_exactly_the_native_adapters_inputs() {
        use crate::devices::{cmiot_a15, obe_rcu_r5, rc_313, xbox, xiaomi_remote, xm_bt_29};
        let registry = registry();
        for (id, buttons) in [
            ("cmiotA15", cmiot_a15::BUTTONS),
            ("xmBt29", xm_bt_29::BUTTONS),
            ("rc313", rc_313::BUTTONS),
            ("obeRcuR5", obe_rcu_r5::BUTTONS),
        ] {
            let declared: HashSet<_> = registry
                .get(id)
                .unwrap()
                .inputs
                .iter()
                .map(|i| i.id.as_str())
                .collect();
            let decoded: HashSet<_> = buttons.iter().map(|b| b.2).collect();
            assert_eq!(declared, decoded, "{id}");
        }
        let rc003 = xiaomi_remote::input::decode(&[1, 0, 0, 0, 0, 0, 0]).unwrap();
        assert_eq!(
            registry
                .get("rc003")
                .unwrap()
                .inputs
                .iter()
                .map(|i| i.id.as_str())
                .collect::<HashSet<_>>(),
            rc003.keys().map(String::as_str).collect()
        );
        let mut report = [0; 16];
        report[0] = 1;
        let mut controller = xbox::decode(&report).unwrap();
        controller.extend(xbox::decode(&[2, 0]).unwrap());
        assert_eq!(
            registry
                .get("xboxBluetooth")
                .unwrap()
                .inputs
                .iter()
                .map(|i| i.id.as_str())
                .collect::<HashSet<_>>(),
            controller.keys().copied().collect()
        );
    }

    #[test]
    fn local_registry_resolves_package_ids_independently_of_adapter_names() {
        let mut catalog: serde_json::Value = serde_json::from_str(BUILTIN).unwrap();
        catalog["packages"][1]["id"] = "lab.rc003".into();
        catalog["hardware"][1]["initialPackageId"] = "lab.rc003".into();
        let registry = Registry::load(&catalog.to_string()).unwrap();
        assert_eq!(registry.get("lab.rc003").unwrap().adapter, "rc003");
        assert_eq!(registry.paired_kind(0x2717, 0x32b8), Some("lab.rc003"));
        assert!(registry.get("rc003").is_none());
    }
}
