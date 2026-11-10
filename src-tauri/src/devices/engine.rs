use super::device_descriptor::{
    DeviceDescriptor, ReportDescriptor, ReportEncoding, SourceDescriptor,
};
use std::collections::BTreeMap;

/// Decode one descriptor-defined report into values keyed by stable input ID.
///
/// Only inputs that reference the report selected from `bytes` are returned;
/// unrelated report groups keep their state in `DescriptorEngine`.
pub(crate) fn decode_descriptor(
    descriptor: &DeviceDescriptor,
    bytes: &[u8],
) -> Option<BTreeMap<String, f64>> {
    let report = matching_report(descriptor, bytes)?;
    decode_inputs(descriptor, report, bytes)
}

fn decode_inputs(
    descriptor: &DeviceDescriptor,
    report: &ReportDescriptor,
    bytes: &[u8],
) -> Option<BTreeMap<String, f64>> {
    let values = decode_report_values(report, bytes)?;
    let mut decoded = BTreeMap::new();
    for input in &descriptor.inputs {
        let sources = input
            .sources
            .iter()
            .filter(|source| source.report == report.id)
            .collect::<Vec<_>>();
        if sources.is_empty() {
            continue;
        }
        let mut value = 0.0_f64;
        for source in sources {
            let source_value = source_value(source, report, &values, bytes)?;
            value = value.max(source_value);
        }
        decoded.insert(input.id.clone(), value);
    }
    Some(decoded)
}

/// Apply a stable input's enter/release thresholds to a normalized value.
/// Button sources use the same defaults as the existing managed reader.
pub(crate) fn pressed(
    descriptor: &DeviceDescriptor,
    key: &str,
    value: f64,
    was_pressed: bool,
) -> bool {
    let input = descriptor.inputs.iter().find(|input| input.id == key);
    let (press, release) = input
        .and_then(|input| {
            input.sources.iter().find_map(|source| {
                let press = source
                    .attributes
                    .get("threshold")
                    .and_then(|value| value.parse::<f64>().ok());
                let release = source
                    .attributes
                    .get("release-threshold")
                    .and_then(|value| value.parse::<f64>().ok());
                (press.is_some() || release.is_some()).then_some((press, release))
            })
        })
        .unwrap_or((None, None));
    let threshold = press.unwrap_or(0.55).clamp(0.0, 1.0);
    let release_threshold = release.unwrap_or(0.35).clamp(0.0, threshold);
    value
        >= if was_pressed {
            release_threshold
        } else {
            threshold
        }
}

/// Stateful wrapper that turns descriptor values into stable-key edges.
#[derive(Debug, Default)]
pub(crate) struct DescriptorEngine {
    values_by_report: BTreeMap<String, BTreeMap<String, f64>>,
    active: BTreeMap<String, bool>,
    values: BTreeMap<String, f64>,
    dirty: bool,
}

impl DescriptorEngine {
    pub(crate) fn accept(
        &mut self,
        descriptor: &DeviceDescriptor,
        bytes: &[u8],
    ) -> Vec<(String, bool)> {
        let Some(report) = matching_report(descriptor, bytes) else {
            return Vec::new();
        };
        let Some(values) = decode_inputs(descriptor, report, bytes) else {
            return Vec::new();
        };
        let report_id = report
            .attributes
            .get("state-group")
            .unwrap_or(&report.id)
            .clone();
        let mut affected = values.keys().cloned().collect::<Vec<_>>();
        if let Some(previous) = self.values_by_report.insert(report_id, values) {
            affected.extend(previous.into_keys());
            affected.sort();
            affected.dedup();
        }
        let mut edges = Vec::new();
        for key in affected {
            let value = self
                .values_by_report
                .values()
                .filter_map(|group| group.get(&key))
                .copied()
                .fold(0.0_f64, f64::max);
            let was_pressed = self.active.get(&key).copied().unwrap_or(false);
            let pressed = pressed(descriptor, &key, value, was_pressed);
            self.dirty |= self
                .values
                .get(&key)
                .is_none_or(|old| (old - value).abs() > 0.005);
            self.values.insert(key.clone(), value);
            if was_pressed != pressed {
                self.dirty = true;
                self.active.insert(key.clone(), pressed);
                edges.push((key, pressed));
            }
        }
        edges
    }

    pub(crate) fn release_all(&mut self) -> Vec<(String, bool)> {
        self.release_except(&[])
    }

    pub(crate) fn release_except(&mut self, preserved: &[&str]) -> Vec<(String, bool)> {
        let mut edges = Vec::new();
        for (key, pressed) in &mut self.active {
            if *pressed && !preserved.contains(&key.as_str()) {
                edges.push((key.clone(), false));
                *pressed = false;
            }
        }
        self.dirty |= !edges.is_empty();
        for (key, value) in &mut self.values {
            if !preserved.contains(&key.as_str()) {
                self.dirty |= *value != 0.0;
                *value = 0.0;
            }
        }
        self.active.retain(|_, pressed| *pressed);
        for group in self.values_by_report.values_mut() {
            group.retain(|key, _| preserved.contains(&key.as_str()));
        }
        self.values_by_report.retain(|_, group| !group.is_empty());
        edges
    }

    pub(crate) fn take_update(&mut self) -> Option<(BTreeMap<String, f64>, Vec<String>)> {
        std::mem::take(&mut self.dirty).then(|| {
            (
                self.values.clone(),
                self.active
                    .iter()
                    .filter_map(|(key, pressed)| pressed.then(|| key.clone()))
                    .collect(),
            )
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReportValues {
    usages: Vec<(u16, u16)>,
    state: Option<u16>,
}

fn matching_report<'a>(
    descriptor: &'a DeviceDescriptor,
    bytes: &[u8],
) -> Option<&'a ReportDescriptor> {
    let mut matches = descriptor
        .reports
        .values()
        .filter(|report| matches_report(report, bytes));
    let report = matches.next()?;
    matches.next().is_none().then_some(report)
}

fn matches_report(report: &ReportDescriptor, bytes: &[u8]) -> bool {
    if report.direction != "input"
        // GATT streams are opaque application data. They are intentionally
        // left to their registered decoder and never become key reports.
        || report.encoding == ReportEncoding::GattStream
    {
        return false;
    }
    report.length.is_none_or(|length| length == bytes.len())
        && report
            .report_id
            .is_none_or(|report_id| bytes.first() == Some(&report_id))
        && report
            .attributes
            .get("prefix")
            .is_none_or(|prefix| matches_prefix(prefix, bytes))
        && report
            .attributes
            .get("prefix-not")
            .is_none_or(|prefix| !matches_prefix(prefix, bytes))
}

fn matches_prefix(prefix: &str, bytes: &[u8]) -> bool {
    prefix
        .split_whitespace()
        .enumerate()
        .all(|(index, expected)| {
            bytes.get(index).copied()
                == parse_u16(expected).and_then(|value| u8::try_from(value).ok())
        })
}

fn decode_report_values(report: &ReportDescriptor, bytes: &[u8]) -> Option<ReportValues> {
    let payload_offset = report
        .attributes
        .get("payload-offset")
        .and_then(|value| parse_integer(value))
        .unwrap_or_else(|| default_payload_offset(report));
    match report.encoding {
        ReportEncoding::LeU16Slots => {
            let slot_width = report
                .attributes
                .get("slot-width")
                .and_then(|value| parse_integer(value))
                .unwrap_or(2);
            let slot_count = report
                .attributes
                .get("slot-count")
                .and_then(|value| parse_integer(value))?;
            if slot_width != 2 {
                return None;
            }
            let end = payload_offset.checked_add(slot_width.checked_mul(slot_count)?)?;
            if end > bytes.len() {
                return None;
            }
            let page = report_page(report)?;
            let usages = bytes[payload_offset..end]
                .chunks_exact(2)
                .map(|pair| (page, u16::from_le_bytes([pair[0], pair[1]])))
                .filter(|(_, usage)| *usage != 0)
                .collect::<Vec<_>>();
            Some(ReportValues {
                usages,
                state: None,
            })
        }
        ReportEncoding::BootKeyboard => {
            let slot_count = report
                .attributes
                .get("slot-count")
                .and_then(|value| parse_integer(value))
                .unwrap_or(6);
            let end = payload_offset.checked_add(slot_count)?;
            if end > bytes.len() {
                return None;
            }
            // These devices use the payload as plain usage slots. Modifier
            // bytes in the slots indicate a malformed report, rather than a
            // key that should clear the current state.
            if bytes[payload_offset..end]
                .iter()
                .any(|usage| (1..=3).contains(usage))
            {
                return None;
            }
            let page = report_page(report)?;
            let usages = bytes[payload_offset..end]
                .iter()
                .copied()
                .filter(|usage| *usage != 0)
                .map(|usage| (page, u16::from(usage)))
                .collect();
            Some(ReportValues {
                usages,
                state: None,
            })
        }
        ReportEncoding::LeU16Single => {
            let end = payload_offset.checked_add(2)?;
            if end > bytes.len() {
                return None;
            }
            let page = report_page(report)?;
            Some(ReportValues {
                usages: vec![(
                    page,
                    u16::from_le_bytes([bytes[payload_offset], bytes[payload_offset + 1]]),
                )],
                state: None,
            })
        }
        ReportEncoding::VendorState => {
            let offset = report
                .attributes
                .get("state-offset")
                .or_else(|| report.attributes.get("payload-offset"))
                .and_then(|value| parse_integer(value))
                .unwrap_or(payload_offset);
            let state = u16::from(*bytes.get(offset)?);
            if report
                .attributes
                .get("state-max")
                .and_then(|value| parse_u16(value))
                .is_some_and(|max| state > max)
            {
                return None;
            }
            if let Some(offset) = report
                .attributes
                .get("zero-tail-offset")
                .and_then(|value| parse_integer(value))
            {
                if bytes.get(offset..)?.iter().any(|byte| *byte != 0) {
                    return None;
                }
            }
            Some(ReportValues {
                usages: Vec::new(),
                state: Some(state),
            })
        }
        // These encodings are source-defined fields. The source carries the
        // byte/bit layout, so report decoding only needs to validate the
        // report length/ID above.
        ReportEncoding::BitField | ReportEncoding::AxisU16 | ReportEncoding::Hat8 => {
            Some(ReportValues {
                usages: Vec::new(),
                state: None,
            })
        }
        ReportEncoding::GattStream => None,
    }
}

fn source_value(
    source: &SourceDescriptor,
    report: &ReportDescriptor,
    values: &ReportValues,
    bytes: &[u8],
) -> Option<f64> {
    if let (Some(page), Some(usage)) = (source.page, source.usage) {
        return Some(if values.usages.contains(&(page, usage)) {
            1.0
        } else {
            0.0
        });
    }
    if report.encoding == ReportEncoding::VendorState && source.field.as_deref() == Some("state") {
        let expected = source.equals.as_deref().and_then(parse_u16);
        return Some(if expected.is_some() && values.state == expected {
            1.0
        } else {
            0.0
        });
    }
    match source_encoding(source, report) {
        ReportEncoding::BitField => bit_field_value(source, bytes),
        ReportEncoding::AxisU16 => axis_value(source, report, bytes),
        ReportEncoding::Hat8 => hat_value(source, bytes),
        _ => None,
    }
}

fn source_encoding(source: &SourceDescriptor, report: &ReportDescriptor) -> ReportEncoding {
    // Xbox report 1 carries button bits, axes, triggers, and a hat in one
    // packet. Its report declaration provides the packet identity while each
    // source's layout attributes select the field decoder.
    if source.attributes.contains_key("direction-map") || source.attributes.contains_key("neutral")
    {
        ReportEncoding::Hat8
    } else if ["min", "max", "deadzone", "threshold"]
        .iter()
        .any(|key| source.attributes.contains_key(*key))
    {
        ReportEncoding::AxisU16
    } else if source.attributes.contains_key("bit") || source.attributes.contains_key("width") {
        ReportEncoding::BitField
    } else {
        report.encoding
    }
}

fn bit_field_value(source: &SourceDescriptor, bytes: &[u8]) -> Option<f64> {
    let Some(offset) = source_attr_usize(source, "offset") else {
        return None;
    };
    let bit = source_attr_usize(source, "bit").unwrap_or(0);
    let width = source_attr_usize(source, "width").unwrap_or(1);
    let Some(value) = read_bits(bytes, offset, bit, width) else {
        return None;
    };
    let active = source
        .attributes
        .get("equals")
        .or(source.equals.as_ref())
        .and_then(|expected| parse_u64(expected))
        .map_or(value != 0, |expected| value == expected);
    Some(if active { 1.0 } else { 0.0 })
}

fn axis_value(source: &SourceDescriptor, report: &ReportDescriptor, bytes: &[u8]) -> Option<f64> {
    let Some(offset) = source_attr_usize(source, "offset") else {
        return None;
    };
    let endian = source
        .attributes
        .get("endian")
        .or_else(|| report.attributes.get("endian"))
        .map(String::as_str)
        .unwrap_or("little");
    let raw = match endian {
        "little" | "le" => {
            let (Some(first), Some(second)) = (bytes.get(offset), bytes.get(offset + 1)) else {
                return None;
            };
            u16::from_le_bytes([*first, *second])
        }
        "big" | "be" => {
            let (Some(first), Some(second)) = (bytes.get(offset), bytes.get(offset + 1)) else {
                return None;
            };
            u16::from_be_bytes([*first, *second])
        }
        _ => return None,
    };
    let min = source_attr_f64(source, "min").unwrap_or(0.0);
    let max = source_attr_f64(source, "max").unwrap_or(65535.0);
    if max <= min || f64::from(raw) < min || f64::from(raw) > max {
        return None;
    }
    let normalized = (f64::from(raw) - min) / (max - min);
    let deadzone = source_attr_f64(source, "deadzone").unwrap_or(0.0).max(0.0);
    let centered = source_attr_bool(source, "centered")
        .or_else(|| report_attr_bool(report, "centered"))
        .unwrap_or(min == 0.0 && max == 65535.0);
    let direction = source
        .attributes
        .get("direction")
        .map(String::as_str)
        .unwrap_or("positive");
    if centered {
        let signed = (normalized - 0.5) * 2.0;
        let magnitude = signed.abs();
        if magnitude <= deadzone {
            return Some(0.0);
        }
        let directional = match direction {
            "negative" | "min" | "low" => (-signed).max(0.0),
            "positive" | "max" | "high" => signed.max(0.0),
            _ => magnitude,
        };
        Some(directional)
    } else {
        if normalized <= deadzone {
            return Some(0.0);
        }
        let directional = match direction {
            "negative" | "min" | "low" => (1.0 - normalized).max(0.0),
            _ => normalized,
        };
        Some(directional)
    }
}

fn hat_value(source: &SourceDescriptor, bytes: &[u8]) -> Option<f64> {
    let Some(offset) = source_attr_usize(source, "offset") else {
        return None;
    };
    let Some(value) = bytes.get(offset).copied().map(u16::from) else {
        return None;
    };
    let neutral = source_attr_u16(source, "neutral").unwrap_or(0);
    if value == neutral {
        return Some(0.0);
    }
    let Some(map) = source.attributes.get("direction-map") else {
        return None;
    };
    Some(
        if direction_values(map, source.attributes.get("direction").map(String::as_str))
            .is_some_and(|values| values.contains(&value))
        {
            1.0
        } else {
            0.0
        },
    )
}

fn direction_values(value: &str, direction: Option<&str>) -> Option<Vec<u16>> {
    // Accept a compact per-source list (`8,1,2`) and a complete map
    // (`up:8,1,2;right:2,3,4`) so generated SVGs can choose either form.
    let selected = if value.contains(':') {
        let direction = direction?;
        value.split(';').find_map(|entry| {
            let (name, values) = entry.split_once(':')?;
            (name.trim() == direction).then_some(values)
        })?
    } else {
        value
    };
    selected
        .split([',', '|', ' '])
        .filter(|item| !item.trim().is_empty())
        .map(parse_u16)
        .collect()
}

fn read_bits(bytes: &[u8], offset: usize, bit: usize, width: usize) -> Option<u64> {
    if width == 0 || width > 64 {
        return None;
    }
    let mut value = 0_u64;
    for index in 0..width {
        let absolute = bit.checked_add(index)?;
        let byte = *bytes.get(offset.checked_add(absolute / 8)?)?;
        value |= u64::from((byte >> (absolute % 8)) & 1) << index;
    }
    Some(value)
}

fn source_attr_usize(source: &SourceDescriptor, key: &str) -> Option<usize> {
    source
        .attributes
        .get(key)
        .and_then(|value| parse_integer(value))
}

fn source_attr_u16(source: &SourceDescriptor, key: &str) -> Option<u16> {
    source_attr_usize(source, key).and_then(|value| u16::try_from(value).ok())
}

fn source_attr_f64(source: &SourceDescriptor, key: &str) -> Option<f64> {
    source.attributes.get(key)?.trim().parse().ok()
}

fn source_attr_bool(source: &SourceDescriptor, key: &str) -> Option<bool> {
    match source.attributes.get(key)?.trim() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

fn report_attr_bool(report: &ReportDescriptor, key: &str) -> Option<bool> {
    match report.attributes.get(key)?.trim() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

fn report_page(report: &ReportDescriptor) -> Option<u16> {
    report
        .attributes
        .get("usage-page")
        .and_then(|value| parse_u16(value))
}

fn default_payload_offset(report: &ReportDescriptor) -> usize {
    match report.encoding {
        ReportEncoding::BootKeyboard => report.report_id.map_or(2, |_| 3),
        _ => report.report_id.map_or(0, |_| 1),
    }
}

fn parse_u16(value: &str) -> Option<u16> {
    parse_integer(value).and_then(|value| u16::try_from(value).ok())
}

fn parse_u64(value: &str) -> Option<u64> {
    parse_integer(value).map(|value| value as u64)
}

fn parse_integer(value: &str) -> Option<usize> {
    let value = value.trim();
    if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        usize::from_str_radix(hex, 16).ok()
    } else {
        value.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::device_descriptor::parse_svg;

    const RC003: &str = include_str!("../../../docs/examples/rc003-device.svg");

    #[test]
    fn decodes_rc003_report_into_stable_keys() {
        let descriptor = parse_svg(RC003).unwrap();
        let mut engine = DescriptorEngine::default();
        assert_eq!(
            engine.accept(&descriptor, &[1, 0x28, 0, 0x52, 0, 0, 0]),
            [
                ("xiaomi.rc003.confirm".into(), true),
                ("xiaomi.rc003.up".into(), true),
            ]
        );
        assert!(engine
            .accept(&descriptor, &[1, 0x28, 0, 0x52, 0, 0, 0])
            .is_empty());
        assert_eq!(
            engine.accept(&descriptor, &[1, 0x80, 0, 0, 0, 0, 0]),
            [
                ("xiaomi.rc003.confirm".into(), false),
                ("xiaomi.rc003.up".into(), false),
                ("xiaomi.rc003.volumeUp".into(), true),
            ]
        );
    }

    #[test]
    fn invalid_report_does_not_release_active_keys() {
        let descriptor = parse_svg(RC003).unwrap();
        let mut engine = DescriptorEngine::default();
        engine.accept(&descriptor, &[1, 0x28, 0, 0, 0, 0, 0]);
        assert!(engine.accept(&descriptor, &[1, 0x28, 0]).is_empty());
        assert_eq!(
            engine.release_all(),
            [("xiaomi.rc003.confirm".into(), false)]
        );
    }

    #[test]
    fn report_groups_release_independently() {
        let svg = RC003
            .replace(
            "<ak:report id=\"voice-audio\" direction=\"input\"\n                   encoding=\"gatt-stream\" transport=\"bluetooth-gatt\"\n                   engine=\"rc003-atvv\" />",
            "<ak:report id=\"media\" direction=\"input\" report-id=\"0x03\" length=\"3\"\n                   encoding=\"le-u16-single\" usage-page=\"0x0C\" />",
            )
            .replace(
                "<ak:input id=\"xiaomi.rc003.volumeUp\" label=\"音量加\" kind=\"button\"\n                  target=\"#volume-up\" legacy-key=\"volumeUp\" report=\"keyboard\" page=\"0x07\" usage=\"0x0080\" />",
                "<ak:input id=\"xiaomi.rc003.volumeUp\" label=\"音量加\" kind=\"button\"\n                  target=\"#volume-up\" legacy-key=\"volumeUp\" report=\"keyboard\" page=\"0x07\" usage=\"0x0080\">\n          <ak:source report=\"media\" page=\"0x0C\" usage=\"0x00E9\" />\n        </ak:input>",
            );
        let descriptor = parse_svg(&svg).unwrap();
        let mut engine = DescriptorEngine::default();
        assert_eq!(
            engine.accept(&descriptor, &[1, 0x52, 0, 0x80, 0, 0, 0]),
            [
                ("xiaomi.rc003.up".into(), true),
                ("xiaomi.rc003.volumeUp".into(), true)
            ]
        );
        assert_eq!(engine.accept(&descriptor, &[3, 0xe9, 0]), []);
        assert_eq!(
            engine.accept(&descriptor, &[1, 0, 0, 0, 0, 0, 0]),
            [("xiaomi.rc003.up".into(), false)]
        );
        assert_eq!(
            engine.take_update().unwrap().0["xiaomi.rc003.volumeUp"],
            1.0
        );
        assert_eq!(
            engine.accept(&descriptor, &[3, 0, 0]),
            [("xiaomi.rc003.volumeUp".into(), false)]
        );
        assert!(engine.release_all().is_empty());
    }

    const XBOX: &str = r#"<svg xmlns="http://www.w3.org/2000/svg"
        xmlns:ak="urn:axonkey:device:1"
        data-ak-schema="axonkey.device/1" data-ak-device="xbox.bluetooth"
        data-ak-revision="1">
      <metadata>
        <ak:device schema="axonkey.device/1" id="xbox.bluetooth"
                   vendor="Microsoft" model="Xbox Wireless Controller" revision="1">
          <ak:identity><ak:match transport="bluetooth-hid" vid="0x045E" pid="0x02E0" /></ak:identity>
          <ak:reports>
            <ak:report id="controller" direction="input" report-id="0x01"
                       length="16" encoding="bit-field" />
            <ak:report id="guide" direction="input" report-id="0x02"
                       length="2" encoding="bit-field" />
          </ak:reports>
          <ak:inputs>
            <ak:input id="xbox.a" label="A" kind="button" report="controller"
                      offset="14" bit="0" width="1" />
            <ak:input id="xbox.ls.left" label="Left stick left" kind="axis" report="controller"
                      offset="1" min="0" max="65535" deadzone="0.05"
                      threshold="0.55" direction="negative" />
            <ak:input id="xbox.lt" label="Left trigger" kind="trigger" report="controller"
                      offset="9" min="0" max="1023" deadzone="0.02"
                      threshold="0.55" direction="positive" />
            <ak:input id="xbox.dpad.up" label="D-pad up" kind="hat" report="controller"
                      offset="13" neutral="0" direction-map="8,1,2" direction="up" />
            <ak:input id="xbox.guide" label="Guide" kind="button" report="guide"
                      offset="1" bit="0" width="1" />
          </ak:inputs>
        </ak:device>
      </metadata>
    </svg>"#;

    #[test]
    fn decodes_xbox_mixed_fields_and_hat() {
        let descriptor = parse_svg(XBOX).expect("Xbox descriptor should parse");
        let mut report = [0_u8; 16];
        report[0] = 1;
        report[1..3].copy_from_slice(&0_u16.to_le_bytes());
        report[9..11].copy_from_slice(&600_u16.to_le_bytes());
        report[13] = 8;
        report[14] = 1;
        let values = decode_descriptor(&descriptor, &report).expect("report should decode");
        assert_eq!(values.get("xbox.a"), Some(&1.0));
        assert_eq!(values.get("xbox.ls.left"), Some(&1.0));
        assert!((values["xbox.lt"] - 600.0 / 1023.0).abs() < 0.0001);
        assert_eq!(values.get("xbox.dpad.up"), Some(&1.0));
    }

    #[test]
    fn xbox_threshold_and_report_groups_are_stable() {
        let descriptor = parse_svg(XBOX).expect("Xbox descriptor should parse");
        let mut engine = DescriptorEngine::default();
        let mut report = [0_u8; 16];
        report[0] = 1;
        report[1..3].copy_from_slice(&32768_u16.to_le_bytes());
        report[9..11].copy_from_slice(&500_u16.to_le_bytes());
        assert!(engine.accept(&descriptor, &report).is_empty());
        report[9..11].copy_from_slice(&600_u16.to_le_bytes());
        assert_eq!(
            engine.accept(&descriptor, &report),
            [("xbox.lt".into(), true)]
        );
        assert_eq!(
            engine.accept(&descriptor, &[2, 1]),
            [("xbox.guide".into(), true)]
        );
        report[9..11].copy_from_slice(&0_u16.to_le_bytes());
        assert_eq!(
            engine.accept(&descriptor, &report),
            [("xbox.lt".into(), false)]
        );
        assert_eq!(
            engine.accept(&descriptor, &[2, 0]),
            [("xbox.guide".into(), false)]
        );
    }

    #[test]
    fn malformed_custom_field_does_not_match() {
        let descriptor = parse_svg(XBOX).expect("Xbox descriptor should parse");
        let mut bytes = [0_u8; 16];
        bytes[0] = 1;
        let mut invalid = descriptor.clone();
        invalid.inputs[0].sources[0]
            .attributes
            .insert("offset".into(), "99".into());
        assert!(decode_descriptor(&invalid, &bytes).is_none());
    }

    #[test]
    fn alternate_wire_formats_share_their_declared_state_group() {
        let mut engine = DescriptorEngine::default();
        let rc003 = crate::devices::descriptor_registry::descriptor_for_kind("rc003").unwrap();
        assert_eq!(
            engine.accept(rc003, &[1, 0x52, 0, 0, 0, 0, 0]),
            [("xiaomi.rc003.up".into(), true)]
        );
        assert_eq!(
            engine.accept(rc003, &[0; 8]),
            [("xiaomi.rc003.up".into(), false)]
        );
        assert_eq!(
            engine.accept(rc003, &[0x3e, 0, 0, 0, 0, 0]),
            [("xiaomi.rc003.voice".into(), true)]
        );
        assert_eq!(
            engine.accept(rc003, &[1, 0, 0, 0, 0, 0, 0, 0, 0]),
            [("xiaomi.rc003.voice".into(), false)]
        );
        assert!(engine.release_all().is_empty());

        assert_eq!(
            engine.accept(rc003, &[1, 0x52, 0, 0x28, 0, 0, 0, 0, 0]),
            [
                ("xiaomi.rc003.confirm".into(), true),
                ("xiaomi.rc003.up".into(), true)
            ]
        );
        assert_eq!(
            engine.accept(rc003, &[1, 0, 0, 0, 0, 0, 0]),
            [
                ("xiaomi.rc003.confirm".into(), false),
                ("xiaomi.rc003.up".into(), false)
            ]
        );

        let xm = crate::devices::descriptor_registry::descriptor_for_kind("xmBt29").unwrap();
        let mut engine = DescriptorEngine::default();
        assert_eq!(
            engine.accept(xm, &[1, 0, 0, 0x1e]),
            [("xmBt29.digit1".into(), true)]
        );
        assert_eq!(
            engine.accept(xm, &[1, 0, 0, 0, 0, 0, 0, 0, 0]),
            [("xmBt29.digit1".into(), false)]
        );
    }

    #[test]
    fn vendor_validation_and_gap_release_keep_physical_voice_edges() {
        let descriptor =
            crate::devices::descriptor_registry::descriptor_for_kind("cmiotA15").unwrap();
        let mut engine = DescriptorEngine::default();
        let mut voice = [0; 21];
        voice[..4].copy_from_slice(&[0xf8, 0x82, 3, 1]);
        assert_eq!(
            engine.accept(descriptor, &voice),
            [("cmiotA15.voice".into(), true)]
        );
        engine.accept(descriptor, &[1, 0, 0, 0x52, 0, 0, 0, 0, 0]);
        assert_eq!(
            engine.release_except(&["cmiotA15.voice"]),
            [("cmiotA15.up".into(), false)]
        );
        assert!(engine.accept(descriptor, &voice).is_empty());
        let mut invalid = voice;
        invalid[1] = 0;
        assert!(engine.accept(descriptor, &invalid).is_empty());
        invalid = voice;
        invalid[3] = 2;
        assert!(engine.accept(descriptor, &invalid).is_empty());
        invalid = voice;
        invalid[20] = 1;
        assert!(engine.accept(descriptor, &invalid).is_empty());
        voice[3] = 0;
        assert_eq!(
            engine.accept(descriptor, &voice),
            [("cmiotA15.voice".into(), false)]
        );
        assert!(engine.release_all().is_empty());
    }
}
