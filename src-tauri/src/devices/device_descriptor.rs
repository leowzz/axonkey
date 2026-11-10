use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const AK_NS: &str = "urn:axonkey:device:1";
const SCHEMA: &str = "axonkey.device/1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DescriptorError(pub String);

impl fmt::Display for DescriptorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DescriptorError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeviceDescriptor {
    pub schema: String,
    pub id: String,
    pub vendor: String,
    pub model: String,
    pub revision: u32,
    pub identities: Vec<IdentityDescriptor>,
    pub reports: BTreeMap<String, ReportDescriptor>,
    pub inputs: Vec<InputDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct IdentityDescriptor {
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReportDescriptor {
    pub id: String,
    pub direction: String,
    pub report_id: Option<u8>,
    pub length: Option<usize>,
    pub encoding: ReportEncoding,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReportEncoding {
    BootKeyboard,
    LeU16Slots,
    LeU16Single,
    BitField,
    AxisU16,
    Hat8,
    VendorState,
    GattStream,
}

impl ReportEncoding {
    fn parse(value: &str) -> Result<Self, DescriptorError> {
        match value {
            "boot-keyboard" => Ok(Self::BootKeyboard),
            "le-u16-slots" => Ok(Self::LeU16Slots),
            "le-u16-single" => Ok(Self::LeU16Single),
            "bit-field" => Ok(Self::BitField),
            "axis-u16" => Ok(Self::AxisU16),
            "hat-8" => Ok(Self::Hat8),
            "vendor-state" => Ok(Self::VendorState),
            "gatt-stream" => Ok(Self::GattStream),
            other => Err(DescriptorError(format!(
                "unsupported report encoding: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InputDescriptor {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub target: Option<String>,
    pub legacy_key: Option<String>,
    pub original: bool,
    pub sources: Vec<SourceDescriptor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct SourceDescriptor {
    pub report: String,
    pub page: Option<u16>,
    pub usage: Option<u16>,
    pub engine: Option<String>,
    pub field: Option<String>,
    pub equals: Option<String>,
    /// Encoding-specific source attributes, such as `offset`, `bit`, and
    /// `direction`. Keeping these as parsed strings lets the engine validate
    /// only the attributes relevant to the selected report encoding.
    pub attributes: BTreeMap<String, String>,
}

pub(crate) fn parse_svg(svg: &str) -> Result<DeviceDescriptor, DescriptorError> {
    let mut reader = Reader::from_str(svg);
    reader.config_mut().trim_text(true);
    let mut root: Option<RootMetadata> = None;
    let mut device: Option<DeviceDescriptor> = None;
    let mut identities = Vec::new();
    let mut reports = BTreeMap::new();
    let mut inputs = Vec::new();
    let mut input_ids = BTreeSet::new();
    let mut stack: Vec<String> = Vec::new();
    let mut svg_ids = BTreeSet::new();
    let mut open_input: Option<usize> = None;

    loop {
        let event = reader
            .read_event()
            .map_err(|error| DescriptorError(format!("invalid SVG XML: {error}")))?;
        match event {
            Event::Start(element) => {
                let name = local_name(element.name().as_ref());
                let attrs = attributes(&element)?;
                validate_element(&name, &attrs)?;
                if let Some(id) = attrs.get("id") {
                    svg_ids.insert(id.clone());
                }
                if stack.is_empty() {
                    root = Some(parse_root(&name, &attrs)?);
                } else if is_ak(&element) {
                    match name.as_str() {
                        "device" => {
                            if device.is_some() {
                                return Err(DescriptorError("duplicate ak:device".into()));
                            }
                            device = Some(parse_device(&attrs)?);
                        }
                        "match" => identities.push(IdentityDescriptor {
                            attributes: attrs.clone(),
                        }),
                        "report" => {
                            let report = parse_report(&attrs)?;
                            if reports.insert(report.id.clone(), report).is_some() {
                                return Err(DescriptorError("duplicate report id".into()));
                            }
                        }
                        "input" => {
                            let input = parse_input(&attrs)?;
                            if !input_ids.insert(input.id.clone()) {
                                return Err(DescriptorError(format!(
                                    "duplicate input id: {}",
                                    input.id
                                )));
                            }
                            inputs.push(input);
                            open_input = Some(inputs.len() - 1);
                        }
                        "source" => {
                            if let Some(index) = open_input {
                                inputs[index].sources.push(parse_source(&attrs)?);
                            }
                        }
                        _ => {}
                    }
                }
                stack.push(name);
            }
            Event::Empty(element) => {
                let name = local_name(element.name().as_ref());
                let attrs = attributes(&element)?;
                validate_element(&name, &attrs)?;
                if let Some(id) = attrs.get("id") {
                    svg_ids.insert(id.clone());
                }
                if stack.is_empty() {
                    root = Some(parse_root(&name, &attrs)?);
                } else if is_ak(&element) {
                    match name.as_str() {
                        "device" => {
                            if device.is_some() {
                                return Err(DescriptorError("duplicate ak:device".into()));
                            }
                            device = Some(parse_device(&attrs)?);
                        }
                        "match" => identities.push(IdentityDescriptor {
                            attributes: attrs.clone(),
                        }),
                        "report" => {
                            let report = parse_report(&attrs)?;
                            if reports.insert(report.id.clone(), report).is_some() {
                                return Err(DescriptorError("duplicate report id".into()));
                            }
                        }
                        "input" => {
                            let input = parse_input(&attrs)?;
                            if !input_ids.insert(input.id.clone()) {
                                return Err(DescriptorError(format!(
                                    "duplicate input id: {}",
                                    input.id
                                )));
                            }
                            inputs.push(input);
                        }
                        "source" => {
                            if let Some(index) = open_input {
                                inputs[index].sources.push(parse_source(&attrs)?);
                            }
                        }
                        _ => {}
                    }
                }
            }
            Event::End(element) => {
                let name = local_name(element.name().as_ref());
                if stack.pop().as_deref() != Some(name.as_str()) {
                    return Err(DescriptorError(format!("unbalanced SVG element: {name}")));
                }
                if name == "input" {
                    open_input = None;
                }
            }
            Event::Eof => break,
            Event::DocType(_) => return Err(DescriptorError("DOCTYPE is not allowed".into())),
            Event::GeneralRef(reference) => {
                let bytes: &[u8] = reference.as_ref();
                return Err(DescriptorError(format!(
                    "entity references are not allowed: {bytes:?}"
                )));
            }
            Event::Decl(_)
            | Event::Comment(_)
            | Event::CData(_)
            | Event::Text(_)
            | Event::PI(_) => {}
        }
    }

    let root = root.ok_or_else(|| DescriptorError("SVG root is missing".into()))?;
    let mut device =
        device.ok_or_else(|| DescriptorError("ak:device metadata is missing".into()))?;
    if root.schema != device.schema || root.id != device.id || root.revision != device.revision {
        return Err(DescriptorError(
            "root data-ak metadata conflicts with ak:device".into(),
        ));
    }
    if device.schema != SCHEMA {
        return Err(DescriptorError(format!(
            "unsupported descriptor schema: {}",
            device.schema
        )));
    }
    if identities.is_empty() {
        return Err(DescriptorError("ak:identity must contain a match".into()));
    }
    for input in &mut inputs {
        if input.sources.is_empty() {
            return Err(DescriptorError(format!(
                "input has no source: {}",
                input.id
            )));
        }
        for source in &input.sources {
            if !reports.contains_key(&source.report) {
                return Err(DescriptorError(format!(
                    "input {} references unknown report {}",
                    input.id, source.report
                )));
            }
            if source.page.is_some() != source.usage.is_some() {
                return Err(DescriptorError(format!(
                    "input {} source must provide both page and usage",
                    input.id
                )));
            }
            if source.page.is_none()
                && source.engine.is_none()
                && source.field.is_none()
                && !source_has_layout(source)
            {
                return Err(DescriptorError(format!(
                    "input {} source needs HID page/usage or a decoder engine",
                    input.id
                )));
            }
        }
        if let Some(target) = &input.target {
            if !target.starts_with('#') || target.len() == 1 {
                return Err(DescriptorError(format!(
                    "input {} has invalid target",
                    input.id
                )));
            }
            if !svg_ids.contains(&target[1..]) {
                return Err(DescriptorError(format!(
                    "input {} targets missing SVG id {}",
                    input.id, target
                )));
            }
        }
    }
    device.identities = identities;
    device.reports = reports;
    device.inputs = inputs;
    validate_reports(&device.reports)?;
    Ok(device)
}

#[derive(Debug)]
struct RootMetadata {
    schema: String,
    id: String,
    revision: u32,
}

fn parse_root(
    name: &str,
    attrs: &BTreeMap<String, String>,
) -> Result<RootMetadata, DescriptorError> {
    if name != "svg" {
        return Err(DescriptorError("SVG root element must be svg".into()));
    }
    if required(attrs, "xmlns")? != SVG_NS || required(attrs, "xmlns:ak")? != AK_NS {
        return Err(DescriptorError(
            "SVG namespace declarations are invalid".into(),
        ));
    }
    let schema = required(attrs, "data-ak-schema")?.to_string();
    let id = required(attrs, "data-ak-device")?.to_string();
    let revision = parse_u32(required(attrs, "data-ak-revision")?, "data-ak-revision")?;
    Ok(RootMetadata {
        schema,
        id,
        revision,
    })
}

fn parse_device(attrs: &BTreeMap<String, String>) -> Result<DeviceDescriptor, DescriptorError> {
    let schema = required(attrs, "schema")?.to_string();
    let id = required(attrs, "id")?.to_string();
    let revision = parse_u32(required(attrs, "revision")?, "revision")?;
    Ok(DeviceDescriptor {
        schema,
        id,
        vendor: required(attrs, "vendor")?.to_string(),
        model: required(attrs, "model")?.to_string(),
        revision,
        identities: Vec::new(),
        reports: BTreeMap::new(),
        inputs: Vec::new(),
    })
}

fn parse_report(attrs: &BTreeMap<String, String>) -> Result<ReportDescriptor, DescriptorError> {
    let id = required(attrs, "id")?.to_string();
    let direction = required(attrs, "direction")?.to_string();
    if !matches!(direction.as_str(), "input" | "output") {
        return Err(DescriptorError(format!(
            "invalid report direction: {direction}"
        )));
    }
    let encoding = ReportEncoding::parse(required(attrs, "encoding")?)?;
    if matches!(
        encoding,
        ReportEncoding::VendorState | ReportEncoding::GattStream
    ) && attrs.get("engine").is_none()
    {
        return Err(DescriptorError(format!("report {id} requires an engine")));
    }
    Ok(ReportDescriptor {
        id,
        direction,
        report_id: optional_u8(attrs, "report-id")?,
        length: optional_usize(attrs, "length")?,
        encoding,
        attributes: attrs.clone(),
    })
}

fn parse_input(attrs: &BTreeMap<String, String>) -> Result<InputDescriptor, DescriptorError> {
    let sources = match attrs.get("report") {
        Some(report) => vec![SourceDescriptor {
            report: report.clone(),
            page: optional_hex(attrs, "page")?,
            usage: optional_hex(attrs, "usage")?,
            engine: attrs.get("engine").cloned(),
            field: attrs.get("field").cloned(),
            equals: attrs.get("equals").cloned(),
            attributes: attrs.clone(),
        }],
        None => Vec::new(),
    };
    Ok(InputDescriptor {
        id: required(attrs, "id")?.to_string(),
        label: required(attrs, "label")?.to_string(),
        kind: required(attrs, "kind")?.to_string(),
        target: attrs.get("target").cloned(),
        legacy_key: attrs.get("legacy-key").cloned(),
        original: match attrs.get("original").map(String::as_str) {
            None | Some("false") => false,
            Some("true") => true,
            Some(value) => return Err(DescriptorError(format!("invalid original flag: {value}"))),
        },
        sources,
    })
}

fn parse_source(attrs: &BTreeMap<String, String>) -> Result<SourceDescriptor, DescriptorError> {
    Ok(SourceDescriptor {
        report: required(attrs, "report")?.to_string(),
        page: optional_hex(attrs, "page")?,
        usage: optional_hex(attrs, "usage")?,
        engine: attrs.get("engine").cloned(),
        field: attrs.get("field").cloned(),
        equals: attrs.get("equals").cloned(),
        attributes: attrs.clone(),
    })
}

fn source_has_layout(source: &SourceDescriptor) -> bool {
    [
        "offset",
        "bit",
        "width",
        "min",
        "max",
        "deadzone",
        "threshold",
        "neutral",
        "direction-map",
    ]
    .iter()
    .any(|key| source.attributes.contains_key(*key))
}

fn validate_reports(reports: &BTreeMap<String, ReportDescriptor>) -> Result<(), DescriptorError> {
    for report in reports.values() {
        match report.encoding {
            ReportEncoding::LeU16Slots => {
                let offset = parse_usize_attr(report, "payload-offset", 0)?;
                let width = parse_usize_attr(report, "slot-width", 2)?;
                let count = parse_usize_attr(report, "slot-count", 0)?;
                if width != 2 || count == 0 {
                    return Err(DescriptorError(format!(
                        "report {} has invalid u16 slot layout",
                        report.id
                    )));
                }
                if let Some(length) = report.length {
                    if length < offset + width * count {
                        return Err(DescriptorError(format!(
                            "report {} length is shorter than payload",
                            report.id
                        )));
                    }
                }
            }
            ReportEncoding::BootKeyboard => {
                if report.length.is_none() {
                    return Err(DescriptorError(format!(
                        "report {} length is required",
                        report.id
                    )));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn parse_usize_attr(
    report: &ReportDescriptor,
    key: &str,
    default: usize,
) -> Result<usize, DescriptorError> {
    report
        .attributes
        .get(key)
        .map(|value| parse_usize(value, key))
        .transpose()
        .map(|value| value.unwrap_or(default))
}

fn validate_element(name: &str, attrs: &BTreeMap<String, String>) -> Result<(), DescriptorError> {
    if name.eq_ignore_ascii_case("script") {
        return Err(DescriptorError("script elements are not allowed".into()));
    }
    if attrs
        .keys()
        .any(|key| key.to_ascii_lowercase().starts_with("on"))
    {
        return Err(DescriptorError(
            "SVG event attributes are not allowed".into(),
        ));
    }
    if matches!(name, "image" | "use") {
        if let Some(href) = attrs.get("href").or_else(|| attrs.get("xlink:href")) {
            if !href.starts_with('#') {
                return Err(DescriptorError(
                    "external SVG references are not allowed".into(),
                ));
            }
        }
    }
    Ok(())
}

fn is_ak(element: &BytesStart<'_>) -> bool {
    element.name().as_ref().split(|byte| *byte == b':').next() == Some(b"ak")
}

fn local_name(name: &[u8]) -> String {
    String::from_utf8_lossy(name.rsplit(|byte| *byte == b':').next().unwrap_or(name)).into_owned()
}

fn attributes(element: &BytesStart<'_>) -> Result<BTreeMap<String, String>, DescriptorError> {
    let mut result = BTreeMap::new();
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute
            .map_err(|error| DescriptorError(format!("invalid SVG attribute: {error}")))?;
        let key = String::from_utf8_lossy(attribute.key.as_ref()).into_owned();
        let value = attribute
            .normalized_value(XmlVersion::default())
            .map_err(|error| DescriptorError(format!("invalid SVG attribute value: {error}")))?
            .into_owned();
        result.insert(key, value);
    }
    Ok(result)
}

fn required<'a>(
    attrs: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, DescriptorError> {
    attrs
        .get(key)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| DescriptorError(format!("missing required attribute: {key}")))
}

fn optional_hex(
    attrs: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<u16>, DescriptorError> {
    attrs
        .get(key)
        .map(|value| parse_u16(value, key))
        .transpose()
}

fn optional_u8(attrs: &BTreeMap<String, String>, key: &str) -> Result<Option<u8>, DescriptorError> {
    attrs.get(key).map(|value| parse_u8(value, key)).transpose()
}

fn optional_usize(
    attrs: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<usize>, DescriptorError> {
    attrs
        .get(key)
        .map(|value| parse_usize(value, key))
        .transpose()
}

fn parse_u16(value: &str, key: &str) -> Result<u16, DescriptorError> {
    parse_integer(value, key).and_then(|value| {
        u16::try_from(value).map_err(|_| DescriptorError(format!("{key} is out of range")))
    })
}

fn parse_u8(value: &str, key: &str) -> Result<u8, DescriptorError> {
    parse_integer(value, key).and_then(|value| {
        u8::try_from(value).map_err(|_| DescriptorError(format!("{key} is out of range")))
    })
}

fn parse_u32(value: &str, key: &str) -> Result<u32, DescriptorError> {
    parse_integer(value, key).and_then(|value| {
        u32::try_from(value).map_err(|_| DescriptorError(format!("{key} is out of range")))
    })
}

fn parse_usize(value: &str, key: &str) -> Result<usize, DescriptorError> {
    parse_integer(value, key).and_then(|value| {
        usize::try_from(value).map_err(|_| DescriptorError(format!("{key} is out of range")))
    })
}

fn parse_integer(value: &str, key: &str) -> Result<u64, DescriptorError> {
    let value = value.trim();
    let parsed = if let Some(hex) = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
    {
        u64::from_str_radix(hex, 16)
    } else {
        value.parse::<u64>()
    };
    parsed.map_err(|_| DescriptorError(format!("invalid numeric attribute {key}: {value}")))
}

#[cfg(test)]
mod tests {
    use super::{parse_svg, ReportEncoding};

    const RC003: &str = include_str!("../../../docs/examples/rc003-device.svg");

    #[test]
    fn parses_rc003_descriptor() {
        let descriptor = parse_svg(RC003).expect("RC003 descriptor should parse");
        assert_eq!(descriptor.id, "xiaomi.rc003");
        assert_eq!(descriptor.revision, 1);
        assert_eq!(descriptor.inputs.len(), 13);
        assert_eq!(
            descriptor.reports["keyboard"].encoding,
            ReportEncoding::LeU16Slots
        );
        assert_eq!(descriptor.reports["keyboard"].length, Some(7));
        assert_eq!(descriptor.inputs[0].sources[0].usage, Some(0x003e));
    }

    #[test]
    fn rejects_conflicting_root_metadata() {
        let svg = RC003.replace(
            "data-ak-device=\"xiaomi.rc003\"",
            "data-ak-device=\"other.device\"",
        );
        assert!(parse_svg(&svg).is_err());
    }

    #[test]
    fn rejects_duplicate_input_ids() {
        let svg = RC003.replace("id=\"xiaomi.rc003.power\"", "id=\"xiaomi.rc003.voice\"");
        assert!(parse_svg(&svg).is_err());
    }

    #[test]
    fn rejects_unknown_report_reference() {
        let svg = RC003.replace("report=\"keyboard\"", "report=\"unknown\"");
        assert!(parse_svg(&svg).is_err());
    }
}
