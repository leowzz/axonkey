use super::{
    format_hex, parse_hex_bytes, CaptureCandidate, CaptureCollisionWarning, CaptureDraftInputItem,
    CapturedKeySample, CompiledCaptureResult, ParsedCaptureDraft,
};
use crate::devices::device_descriptor::parse_svg;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use std::collections::{BTreeMap, BTreeSet};

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const AK_NS: &str = "urn:axonkey:device:1";
const SCHEMA: &str = "axonkey.device/1";

#[derive(Clone, Debug, Default)]
struct ParsedDraftInternal {
    root_attrs: Vec<(String, String)>,
    title_text: Option<String>,
    device_attrs: BTreeMap<String, String>,
    existing_matches: Vec<BTreeMap<String, String>>,
    pending_identity_attrs: Option<BTreeMap<String, String>>,
    pending_conditions: Vec<BTreeMap<String, String>>,
    preserved_reports: Vec<BTreeMap<String, String>>,
    voices: Vec<BTreeMap<String, String>>,
    inputs: Vec<DraftInputNode>,
    svg_ids: BTreeSet<String>,
}

#[derive(Clone, Debug)]
struct DraftInputNode {
    attrs: BTreeMap<String, String>,
    capture_attrs: Option<BTreeMap<String, String>>,
    existing_sources: Vec<BTreeMap<String, String>>,
}

#[derive(Clone, Debug)]
struct ResolvedSample {
    report_id: u8,
    press_bytes: Vec<u8>,
    release_bytes: Vec<u8>,
    press_hex: String,
    release_hex: String,
}

#[derive(Clone, Debug)]
struct SynthesizedReport {
    id: String,
    report_id: u8,
    length: usize,
    prefix: String,
    offset: usize,
    width_bits: usize,
}

pub fn parse_draft_svg(svg_content: &str) -> Result<ParsedCaptureDraft, String> {
    let internal = inspect_svg(svg_content)?;
    let device_id = internal
        .device_attrs
        .get("id")
        .or_else(|| find_attr(&internal.root_attrs, "data-ak-device"))
        .cloned()
        .unwrap_or_else(|| "custom-device".into());
    let vendor = internal
        .device_attrs
        .get("vendor")
        .filter(|v| !v.trim().is_empty())
        .cloned();
    let model = internal
        .device_attrs
        .get("model")
        .filter(|v| !v.trim().is_empty())
        .cloned();
    let display_name = internal
        .device_attrs
        .get("display-name")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| match (&vendor, &model) {
            (Some(v), Some(m)) => Some(format!("{v} {m}")),
            (None, Some(m)) => Some(m.clone()),
            (Some(v), None) => Some(v.clone()),
            (None, None) => None,
        })
        .or_else(|| internal.title_text.clone())
        .unwrap_or_else(|| device_id.clone());
    let status = internal
        .device_attrs
        .get("status")
        .or_else(|| find_attr(&internal.root_attrs, "data-ak-status"))
        .cloned()
        .unwrap_or_else(|| "draft".into());

    let inputs = internal
        .inputs
        .into_iter()
        .map(|node| {
            let id = node.attrs.get("id").cloned().unwrap_or_default();
            let label = node
                .attrs
                .get("label")
                .cloned()
                .unwrap_or_else(|| id.clone());
            let icon = node.attrs.get("icon").cloned();
            let press_hex = node
                .capture_attrs
                .as_ref()
                .and_then(|c| c.get("press"))
                .cloned();
            let release_hex = node
                .capture_attrs
                .as_ref()
                .and_then(|c| c.get("release"))
                .cloned();
            let binding = node.attrs.get("binding").cloned().unwrap_or_else(|| {
                if !node.existing_sources.is_empty()
                    || node.attrs.contains_key("report")
                    || press_hex.is_some()
                {
                    "captured".into()
                } else {
                    "pending".into()
                }
            });
            CaptureDraftInputItem {
                id,
                label,
                icon,
                binding,
                press_hex,
                release_hex,
            }
        })
        .collect();

    Ok(ParsedCaptureDraft {
        device_id,
        display_name,
        vendor,
        model,
        status,
        inputs,
    })
}

pub fn compile_svg(
    draft_svg: &str,
    candidate: Option<&CaptureCandidate>,
    samples: &[CapturedKeySample],
    target_status: Option<&str>,
) -> Result<CompiledCaptureResult, String> {
    let mut internal = inspect_svg(draft_svg)?;

    let device_id = internal
        .device_attrs
        .get("id")
        .or_else(|| find_attr(&internal.root_attrs, "data-ak-device"))
        .cloned()
        .unwrap_or_else(|| "custom-device".into());
    let revision: u32 = internal
        .device_attrs
        .get("revision")
        .or_else(|| find_attr(&internal.root_attrs, "data-ak-revision"))
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(1)
        .max(1);
    let vendor = internal
        .device_attrs
        .get("vendor")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| {
            candidate
                .and_then(|c| c.gatt_info.as_ref())
                .and_then(|g| g.manufacturer.clone())
        })
        .unwrap_or_else(|| "Unknown".into());
    let model = internal
        .device_attrs
        .get("model")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .or_else(|| {
            candidate
                .and_then(|c| c.gatt_info.as_ref())
                .and_then(|g| g.model_number.clone())
        })
        .or_else(|| candidate.map(|c| c.display_name.clone()))
        .unwrap_or_else(|| device_id.clone());
    let display_name = internal
        .device_attrs
        .get("display-name")
        .filter(|v| !v.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| {
            if model.starts_with(&vendor) || vendor == "Unknown" {
                model.clone()
            } else {
                format!("{vendor} {model}")
            }
        });

    let mut sample_map = collect_existing_captures(&internal.inputs)?;
    for sample in samples {
        let input_id = sample.input_id.trim();
        if input_id.is_empty() {
            continue;
        }
        let press_bytes = parse_hex_bytes(&sample.press_hex)?;
        let release_bytes = if sample.release_hex.trim().is_empty() {
            let mut neutral = vec![0u8; press_bytes.len()];
            neutral[0] = press_bytes[0];
            neutral
        } else {
            parse_hex_bytes(&sample.release_hex)?
        };
        if press_bytes == release_bytes {
            return Err(format!(
                "按键「{input_id}」的按下与松开报文相同（{}），请重新采集。",
                format_hex(&press_bytes)
            ));
        }
        sample_map.insert(
            input_id.to_string(),
            ResolvedSample {
                report_id: press_bytes[0],
                press_hex: format_hex(&press_bytes),
                release_hex: format_hex(&release_bytes),
                press_bytes,
                release_bytes,
            },
        );
    }

    // Ensure any raw-probe samples without draft entries still become valid <ak:input> rows.
    let known_ids: BTreeSet<String> = internal
        .inputs
        .iter()
        .filter_map(|i| i.attrs.get("id").cloned())
        .collect();
    for input_id in sample_map.keys() {
        if !known_ids.contains(input_id) {
            let mut attrs = BTreeMap::new();
            attrs.insert("id".into(), input_id.clone());
            attrs.insert("label".into(), input_id.clone());
            attrs.insert("kind".into(), "button".into());
            attrs.insert("original".into(), "false".into());
            internal.inputs.push(DraftInputNode {
                attrs,
                capture_attrs: None,
                existing_sources: Vec::new(),
            });
        }
    }

    let collisions = detect_collisions(&internal.inputs, &sample_map);
    let reports_by_group = synthesize_reports(&sample_map)?;
    retain_compatible_preserved_reports_and_sources(&mut internal, &sample_map, &reports_by_group);

    let mut adapted_count = 0usize;
    let mut pending_count = 0usize;
    for node in &internal.inputs {
        let id = node.attrs.get("id").map(String::as_str).unwrap_or_default();
        if sample_map.contains_key(id) || !node.existing_sources.is_empty() {
            adapted_count += 1;
        } else {
            pending_count += 1;
        }
    }

    let status = match target_status.map(str::trim).filter(|s| !s.is_empty()) {
        Some("active") => "active",
        Some("draft") => "draft",
        Some(other) => {
            return Err(format!(
                "不支持的目标状态「{other}」，仅支持 active 或 draft。"
            ))
        }
        None => {
            if pending_count == 0 && adapted_count > 0 {
                "active"
            } else {
                "draft"
            }
        }
    };

    let (identity_matches, used_placeholder_identity) =
        build_identity_matches(&internal, candidate);
    let metadata_xml = render_metadata_xml(
        &device_id,
        &vendor,
        &model,
        revision,
        &display_name,
        status,
        &identity_matches,
        &reports_by_group,
        &internal.preserved_reports,
        &internal.inputs,
        &internal.svg_ids,
        &sample_map,
        &internal.voices,
    )?;

    let svg_content = splice_svg_document(draft_svg, &device_id, revision, status, &metadata_xml)?;
    validate_compiled_svg(&svg_content)?;

    let markdown_summary = render_markdown_summary(
        &display_name,
        &device_id,
        status,
        candidate,
        used_placeholder_identity,
        &reports_by_group,
        &internal.inputs,
        &sample_map,
        &collisions,
        adapted_count,
        pending_count,
    );

    Ok(CompiledCaptureResult {
        svg_content,
        markdown_summary,
        adapted_count,
        pending_count,
        collisions,
        validated: true,
    })
}

pub(crate) fn validate_compiled_svg(svg_content: &str) -> Result<(), String> {
    parse_svg(svg_content)
        .map(|_| ())
        .map_err(|error| format!("生成的设备描述 SVG 未通过引擎校验：{error}"))
}

fn inspect_svg(svg: &str) -> Result<ParsedDraftInternal, String> {
    let trimmed = svg.trim();
    if trimmed.is_empty() {
        return Err("SVG 内容为空。".into());
    }
    let mut reader = Reader::from_str(svg);
    reader.config_mut().trim_text(true);

    let mut out = ParsedDraftInternal::default();
    let mut stack: Vec<String> = Vec::new();
    let mut in_title = false;
    let mut current_input: Option<DraftInputNode> = None;
    let mut in_pending_identity = false;
    let mut fallback_hotzones: Vec<(String, String)> = Vec::new();

    loop {
        let event = reader
            .read_event()
            .map_err(|err| format!("无效的 SVG XML：{err}"))?;
        match event {
            Event::Start(el) => {
                let qname = String::from_utf8_lossy(el.name().as_ref()).into_owned();
                let local = local_name(&qname);
                let attrs_ordered = ordered_attributes(&el)?;
                let attrs: BTreeMap<String, String> = attrs_ordered.iter().cloned().collect();
                check_safe_element(&local, &attrs)?;

                if let Some(id) = attrs.get("id") {
                    out.svg_ids.insert(id.clone());
                }
                if stack.is_empty() {
                    if local != "svg" {
                        return Err("SVG 根节点必须是 <svg>。".into());
                    }
                    out.root_attrs = attrs_ordered;
                } else if qname.starts_with("ak:") {
                    handle_ak_open(
                        &local,
                        attrs,
                        &mut out,
                        &mut current_input,
                        &mut in_pending_identity,
                        false,
                    );
                } else {
                    if local == "title" && out.title_text.is_none() {
                        in_title = true;
                    }
                    collect_hotzone_fallback(&attrs, &mut fallback_hotzones);
                }
                stack.push(qname);
            }
            Event::Empty(el) => {
                let qname = String::from_utf8_lossy(el.name().as_ref()).into_owned();
                let local = local_name(&qname);
                let attrs_ordered = ordered_attributes(&el)?;
                let attrs: BTreeMap<String, String> = attrs_ordered.iter().cloned().collect();
                check_safe_element(&local, &attrs)?;

                if let Some(id) = attrs.get("id") {
                    out.svg_ids.insert(id.clone());
                }
                if stack.is_empty() {
                    if local != "svg" {
                        return Err("SVG 根节点必须是 <svg>。".into());
                    }
                    out.root_attrs = attrs_ordered;
                } else if qname.starts_with("ak:") {
                    handle_ak_open(
                        &local,
                        attrs,
                        &mut out,
                        &mut current_input,
                        &mut in_pending_identity,
                        true,
                    );
                } else {
                    collect_hotzone_fallback(&attrs, &mut fallback_hotzones);
                }
            }
            Event::Text(text) => {
                if in_title && out.title_text.is_none() {
                    let decoded = String::from_utf8_lossy(text.as_ref()).trim().to_string();
                    if !decoded.is_empty() {
                        out.title_text = Some(decoded);
                    }
                }
            }
            Event::End(el) => {
                let qname = String::from_utf8_lossy(el.name().as_ref()).into_owned();
                let local = local_name(&qname);
                stack.pop();
                if local == "title" {
                    in_title = false;
                } else if qname == "ak:input" {
                    if let Some(finished) = current_input.take() {
                        out.inputs.push(finished);
                    }
                } else if qname == "ak:pending-identity" {
                    in_pending_identity = false;
                }
            }
            Event::DocType(_) => return Err("SVG 中不允许包含 DOCTYPE。".into()),
            Event::GeneralRef(_) => return Err("SVG 中不允许包含外部或自定义实体引用。".into()),
            Event::Eof => break,
            _ => {}
        }
    }

    if out.root_attrs.is_empty() {
        return Err("未找到有效的 <svg> 根节点。".into());
    }

    if out.inputs.is_empty() && !fallback_hotzones.is_empty() {
        let mut seen = BTreeSet::new();
        for (key_id, label) in fallback_hotzones {
            if seen.insert(key_id.clone()) {
                let mut attrs = BTreeMap::new();
                attrs.insert("id".into(), key_id);
                attrs.insert("label".into(), label);
                attrs.insert("kind".into(), "button".into());
                attrs.insert("original".into(), "false".into());
                attrs.insert("binding".into(), "pending".into());
                out.inputs.push(DraftInputNode {
                    attrs,
                    capture_attrs: None,
                    existing_sources: Vec::new(),
                });
            }
        }
    }

    Ok(out)
}

fn handle_ak_open(
    local: &str,
    attrs: BTreeMap<String, String>,
    out: &mut ParsedDraftInternal,
    current_input: &mut Option<DraftInputNode>,
    in_pending_identity: &mut bool,
    is_empty_element: bool,
) {
    match local {
        "device" => {
            out.device_attrs = attrs;
        }
        "match" => {
            out.existing_matches.push(attrs);
        }
        "pending-identity" => {
            out.pending_identity_attrs = Some(attrs);
            if !is_empty_element {
                *in_pending_identity = true;
            }
        }
        "condition" if *in_pending_identity => {
            out.pending_conditions.push(attrs);
        }
        "report" => {
            let id = attrs.get("id").map(String::as_str).unwrap_or_default();
            let is_synthesized = id.starts_with("captured-buttons");
            if !is_synthesized {
                out.preserved_reports.push(attrs);
            }
        }
        "input" => {
            let mut existing_sources = Vec::new();
            if let Some(report) = attrs
                .get("report")
                .filter(|r| !r.starts_with("captured-buttons"))
            {
                let mut inline_src = BTreeMap::new();
                inline_src.insert("report".into(), report.clone());
                for key in [
                    "page", "usage", "engine", "field", "offset", "bit", "width", "equals",
                ] {
                    if let Some(val) = attrs.get(key) {
                        inline_src.insert(key.into(), val.clone());
                    }
                }
                existing_sources.push(inline_src);
            }
            let node = DraftInputNode {
                attrs,
                capture_attrs: None,
                existing_sources,
            };
            if is_empty_element {
                out.inputs.push(node);
            } else {
                *current_input = Some(node);
            }
        }
        "source" => {
            if let Some(input) = current_input.as_mut() {
                let report = attrs.get("report").map(String::as_str).unwrap_or_default();
                if !report.starts_with("captured-buttons") {
                    input.existing_sources.push(attrs);
                }
            }
        }
        "hid-capture" => {
            if let Some(input) = current_input.as_mut() {
                input.capture_attrs = Some(attrs);
            }
        }
        "voice" => {
            out.voices.push(attrs);
        }
        _ => {}
    }
}

fn collect_hotzone_fallback(
    attrs: &BTreeMap<String, String>,
    fallback_hotzones: &mut Vec<(String, String)>,
) {
    if let Some(key) = attrs
        .get("data-ak-key")
        .or_else(|| attrs.get("data-ak-region"))
    {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            let label = attrs
                .get("aria-label")
                .cloned()
                .unwrap_or_else(|| trimmed.to_string());
            fallback_hotzones.push((trimmed.to_string(), label));
        }
    }
}

fn check_safe_element(local: &str, attrs: &BTreeMap<String, String>) -> Result<(), String> {
    if local.eq_ignore_ascii_case("script") {
        return Err("SVG 中禁止包含 <script> 元素。".into());
    }
    if attrs
        .keys()
        .any(|key| key.to_ascii_lowercase().starts_with("on"))
    {
        return Err("SVG 中禁止包含事件处理属性。".into());
    }
    Ok(())
}

fn collect_existing_captures(
    inputs: &[DraftInputNode],
) -> Result<BTreeMap<String, ResolvedSample>, String> {
    let mut map = BTreeMap::new();
    for node in inputs {
        let Some(id) = node.attrs.get("id") else {
            continue;
        };
        let Some(cap) = &node.capture_attrs else {
            continue;
        };
        let Some(press_raw) = cap.get("press") else {
            continue;
        };
        let Ok(press_bytes) = parse_hex_bytes(press_raw) else {
            continue;
        };
        let release_bytes = cap
            .get("release")
            .and_then(|r| parse_hex_bytes(r).ok())
            .unwrap_or_else(|| {
                let mut z = vec![0u8; press_bytes.len()];
                z[0] = press_bytes[0];
                z
            });
        if press_bytes != release_bytes {
            map.insert(
                id.clone(),
                ResolvedSample {
                    report_id: press_bytes[0],
                    press_hex: format_hex(&press_bytes),
                    release_hex: format_hex(&release_bytes),
                    press_bytes,
                    release_bytes,
                },
            );
        }
    }
    Ok(map)
}

fn detect_collisions(
    inputs: &[DraftInputNode],
    samples: &BTreeMap<String, ResolvedSample>,
) -> Vec<CaptureCollisionWarning> {
    let mut first_seen: BTreeMap<(u8, String), String> = BTreeMap::new();
    let mut warnings = Vec::new();

    for node in inputs {
        let Some(id) = node.attrs.get("id") else {
            continue;
        };
        let Some(sample) = samples.get(id) else {
            continue;
        };
        let key = (sample.report_id, sample.press_hex.clone());
        if let Some(first_id) = first_seen.get(&key) {
            warnings.push(CaptureCollisionWarning {
                first_input_id: first_id.clone(),
                second_input_id: id.clone(),
                report_id: sample.report_id,
                press_hex: sample.press_hex.clone(),
            });
        } else {
            first_seen.insert(key, id.clone());
        }
    }
    warnings
}

fn synthesize_reports(
    samples: &BTreeMap<String, ResolvedSample>,
) -> Result<BTreeMap<(u8, usize), SynthesizedReport>, String> {
    let mut grouped: BTreeMap<(u8, usize), Vec<&ResolvedSample>> = BTreeMap::new();
    for sample in samples.values() {
        grouped
            .entry((sample.report_id, sample.press_bytes.len()))
            .or_default()
            .push(sample);
    }

    let total_groups = grouped.len();
    let unique_lengths: BTreeSet<usize> = grouped.keys().map(|(_, len)| *len).collect();
    let distinct_lengths = unique_lengths.len() == total_groups;

    let mut result = BTreeMap::new();
    for ((report_id, length), group) in grouped {
        let id = if total_groups == 1 {
            "captured-buttons".to_string()
        } else if distinct_lengths {
            format!("captured-buttons-{length}")
        } else {
            format!("captured-buttons-r{report_id:02x}-{length}")
        };

        let first = group[0];
        let mut prefix_len = length;
        for sample in &group {
            let max_p = common_prefix_len(&first.press_bytes, &sample.press_bytes);
            let max_r = common_prefix_len(&first.press_bytes, &sample.release_bytes);
            prefix_len = prefix_len.min(max_p).min(max_r);
        }
        prefix_len = prefix_len.max(usize::from(length >= 1));
        let prefix = first.press_bytes[..prefix_len]
            .iter()
            .map(|b| format!("0x{b:02X}"))
            .collect::<Vec<_>>()
            .join(" ");

        let mut min_diff = length;
        let mut max_diff = 0usize;
        for sample in &group {
            for idx in 0..length {
                let rel = sample.release_bytes.get(idx).copied().unwrap_or(0);
                if sample.press_bytes[idx] != rel {
                    min_diff = min_diff.min(idx);
                    max_diff = max_diff.max(idx);
                }
            }
        }
        if min_diff >= length {
            return Err(format!(
                "报告组 0x{report_id:02X}（{length} 字节）未检测到有效变化字节。"
            ));
        }

        let span = max_diff - min_diff + 1;
        let (offset, width_bits) = if span <= 8 {
            (min_diff, span * 8)
        } else {
            (0, 0)
        };

        result.insert(
            (report_id, length),
            SynthesizedReport {
                id,
                report_id,
                length,
                prefix,
                offset,
                width_bits,
            },
        );
    }
    Ok(result)
}

fn parse_attr_u32(raw: &str) -> Option<u32> {
    let trimmed = raw.trim();
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        u32::from_str_radix(hex, 16).ok()
    } else {
        trimmed.parse::<u32>().ok()
    }
}

fn retain_compatible_preserved_reports_and_sources(
    internal: &mut ParsedDraftInternal,
    sample_map: &BTreeMap<String, ResolvedSample>,
    reports_by_group: &BTreeMap<(u8, usize), SynthesizedReport>,
) {
    let voice_report_ids: BTreeSet<&str> = internal
        .voices
        .iter()
        .flat_map(|v| {
            [
                "audio-report",
                "control-report",
                "start-report",
                "stop-report",
                "sync-report",
            ]
            .into_iter()
            .filter_map(move |key| v.get(key).map(String::as_str))
        })
        .collect();

    let referenced_by_unrecaptured: BTreeSet<String> = internal
        .inputs
        .iter()
        .filter(|node| {
            node.attrs
                .get("id")
                .is_none_or(|id| !sample_map.contains_key(id))
        })
        .flat_map(|node| {
            node.existing_sources
                .iter()
                .filter_map(|src| src.get("report").cloned())
        })
        .collect();

    internal.preserved_reports.retain(|rep| {
        let id = rep.get("id").map(String::as_str).unwrap_or_default();
        let direction = rep.get("direction").map(String::as_str).unwrap_or("input");
        let encoding = rep.get("encoding").map(String::as_str).unwrap_or_default();
        if direction != "input" || encoding == "gatt-stream" || voice_report_ids.contains(id) {
            return true;
        }
        if !referenced_by_unrecaptured.contains(id) {
            return false;
        }
        let rep_rid = rep
            .get("report-id")
            .and_then(|v| parse_attr_u32(v))
            .and_then(|v| u8::try_from(v).ok());
        let rep_len = rep
            .get("length")
            .and_then(|v| parse_attr_u32(v))
            .map(|v| v as usize);
        !reports_by_group.keys().any(|&(syn_rid, syn_len)| {
            rep_rid.is_none_or(|r| r == syn_rid) && rep_len.is_none_or(|l| l == syn_len)
        })
    });

    let retained_ids: BTreeSet<String> = internal
        .preserved_reports
        .iter()
        .filter_map(|rep| rep.get("id").cloned())
        .collect();

    for node in &mut internal.inputs {
        node.existing_sources.retain(|src| {
            src.get("report")
                .is_some_and(|report_id| retained_ids.contains(report_id))
        });
    }
}

fn source_layout_for_sample(
    report: &SynthesizedReport,
    sample: &ResolvedSample,
) -> Result<(usize, usize, String), String> {
    let (offset, width_bits) = if report.width_bits > 0 {
        (report.offset, report.width_bits)
    } else {
        let mut min_i = sample.press_bytes.len();
        let mut max_i = 0usize;
        for idx in 0..sample.press_bytes.len() {
            let rel = sample.release_bytes.get(idx).copied().unwrap_or(0);
            if sample.press_bytes[idx] != rel {
                min_i = min_i.min(idx);
                max_i = max_i.max(idx);
            }
        }
        let span = (max_i.saturating_sub(min_i) + 1).min(8);
        (min_i, span * 8)
    };

    let pressed_val = read_le_bits(&sample.press_bytes, offset, width_bits)
        .ok_or_else(|| "按键字节偏移超出报告长度".to_string())?;
    let hex_digits = width_bits / 4;
    let equals = format!("0x{pressed_val:0width$X}", width = hex_digits);
    Ok((offset, width_bits, equals))
}

fn read_le_bits(bytes: &[u8], offset: usize, width_bits: usize) -> Option<u64> {
    if width_bits == 0 || width_bits > 64 {
        return None;
    }
    let mut value = 0u64;
    for bit_idx in 0..width_bits {
        let byte = *bytes.get(offset + bit_idx / 8)?;
        value |= u64::from((byte >> (bit_idx % 8)) & 1) << bit_idx;
    }
    Some(value)
}

fn common_prefix_len(a: &[u8], b: &[u8]) -> usize {
    a.iter()
        .zip(b.iter())
        .take_while(|(left, right)| left == right)
        .count()
}

fn build_identity_matches(
    internal: &ParsedDraftInternal,
    candidate: Option<&CaptureCandidate>,
) -> (Vec<BTreeMap<String, String>>, bool) {
    if let Some(cand) = candidate {
        let mut attrs = BTreeMap::new();
        let upper_id = cand.instance_id.to_ascii_uppercase();
        let transport = match cand.transport.as_str() {
            "bluetooth-le" | "bluetooth-hid" => "bluetooth-hid",
            "usb-hid" => "usb-hid",
            _ => "hid",
        };
        attrs.insert("transport".into(), transport.into());

        let vid_str = extract_raw_hex_token(&upper_id, "VID")
            .map(|raw| format!("0x{raw}"))
            .or_else(|| cand.vid.map(|v| format!("0x{v:04X}")))
            .unwrap_or_else(|| "0x0000".into());
        let pid_str = extract_raw_hex_token(&upper_id, "PID")
            .map(|raw| format!("0x{raw}"))
            .or_else(|| cand.pid.map(|p| format!("0x{p:04X}")))
            .unwrap_or_else(|| "0x0000".into());
        attrs.insert("vid".into(), vid_str);
        attrs.insert("pid".into(), pid_str);

        if upper_id.starts_with("BTHLEDEVICE") {
            attrs.insert("windows-prefix".into(), "BTHLEDEVICE".into());
            if upper_id.contains("00001812-0000-1000-8000-00805F9B34FB") {
                attrs.insert(
                    "service".into(),
                    "00001812-0000-1000-8000-00805F9B34FB".into(),
                );
            }
        } else if upper_id.starts_with("HID\\") {
            attrs.insert("windows-prefix".into(), "HID".into());
            if let (Some(page), Some(usage)) = (cand.usage_page, cand.usage) {
                attrs.insert("usage-page".into(), format!("0x{page:02X}"));
                attrs.insert("usage".into(), format!("0x{usage:02X}"));
            }
        }

        let mut has_gatt_filter = false;
        if let Some(gatt) = &cand.gatt_info {
            if let Some(model) = gatt.model_number.as_deref().filter(|s| !s.is_empty()) {
                attrs.insert("model-contains".into(), model.to_string());
                has_gatt_filter = true;
            }
            if let Some(mfg) = gatt.manufacturer.as_deref().filter(|s| !s.is_empty()) {
                attrs.insert("manufacturer-contains".into(), mfg.to_string());
                has_gatt_filter = true;
            }
        }
        for cond in &internal.pending_conditions {
            if let (Some(field), Some(contains)) = (cond.get("field"), cond.get("contains")) {
                match field.as_str() {
                    "modelNumber" if !attrs.contains_key("model-contains") => {
                        attrs.insert("model-contains".into(), contains.clone());
                        has_gatt_filter = true;
                    }
                    "manufacturer" if !attrs.contains_key("manufacturer-contains") => {
                        attrs.insert("manufacturer-contains".into(), contains.clone());
                        has_gatt_filter = true;
                    }
                    "softwareRevision" if !attrs.contains_key("software-contains") => {
                        attrs.insert("software-contains".into(), contains.clone());
                        has_gatt_filter = true;
                    }
                    _ => {}
                }
            }
        }

        if has_gatt_filter {
            attrs.insert("information-required".into(), "true".into());
        } else {
            attrs.insert("required".into(), "true".into());
        }
        return (vec![attrs], false);
    }

    if !internal.existing_matches.is_empty() {
        return (internal.existing_matches.clone(), false);
    }

    if let Some(pending) = &internal.pending_identity_attrs {
        let mut attrs = BTreeMap::new();
        attrs.insert("transport".into(), "bluetooth-hid".into());
        let hw = pending
            .get("hardware-id")
            .map(|s| s.to_ascii_uppercase())
            .unwrap_or_default();
        let vid = extract_raw_hex_token(&hw, "VID")
            .map(|raw| format!("0x{raw}"))
            .or_else(|| pending.get("vid").cloned())
            .unwrap_or_else(|| "0x0000".into());
        let pid = extract_raw_hex_token(&hw, "PID")
            .map(|raw| format!("0x{raw}"))
            .or_else(|| pending.get("pid").cloned())
            .unwrap_or_else(|| "0x0000".into());
        attrs.insert("vid".into(), vid);
        attrs.insert("pid".into(), pid);
        if hw.contains("DEV_VID&") {
            attrs.insert("windows-prefix".into(), "BTHLEDEVICE".into());
            attrs.insert(
                "service".into(),
                "00001812-0000-1000-8000-00805F9B34FB".into(),
            );
        }
        let mut has_cond = false;
        for cond in &internal.pending_conditions {
            if let (Some(field), Some(contains)) = (cond.get("field"), cond.get("contains")) {
                match field.as_str() {
                    "modelNumber" => {
                        attrs.insert("model-contains".into(), contains.clone());
                        has_cond = true;
                    }
                    "manufacturer" => {
                        attrs.insert("manufacturer-contains".into(), contains.clone());
                        has_cond = true;
                    }
                    "softwareRevision" => {
                        attrs.insert("software-contains".into(), contains.clone());
                        has_cond = true;
                    }
                    _ => {}
                }
            }
        }
        if has_cond {
            attrs.insert("information-required".into(), "true".into());
        } else {
            attrs.insert("required".into(), "true".into());
        }
        return (vec![attrs], false);
    }

    let mut fallback = BTreeMap::new();
    fallback.insert("transport".into(), "hid".into());
    fallback.insert("vid".into(), "0x0000".into());
    fallback.insert("pid".into(), "0x0000".into());
    fallback.insert("required".into(), "true".into());
    (vec![fallback], true)
}

fn extract_raw_hex_token(upper: &str, key: &str) -> Option<String> {
    let tokens: Vec<&str> = upper
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    tokens.windows(2).find_map(|pair| {
        (pair[0] == key && pair[1].bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| pair[1].to_string())
    })
}

#[allow(clippy::too_many_arguments)]
fn render_metadata_xml(
    device_id: &str,
    vendor: &str,
    model: &str,
    revision: u32,
    display_name: &str,
    status: &str,
    identity_matches: &[BTreeMap<String, String>],
    reports: &BTreeMap<(u8, usize), SynthesizedReport>,
    preserved_reports: &[BTreeMap<String, String>],
    inputs: &[DraftInputNode],
    svg_ids: &BTreeSet<String>,
    samples: &BTreeMap<String, ResolvedSample>,
    voices: &[BTreeMap<String, String>],
) -> Result<String, String> {
    let mut xml = String::new();
    xml.push_str("  <metadata>\n");
    xml.push_str(&format!(
        "    <ak:device schema=\"{SCHEMA}\" id=\"{}\" vendor=\"{}\" model=\"{}\" revision=\"{revision}\" display-name=\"{}\" status=\"{status}\">\n",
        escape_xml(device_id),
        escape_xml(vendor),
        escape_xml(model),
        escape_xml(display_name),
    ));

    xml.push_str("      <ak:identity>\n");
    for m in identity_matches {
        xml.push_str("        <ak:match");
        for key in [
            "transport",
            "vid",
            "pid",
            "usage-page",
            "usage",
            "service",
            "windows-prefix",
            "serial-policy",
            "information-required",
            "model-contains",
            "manufacturer-contains",
            "software-contains",
            "required",
        ] {
            if let Some(val) = m.get(key) {
                xml.push_str(&format!(" {key}=\"{}\"", escape_xml(val)));
            }
        }
        for (key, val) in m {
            if ![
                "transport",
                "vid",
                "pid",
                "usage-page",
                "usage",
                "service",
                "windows-prefix",
                "serial-policy",
                "information-required",
                "model-contains",
                "manufacturer-contains",
                "software-contains",
                "required",
            ]
            .contains(&key.as_str())
            {
                xml.push_str(&format!(" {key}=\"{}\"", escape_xml(val)));
            }
        }
        xml.push_str(" />\n");
    }
    xml.push_str("      </ak:identity>\n");

    xml.push_str("      <ak:reports>\n");
    if !reports.is_empty() {
        xml.push_str(
            "        <!-- Captured bytes define these layouts; HID Usage Page remains unverified. -->\n",
        );
    }
    for report in reports.values() {
        xml.push_str(&format!(
            "        <ak:report id=\"{}\" direction=\"input\" report-id=\"0x{:02X}\" length=\"{}\" encoding=\"bit-field\" prefix=\"{}\" state-group=\"{}\" />\n",
            escape_xml(&report.id),
            report.report_id,
            report.length,
            escape_xml(&report.prefix),
            escape_xml(&report.id),
        ));
    }
    for preserved in preserved_reports {
        xml.push_str("        <ak:report");
        for (k, v) in preserved {
            xml.push_str(&format!(" {k}=\"{}\"", escape_xml(v)));
        }
        xml.push_str(" />\n");
    }
    xml.push_str("      </ak:reports>\n");

    xml.push_str("      <ak:inputs>\n");
    for (idx, node) in inputs.iter().enumerate() {
        let id = node.attrs.get("id").cloned().unwrap_or_default();
        let label = node
            .attrs
            .get("label")
            .cloned()
            .unwrap_or_else(|| id.clone());
        let kind = node
            .attrs
            .get("kind")
            .cloned()
            .unwrap_or_else(|| "button".into());
        let original = node
            .attrs
            .get("original")
            .cloned()
            .unwrap_or_else(|| "false".into());

        let sample = samples.get(&id);
        let binding = if sample.is_some() || !node.existing_sources.is_empty() {
            "captured"
        } else {
            "pending"
        };

        xml.push_str(&format!(
            "        <ak:input id=\"{}\" label=\"{}\"",
            escape_xml(&id),
            escape_xml(&label)
        ));
        if let Some(short) = node.attrs.get("short") {
            xml.push_str(&format!(" short=\"{}\"", escape_xml(short)));
        }
        if let Some(icon) = node.attrs.get("icon") {
            xml.push_str(&format!(" icon=\"{}\"", escape_xml(icon)));
        }
        xml.push_str(&format!(" kind=\"{}\"", escape_xml(&kind)));
        if let Some(target) = node.attrs.get("target") {
            if let Some(stripped) = target.strip_prefix('#') {
                if svg_ids.contains(stripped) {
                    xml.push_str(&format!(" target=\"{}\"", escape_xml(target)));
                }
            }
        }
        let order = node
            .attrs
            .get("order")
            .cloned()
            .unwrap_or_else(|| idx.to_string());
        xml.push_str(&format!(
            " order=\"{}\" original=\"{}\" binding=\"{binding}\"",
            escape_xml(&order),
            escape_xml(&original)
        ));
        if let Some(legacy_key) = node.attrs.get("legacy-key") {
            xml.push_str(&format!(" legacy-key=\"{}\"", escape_xml(legacy_key)));
        }

        if let Some(sample) = sample {
            let report = reports
                .get(&(sample.report_id, sample.press_bytes.len()))
                .ok_or_else(|| format!("未找到按键 {id} 对应的合成报告组"))?;
            let (offset, width_bits, equals) = source_layout_for_sample(report, sample)?;
            xml.push_str(">");
            xml.push_str(&format!(
                "<ak:source report=\"{}\" offset=\"{offset}\" bit=\"0\" width=\"{width_bits}\" equals=\"{equals}\"/>",
                escape_xml(&report.id)
            ));
            xml.push_str(&format!(
                "<ak:hid-capture version=\"1\" press=\"{}\" press-length=\"{}\" release=\"{}\" release-length=\"{}\"/>",
                escape_xml(&sample.press_hex),
                sample.press_bytes.len(),
                escape_xml(&sample.release_hex),
                sample.release_bytes.len(),
            ));
            xml.push_str("</ak:input>\n");
        } else if !node.existing_sources.is_empty() {
            xml.push_str(">");
            for src in &node.existing_sources {
                xml.push_str("<ak:source");
                for (k, v) in src {
                    xml.push_str(&format!(" {k}=\"{}\"", escape_xml(v)));
                }
                xml.push_str("/>");
            }
            xml.push_str("</ak:input>\n");
        } else {
            xml.push_str("/>\n");
        }
    }
    xml.push_str("      </ak:inputs>\n");

    let input_id_set: BTreeSet<&str> = inputs
        .iter()
        .filter_map(|n| n.attrs.get("id").map(String::as_str))
        .collect();
    for voice in voices {
        if voice
            .get("trigger-key")
            .is_some_and(|tk| input_id_set.contains(tk.as_str()))
        {
            xml.push_str("      <ak:voice");
            for (k, v) in voice {
                xml.push_str(&format!(" {k}=\"{}\"", escape_xml(v)));
            }
            xml.push_str(" />\n");
        }
    }

    xml.push_str("    </ak:device>\n");
    xml.push_str("  </metadata>");
    Ok(xml)
}

fn splice_svg_document(
    draft_svg: &str,
    device_id: &str,
    revision: u32,
    status: &str,
    metadata_xml: &str,
) -> Result<String, String> {
    let svg_open_start = draft_svg
        .find("<svg")
        .ok_or_else(|| "未在文档中找到 <svg> 标签。".to_string())?;
    let svg_open_rel_end = draft_svg[svg_open_start..]
        .find('>')
        .ok_or_else(|| "未闭合的 <svg> 起始标签。".to_string())?;
    let svg_open_end = svg_open_start + svg_open_rel_end;
    let raw_svg_tag = &draft_svg[svg_open_start..=svg_open_end];
    let is_self_closing = raw_svg_tag.trim_end().ends_with("/>");

    let updated_svg_open = rewrite_root_svg_tag(raw_svg_tag, device_id, revision, status)?;
    if is_self_closing {
        let open_normal = updated_svg_open
            .trim_end()
            .trim_end_matches("/>")
            .to_string()
            + ">";
        return Ok(format!(
            "{}{open_normal}\n{metadata_xml}\n</svg>\n",
            &draft_svg[..svg_open_start]
        ));
    }

    let body = &draft_svg[svg_open_end + 1..];
    if let (Some(meta_start), Some(meta_end_rel)) =
        (body.find("<metadata"), body.find("</metadata>"))
    {
        if meta_start < meta_end_rel {
            let after_meta = &body[meta_end_rel + "</metadata>".len()..];
            return Ok(format!(
                "{}{updated_svg_open}{}{metadata_xml}{after_meta}",
                &draft_svg[..svg_open_start],
                &body[..meta_start]
            ));
        }
    }

    Ok(format!(
        "{}{updated_svg_open}\n{metadata_xml}{body}",
        &draft_svg[..svg_open_start]
    ))
}

fn rewrite_root_svg_tag(
    raw_svg_tag: &str,
    device_id: &str,
    revision: u32,
    status: &str,
) -> Result<String, String> {
    let probe = if raw_svg_tag.trim_end().ends_with("/>") {
        raw_svg_tag.to_string()
    } else {
        format!("{raw_svg_tag}</svg>")
    };
    let mut reader = Reader::from_str(&probe);
    let attrs = match reader.read_event().map_err(|e| e.to_string())? {
        Event::Start(el) | Event::Empty(el) => ordered_attributes(&el)?,
        _ => return Err("解析 <svg> 根属性失败".into()),
    };

    let mut out = Vec::new();
    let upsert = |list: &mut Vec<(String, String)>, key: &str, val: String| {
        if let Some(existing) = list.iter_mut().find(|(k, _)| k == key) {
            existing.1 = val;
        } else {
            list.push((key.to_string(), val));
        }
    };

    for (k, v) in attrs {
        out.push((k, v));
    }
    upsert(&mut out, "xmlns", SVG_NS.into());
    upsert(&mut out, "xmlns:ak", AK_NS.into());
    upsert(&mut out, "data-ak-schema", SCHEMA.into());
    upsert(&mut out, "data-ak-device", device_id.to_string());
    upsert(&mut out, "data-ak-revision", revision.to_string());
    upsert(&mut out, "data-ak-status", status.to_string());

    let rendered_attrs = out
        .into_iter()
        .map(|(k, v)| format!("{k}=\"{}\"", escape_xml(&v)))
        .collect::<Vec<_>>()
        .join(" ");
    let suffix = if raw_svg_tag.trim_end().ends_with("/>") {
        "/>"
    } else {
        ">"
    };
    Ok(format!("<svg {rendered_attrs}{suffix}"))
}

#[allow(clippy::too_many_arguments)]
fn render_markdown_summary(
    display_name: &str,
    device_id: &str,
    status: &str,
    candidate: Option<&CaptureCandidate>,
    used_placeholder_identity: bool,
    reports: &BTreeMap<(u8, usize), SynthesizedReport>,
    inputs: &[DraftInputNode],
    samples: &BTreeMap<String, ResolvedSample>,
    collisions: &[CaptureCollisionWarning],
    adapted_count: usize,
    pending_count: usize,
) -> String {
    let mut md = String::new();
    md.push_str(&format!(
        "# {display_name}（`{device_id}`）按键采集摘要\n\n"
    ));
    md.push_str(&format!("- 描述状态：`{status}`\n"));
    md.push_str(&format!(
        "- 适配进度：已采集 **{adapted_count}** 键，待采集 **{pending_count}** 键\n"
    ));
    if let Some(cand) = candidate {
        md.push_str(&format!(
            "- 采集设备：`{}`（`{}`，传输 `{}`）\n",
            cand.display_name, cand.instance_id, cand.transport
        ));
        if let (Some(v), Some(p)) = (cand.vid, cand.pid) {
            md.push_str(&format!("- 硬件标识：`VID=0x{v:04X}` `PID=0x{p:04X}`\n"));
        }
    } else if used_placeholder_identity {
        md.push_str(
            "- 注意：当前未传入实体候选设备，`ak:identity` 使用占位 `0x0000:0x0000`，合入正式设备库前请补充真实硬件匹配条件。\n",
        );
    }

    if !reports.is_empty() {
        md.push_str("\n## 报告布局\n\n");
        for report in reports.values() {
            md.push_str(&format!(
                "- `{}`：Report ID `0x{:02X}`，长度 `{}` 字节，固定前缀 `{}`\n",
                report.id, report.report_id, report.length, report.prefix
            ));
        }
    }

    if !collisions.is_empty() {
        md.push_str("\n## 按键冲突提示\n\n");
        for c in collisions {
            md.push_str(&format!(
                "- `{}` 与 `{}` 产生了相同的按下报文 `{}`（Report `0x{:02X}`）\n",
                c.first_input_id, c.second_input_id, c.press_hex, c.report_id
            ));
        }
    }

    md.push_str("\n## 按键样本清单\n\n");
    md.push_str("| 按键 ID | 名称 | 状态 | 按下报文 | 松开报文 |\n");
    md.push_str("| --- | --- | --- | --- | --- |\n");
    for node in inputs {
        let id = node.attrs.get("id").map(String::as_str).unwrap_or_default();
        let label = node.attrs.get("label").map(String::as_str).unwrap_or(id);
        if let Some(sample) = samples.get(id) {
            md.push_str(&format!(
                "| `{id}` | {label} | `captured` | `{}` | `{}` |\n",
                sample.press_hex, sample.release_hex
            ));
        } else {
            md.push_str(&format!("| `{id}` | {label} | `pending` | — | — |\n"));
        }
    }
    md
}

fn ordered_attributes(el: &BytesStart<'_>) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for attr in el.attributes().with_checks(false) {
        let attr = attr.map_err(|e| format!("无效的 XML 属性：{e}"))?;
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let val = attr
            .normalized_value(XmlVersion::default())
            .map_err(|e| format!("无效的 XML 属性值：{e}"))?
            .into_owned();
        out.push((key, val));
    }
    Ok(out)
}

fn find_attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a String> {
    attrs.iter().find_map(|(k, v)| (k == key).then_some(v))
}

fn local_name(qname: &str) -> String {
    qname.rsplit(':').next().unwrap_or(qname).to_string()
}

fn escape_xml(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_capture::{CaptureGattInfo, CaptureSafetyTier};
    use crate::devices::descriptor_registry::KINDS;
    use crate::devices::engine::DescriptorEngine;

    const DRAFT_FIXTURE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:ak="urn:axonkey:device:1" width="420" height="880" viewBox="0 0 420 880" data-ak-schema="axonkey.device/1" data-ak-device="demo-remote" data-ak-revision="1" data-ak-status="draft">
  <title id="device-title">测试遥控器</title>
  <metadata>
    <ak:device schema="axonkey.device/1" id="demo-remote" vendor="Demo" model="R1" revision="1" display-name="Demo R1" status="draft">
      <ak:inputs>
        <ak:input id="demo-remote.power" label="电源" icon="power" kind="button" target="#key-power" order="0" original="false" binding="pending"/>
        <ak:input id="demo-remote.back" label="返回" icon="back" kind="button" target="#key-back" order="1" original="false" binding="pending"/>
        <ak:input id="demo-remote.home" label="主页" icon="home" kind="button" target="#key-home" order="2" original="false" binding="pending"/>
        <ak:input id="demo-remote.voice" label="语音" icon="mic" kind="button" target="#key-voice" order="3" original="false" binding="pending"/>
      </ak:inputs>
    </ak:device>
  </metadata>
  <g id="front-view" data-ak-view="front">
    <g id="key-power" data-ak-key="demo-remote.power"><circle cx="60" cy="80" r="20"/></g>
    <g id="key-back" data-ak-key="demo-remote.back"><circle cx="60" cy="180" r="20"/></g>
    <g id="key-home" data-ak-key="demo-remote.home"><circle cx="160" cy="180" r="20"/></g>
    <g id="key-voice" data-ak-key="demo-remote.voice"><circle cx="260" cy="180" r="20"/></g>
  </g>
</svg>"##;

    fn sample(id: &str, report_id: u8, press: &str, release: &str) -> CapturedKeySample {
        let press_len = press.split_whitespace().count();
        let release_len = release.split_whitespace().count();
        CapturedKeySample {
            input_id: id.into(),
            report_id,
            press_hex: press.into(),
            release_hex: release.into(),
            press_length: press_len,
            release_length: release_len,
            hold_count: 2,
            duration_ms: 120,
        }
    }

    #[test]
    fn parses_draft_svg_inputs_and_existing_captures() {
        let parsed = parse_draft_svg(DRAFT_FIXTURE).unwrap();
        assert_eq!(parsed.device_id, "demo-remote");
        assert_eq!(parsed.display_name, "Demo R1");
        assert_eq!(parsed.vendor.as_deref(), Some("Demo"));
        assert_eq!(parsed.model.as_deref(), Some("R1"));
        assert_eq!(parsed.status, "draft");
        assert_eq!(parsed.inputs.len(), 4);
        assert_eq!(parsed.inputs[0].id, "demo-remote.power");
        assert_eq!(parsed.inputs[0].binding, "pending");

        let rc802a = include_str!("../../../docs/device-drafts/tcl-rc802a.svg");
        let parsed_rc802a = parse_draft_svg(rc802a).unwrap();
        assert_eq!(parsed_rc802a.device_id, "tcl-rc802a");
        assert_eq!(parsed_rc802a.inputs.len(), 22);
        assert_eq!(parsed_rc802a.inputs[0].binding, "captured");
        assert_eq!(
            parsed_rc802a.inputs[0].press_hex.as_deref(),
            Some("01 00 00 EF 00 00 00 00 00")
        );
    }

    #[test]
    fn compiles_mixed_9byte_and_3byte_reports_and_decodes_via_descriptor_engine() {
        let candidate = CaptureCandidate {
            target_id: "ble:db1r".into(),
            display_name: "斐讯 DB1-R".into(),
            transport: "bluetooth-le".into(),
            instance_id: r"BTHLEDEVICE\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&01005D_PID&0001_REV&0001_112233445566\8&1&0&1".into(),
            vid: Some(0x005D),
            pid: Some(0x0001),
            usage_page: Some(0x0C),
            usage: Some(0x01),
            bound_to_quarbor: true,
            recovery_active: true,
            registered_kind: None,
            safety_tier: CaptureSafetyTier::Safe,
            safety_reason: None,
            gatt_info: Some(CaptureGattInfo {
                manufacturer: Some("PHICOMM".into()),
                model_number: Some("DB1-R".into()),
                software_revision: None,
                bluetooth_address: Some("11:22:33:44:55:66".into()),
            }),
            ancestors: Vec::new(),
        };

        // Mix of 9-byte report 0x01 and 3-byte LE consumer report 0x02 (just like phicomm-db1-r.svg),
        // leaving `demo-remote.voice` uncaptured (`binding="pending"`).
        let samples = vec![
            sample(
                "demo-remote.power",
                0x01,
                "01 00 00 66 00 00 00 00 00",
                "01 00 00 00 00 00 00 00 00",
            ),
            sample("demo-remote.back", 0x02, "02 24 02", "02 00 00"),
            sample("demo-remote.home", 0x02, "02 E9 00", "02 00 00"),
        ];

        let compiled =
            compile_svg(DRAFT_FIXTURE, Some(&candidate), &samples, Some("active")).unwrap();
        assert!(compiled.validated);
        assert_eq!(compiled.adapted_count, 3);
        assert_eq!(compiled.pending_count, 1);
        assert!(compiled.collisions.is_empty());
        assert!(compiled.svg_content.contains("vid=\"0x01005D\""));
        assert!(compiled
            .svg_content
            .contains("windows-prefix=\"BTHLEDEVICE\""));
        assert!(compiled.svg_content.contains("model-contains=\"DB1-R\""));
        // SVG artwork outside <metadata> must remain intact
        assert!(compiled
            .svg_content
            .contains("<g id=\"front-view\" data-ak-view=\"front\">"));

        // Feed real HID packets into DescriptorEngine to verify press/release edge decoding!
        let descriptor = parse_svg(&compiled.svg_content).unwrap();
        let mut engine = DescriptorEngine::default();

        assert_eq!(
            engine.accept(&descriptor, &[0x01, 0, 0, 0x66, 0, 0, 0, 0, 0]),
            vec![("demo-remote.power".into(), true)]
        );
        assert_eq!(
            engine.accept(&descriptor, &[0x01, 0, 0, 0, 0, 0, 0, 0, 0]),
            vec![("demo-remote.power".into(), false)]
        );
        assert_eq!(
            engine.accept(&descriptor, &[0x02, 0x24, 0x02]),
            vec![("demo-remote.back".into(), true)]
        );
        // Verify [0x02, 0xE9, 0x02] does NOT falsely match home ([0x02, 0xE9, 0x00]) because width="16"!
        assert_eq!(
            engine.accept(&descriptor, &[0x02, 0xE9, 0x02]),
            vec![("demo-remote.back".into(), false)]
        );
        assert_eq!(
            engine.accept(&descriptor, &[0x02, 0xE9, 0x00]),
            vec![("demo-remote.home".into(), true)]
        );
        assert_eq!(
            engine.accept(&descriptor, &[0x02, 0x00, 0x00]),
            vec![("demo-remote.home".into(), false)]
        );
        let _ = KINDS;
    }

    #[test]
    fn detects_duplicate_key_collisions_and_supports_offline_pending_identity() {
        let collisions_samples = vec![
            sample(
                "demo-remote.power",
                0x01,
                "01 00 00 EF 00 00 00 00 00",
                "01 00 00 00 00 00 00 00 00",
            ),
            sample(
                "demo-remote.back",
                0x01,
                "01 00 00 EF 00 00 00 00 00",
                "01 00 00 00 00 00 00 00 00",
            ),
        ];
        let compiled = compile_svg(DRAFT_FIXTURE, None, &collisions_samples, None).unwrap();
        assert!(compiled.validated);
        assert_eq!(compiled.collisions.len(), 1);
        assert_eq!(compiled.collisions[0].first_input_id, "demo-remote.power");
        assert_eq!(compiled.collisions[0].second_input_id, "demo-remote.back");

        // Also test promoting docs/device-drafts/tcl-rc802a.svg (<ak:pending-identity>) offline!
        let rc802a_draft = include_str!("../../../docs/device-drafts/tcl-rc802a.svg");
        let promoted = compile_svg(rc802a_draft, None, &[], Some("active")).unwrap();
        assert!(promoted.validated);
        assert_eq!(promoted.adapted_count, 22);
        assert_eq!(promoted.pending_count, 0);
        let descriptor = parse_svg(&promoted.svg_content).unwrap();
        let mut engine = DescriptorEngine::default();
        assert_eq!(
            engine.accept(&descriptor, &[0x01, 0, 0, 0xEF, 0, 0, 0, 0, 0]),
            vec![("tcl-rc802a.mute".into(), true)]
        );
    }

    #[test]
    fn recapturing_existing_descriptor_replaces_old_input_reports_without_engine_ambiguity() {
        // Recompiling hisense-rcf3b65.svg (which has non-standard `id="captured-pointer"` for 0x6F)
        // must drop the old `captured-pointer` report so 0x6F has exactly 1 matching input report.
        let hisense = include_str!("../../../public/device-descriptors/hisense-rcf3b65.svg");
        let recompiled_hisense = compile_svg(hisense, None, &[], Some("active")).unwrap();
        assert!(recompiled_hisense.validated);
        assert!(!recompiled_hisense
            .svg_content
            .contains("id=\"captured-pointer\""));
        let hisense_desc = parse_svg(&recompiled_hisense.svg_content).unwrap();
        let mut hisense_engine = DescriptorEngine::default();
        assert_eq!(
            hisense_engine.accept(&hisense_desc, &[0x6F, 0x6A, 0x01, 0, 0, 0, 0, 0, 0]),
            vec![("hisense-rcf3b65.pointer".into(), true)]
        );
        assert_eq!(
            hisense_engine.accept(&hisense_desc, &[0x6F, 0x6A, 0x00, 0, 0, 0, 0, 0, 0]),
            vec![("hisense-rcf3b65.pointer".into(), false)]
        );

        // Recapturing a key on rc003.svg (which has `id="keyboard-header"` 9-byte 0x01 AND `gatt-stream` `voice-audio`)
        // must preserve `voice-audio` while dropping colliding 9-byte 0x01 input reports so DescriptorEngine decodes cleanly.
        let rc003 = include_str!("../../../public/device-descriptors/rc003.svg");
        let recaptured = compile_svg(
            rc003,
            None,
            &[sample(
                "xiaomi.rc003.power",
                0x01,
                "01 00 00 66 00 00 00 00 00",
                "01 00 00 00 00 00 00 00 00",
            )],
            Some("draft"),
        )
        .unwrap();
        assert!(recaptured.validated);
        assert!(recaptured.svg_content.contains("id=\"voice-audio\""));
        let rc003_desc = parse_svg(&recaptured.svg_content).unwrap();
        let mut rc003_engine = DescriptorEngine::default();
        assert_eq!(
            rc003_engine.accept(&rc003_desc, &[0x01, 0, 0, 0x66, 0, 0, 0, 0, 0]),
            vec![("xiaomi.rc003.power".into(), true)]
        );
    }

    #[test]
    fn cleared_single_and_all_key_drafts_compile_cleanly_without_intercepting_cleared_keys() {
        let rc902n = include_str!("../../../public/device-descriptors/tcl-rc902n.svg");
        let single_cleared = rc902n.replace(
            r##"<ak:input id="tcl-rc902n.bookmark" label="书签图标键" short="书签" icon="center" kind="button" order="3" target="#key-bookmark" original="false" binding="captured"><ak:source report="captured-buttons" offset="1" bit="0" width="16" equals="0x0059"/><ak:hid-capture version="1" press="03 59 00" press-length="3" release="03 00 00" release-length="3"/></ak:input>"##,
            r##"<ak:input id="tcl-rc902n.bookmark" label="书签图标键" short="书签" icon="center" kind="button" order="3" target="#key-bookmark" original="false" binding="pending"/>"##,
        );
        let compiled_21 = compile_svg(&single_cleared, None, &[], Some("draft")).unwrap();
        assert!(compiled_21.validated);
        assert_eq!(compiled_21.adapted_count, 21);
        assert_eq!(compiled_21.pending_count, 1);
        assert!(compiled_21.svg_content.contains("id=\"voice-audio\""));

        let desc_21 = parse_svg(&compiled_21.svg_content).unwrap();
        let mut engine = DescriptorEngine::default();
        assert!(
            engine.accept(&desc_21, &[0x03, 0x59, 0x00]).is_empty(),
            "cleared key must not be intercepted by DescriptorEngine"
        );
        assert_eq!(
            engine.accept(&desc_21, &[0x03, 0x41, 0x00]),
            vec![("tcl-rc902n.confirm".into(), true)]
        );
    }
}
