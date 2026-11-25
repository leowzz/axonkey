use super::protocol::{
    DeckLayoutPatch, DeckSnapshot, DeckZoneKind, EmbeddedPadHeight, EmbeddedPointerMode,
    MobileDeckPage, MobileDeckZone, MobileTile, PageLayout, StarterPresetId, TileAccent,
    TileGestureKind, TileMode, VoicePresetKind,
};
use crate::input_service::{NativeBehavior, TriggerBehaviors};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const MAX_PAGES: usize = 8;
const MAX_TILES_PER_PAGE: usize = 32;
const MAX_ZONES_PER_PAGE: usize = 6;
pub const VOICE_KEY_ID: &str = "mobile.voice";

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TileActionBindings {
    #[serde(default)]
    pub tap: Vec<NativeBehavior>,
    #[serde(default)]
    pub double: Vec<NativeBehavior>,
    #[serde(default)]
    pub long: Vec<NativeBehavior>,
    #[serde(default)]
    pub hold_keys: Vec<String>,
}

impl TileActionBindings {
    pub fn is_empty(&self) -> bool {
        self.tap.is_empty()
            && self.double.is_empty()
            && self.long.is_empty()
            && self.hold_keys.is_empty()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDeck {
    version: u32,
    revision: u64,
    snapshot: DeckSnapshot,
    bindings: HashMap<String, TileActionBindings>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    preset_applied: bool,
}

#[derive(Debug)]
pub struct DeckConflict {
    pub revision: u64,
    pub snapshot: DeckSnapshot,
}

pub enum DeckUpdateError {
    Conflict(DeckConflict),
    Invalid(String),
    Io(String),
}

pub struct DeckStore {
    path: PathBuf,
    revision: u64,
    snapshot: DeckSnapshot,
    bindings: HashMap<String, TileActionBindings>,
    baseline_bindings: HashMap<String, TileActionBindings>,
    preset_applied: bool,
}

impl DeckStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        if path.exists() {
            let bytes =
                fs::read(&path).map_err(|e| format!("Failed to read mobile-deck.json: {e}"))?;
            let persisted: PersistedDeck = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Corrupt mobile-deck.json (refusing silent reset): {e}"))?;
            let baseline_bindings = if persisted.preset_applied {
                persisted.bindings.clone()
            } else {
                default_mobile_deck().1
            };
            let mut store = Self {
                path,
                revision: persisted.revision.max(1),
                snapshot: persisted.snapshot,
                bindings: persisted.bindings,
                baseline_bindings,
                preset_applied: persisted.preset_applied,
            };
            let inserted_default_voice =
                !store.preset_applied && !store.bindings.contains_key(VOICE_KEY_ID);
            if inserted_default_voice {
                store.bindings.insert(
                    VOICE_KEY_ID.into(),
                    TileActionBindings {
                        tap: vec![key("Alt")],
                        ..Default::default()
                    },
                );
            }
            let migrated_remote = store.migrate_stock_classic_remote_layout();
            store.rehydrate_tile_metadata();
            if inserted_default_voice || migrated_remote {
                let _ = store.save();
            }
            return Ok(store);
        }
        let (snapshot, bindings) = default_mobile_deck();
        let baseline_bindings = bindings.clone();
        let mut store = Self {
            path,
            revision: 1,
            snapshot,
            bindings,
            baseline_bindings,
            preset_applied: false,
        };
        store.rehydrate_tile_metadata();
        store.save()?;
        Ok(store)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn pointer_sensitivity(&self) -> f64 {
        self.snapshot.pointer_sensitivity
    }

    pub fn scroll_sensitivity(&self) -> f64 {
        self.snapshot.scroll_sensitivity
    }

    pub fn snapshot(&self) -> DeckSnapshot {
        self.snapshot.clone()
    }

    pub fn bindings(&self) -> HashMap<String, TileActionBindings> {
        self.bindings.clone()
    }

    pub fn resolve_voice_hold_keys(&self) -> Vec<String> {
        let Some(binding) = self.bindings.get(VOICE_KEY_ID) else {
            return Vec::new();
        };
        if !binding.hold_keys.is_empty() {
            return binding.hold_keys.clone();
        }
        // `mobile.voice` exclusively drives `voice.begin` -> `voice.end` hold-to-talk;
        // never let a residual `double` or `long` slot silence `tap`, and fall back to
        // `long` if the user placed their hold-to-talk key only under `长按`.
        for seq in [&binding.tap, &binding.long] {
            let mut extracted = Vec::new();
            for item in seq.iter().filter(|b| b.enabled()) {
                match item {
                    NativeBehavior::Key { key, .. } if !key.trim().is_empty() => {
                        if !extracted.contains(key) {
                            extracted.push(key.clone());
                        }
                    }
                    NativeBehavior::Shortcut { keys, .. } if !keys.is_empty() => {
                        for k in keys {
                            if !k.trim().is_empty() && !extracted.contains(k) {
                                extracted.push(k.clone());
                            }
                        }
                    }
                    _ => {}
                }
            }
            if !extracted.is_empty() {
                return extracted;
            }
        }
        Vec::new()
    }

    pub fn resolve_gesture(
        &self,
        tile_id: &str,
        gesture: TileGestureKind,
    ) -> Option<&[NativeBehavior]> {
        let binding = self.bindings.get(tile_id)?;
        let actions = match gesture {
            TileGestureKind::Tap => &binding.tap,
            TileGestureKind::Double => &binding.double,
            TileGestureKind::Long => &binding.long,
        };
        if actions.is_empty() {
            None
        } else {
            Some(actions.as_slice())
        }
    }

    pub fn resolve_hold_keys(&self, tile_id: &str) -> Option<Vec<String>> {
        let binding = self.bindings.get(tile_id)?;
        resolve_hold_keys_from_binding(binding)
    }

    /// PC-side authoritative mapping update: updates `tile_id -> NativeBehavior` bindings,
    /// re-derives the dynamic silkscreen `action_summary`, persists atomically, and bumps revision.
    pub fn set_tile_binding(
        &mut self,
        tile_id: String,
        binding: TileActionBindings,
    ) -> Result<(u64, DeckSnapshot), String> {
        if tile_id.trim().is_empty() {
            return Err("tileId 不能为空".into());
        }
        let prev_binding = self.bindings.insert(tile_id.clone(), binding);
        let prev_rev = self.revision;
        let prev_snap = self.snapshot.clone();
        self.revision += 1;
        self.rehydrate_tile_metadata();
        if let Err(err) = self.save() {
            match prev_binding {
                Some(old) => {
                    self.bindings.insert(tile_id, old);
                }
                None => {
                    self.bindings.remove(&tile_id);
                }
            }
            self.revision = prev_rev;
            self.snapshot = prev_snap;
            return Err(err);
        }
        Ok((self.revision, self.snapshot.clone()))
    }

    /// Replaces bindings for keys present in the managed Axonkey `axonkeyMobile` device instance's
    /// active profile (and restores baseline bindings for keys removed since the previous managed profile),
    /// re-derives `action_summary` + `voice_binding_summary`, and bumps revision if anything changed.
    pub fn sync_from_managed_profile_with_previous(
        &mut self,
        behaviors: &HashMap<String, TriggerBehaviors>,
        previous_managed_keys: &std::collections::HashSet<String>,
    ) -> Result<Option<(u64, DeckSnapshot)>, String> {
        let mut changed = false;
        if behaviors.is_empty() && !previous_managed_keys.is_empty() {
            let had_non_empty = self.bindings.values().any(|b| !b.is_empty());
            if had_non_empty || !self.preset_applied {
                self.bindings.clear();
                self.baseline_bindings.clear();
                self.preset_applied = true;
                changed = true;
            }
        } else {
            for removed_key in previous_managed_keys {
                if behaviors.contains_key(removed_key) {
                    continue;
                }
                let already_empty = self
                    .bindings
                    .get(removed_key)
                    .map(|b| b.is_empty())
                    .unwrap_or(true);
                if !already_empty {
                    if removed_key == VOICE_KEY_ID && !self.preset_applied {
                        self.bindings
                            .insert(VOICE_KEY_ID.into(), TileActionBindings::default());
                    } else {
                        self.bindings.remove(removed_key);
                    }
                    changed = true;
                }
            }
        }
        for (key, trig) in behaviors {
            let next = TileActionBindings {
                tap: trig.click.clone(),
                double: trig.double_click.clone(),
                long: trig.long_press.clone(),
                hold_keys: Vec::new(),
            };
            let prev = self.bindings.get(key);
            let same = match prev {
                Some(p) => {
                    p.tap == next.tap
                        && p.double == next.double
                        && p.long == next.long
                        && p.hold_keys.is_empty()
                }
                None => next.is_empty(),
            };
            if !same {
                self.bindings.insert(key.clone(), next);
                changed = true;
            }
        }
        if !changed {
            return Ok(None);
        }
        self.revision += 1;
        self.rehydrate_tile_metadata();
        self.save()?;
        Ok(Some((self.revision, self.snapshot.clone())))
    }

    pub fn clear_all_bindings(&mut self) -> Result<Option<(u64, DeckSnapshot)>, String> {
        let had_non_empty = self.bindings.values().any(|b| !b.is_empty());
        if !had_non_empty && self.preset_applied {
            return Ok(None);
        }
        self.bindings.clear();
        self.baseline_bindings.clear();
        self.preset_applied = true;
        self.revision += 1;
        self.rehydrate_tile_metadata();
        self.save()?;
        Ok(Some((self.revision, self.snapshot.clone())))
    }

    /// Applies one of the 4 starter presets + optional voice preset atomically, bumping revision,
    /// rehydrating silkscreen summaries, and saving `mobile-deck.json`.
    pub fn apply_preset(
        &mut self,
        preset: StarterPresetId,
        voice_preset: Option<VoicePresetKind>,
    ) -> Result<(u64, DeckSnapshot, HashMap<String, TileActionBindings>), String> {
        let (active_page_id, pages, bindings) = build_starter_preset(preset, voice_preset);
        let prev_rev = self.revision;
        let prev_snap = self.snapshot.clone();
        let prev_bindings = std::mem::replace(&mut self.bindings, bindings.clone());
        let prev_baseline = std::mem::replace(&mut self.baseline_bindings, bindings);
        let prev_preset_flag = self.preset_applied;

        self.revision += 1;
        self.preset_applied = true;
        self.snapshot.active_page_id = active_page_id;
        self.snapshot.pages = pages;
        self.rehydrate_tile_metadata();

        if let Err(err) = self.save() {
            self.revision = prev_rev;
            self.snapshot = prev_snap;
            self.bindings = prev_bindings;
            self.baseline_bindings = prev_baseline;
            self.preset_applied = prev_preset_flag;
            return Err(err);
        }
        Ok((self.revision, self.snapshot.clone(), self.bindings.clone()))
    }

    /// Optimistic-concurrency layout update from mobile or desktop UI.
    /// Mobile can customize layout, labels, colors, and controlled icon tokens,
    /// but cannot inject arbitrary NativeBehavior payloads here.
    pub fn apply_layout_patch(
        &mut self,
        base_revision: u64,
        patch: DeckLayoutPatch,
    ) -> Result<(u64, DeckSnapshot), DeckUpdateError> {
        if base_revision != self.revision {
            return Err(DeckUpdateError::Conflict(DeckConflict {
                revision: self.revision,
                snapshot: self.snapshot.clone(),
            }));
        }

        let mut next = self.snapshot.clone();
        if let Some(split) = patch.trackpad_split {
            if !split.is_finite() || !(0.0..=1.0).contains(&split) {
                return Err(DeckUpdateError::Invalid(
                    "trackpadSplit 必须在 0..=1 之间".into(),
                ));
            }
            next.trackpad_split = split;
        }
        if let Some(sens) = patch.pointer_sensitivity {
            if !sens.is_finite() || !(0.2..=5.0).contains(&sens) {
                return Err(DeckUpdateError::Invalid(
                    "pointerSensitivity 必须在 0.2..=5.0 之间".into(),
                ));
            }
            next.pointer_sensitivity = sens;
        }
        if let Some(sens) = patch.scroll_sensitivity {
            if !sens.is_finite() || !(0.2..=5.0).contains(&sens) {
                return Err(DeckUpdateError::Invalid(
                    "scrollSensitivity 必须在 0.2..=5.0 之间".into(),
                ));
            }
            next.scroll_sensitivity = sens;
        }
        if let Some(pages) = patch.pages {
            if pages.is_empty() || pages.len() > MAX_PAGES {
                return Err(DeckUpdateError::Invalid(format!(
                    "页面数量必须在 1..={MAX_PAGES} 之间"
                )));
            }
            let mut sanitized_pages = Vec::with_capacity(pages.len());
            for mut page in pages {
                if page.id.trim().is_empty() || page.name.trim().is_empty() {
                    return Err(DeckUpdateError::Invalid("页面 ID 和名称不能为空".into()));
                }
                if !(2..=4).contains(&page.columns) {
                    return Err(DeckUpdateError::Invalid("列数仅支持 2、3、4".into()));
                }
                if page.tiles.len() > MAX_TILES_PER_PAGE {
                    return Err(DeckUpdateError::Invalid(format!(
                        "单页卡片数量不能超过 {MAX_TILES_PER_PAGE}"
                    )));
                }
                if page.zones.len() > MAX_ZONES_PER_PAGE {
                    return Err(DeckUpdateError::Invalid(format!(
                        "单页区块数量不能超过 {MAX_ZONES_PER_PAGE}"
                    )));
                }
                for tile in &mut page.tiles {
                    tile.id = tile.id.trim().to_owned();
                    if tile.id.is_empty() || tile.label.trim().is_empty() {
                        return Err(DeckUpdateError::Invalid("卡片 ID 和标题不能为空".into()));
                    }
                    if !is_safe_icon_token(&tile.icon) {
                        return Err(DeckUpdateError::Invalid(format!(
                            "非法图标标识: {}",
                            tile.icon
                        )));
                    }
                    tile.label = tile.label.trim().chars().take(24).collect();
                    tile.subtitle = tile
                        .subtitle
                        .as_deref()
                        .map(|s| s.trim().chars().take(24).collect::<String>())
                        .filter(|s| !s.is_empty());
                    tile.col_span = tile.col_span.clamp(1, 2);
                    tile.row_span = tile.row_span.clamp(1, 2);
                }
                for zone in &mut page.zones {
                    zone.id = zone.id.trim().to_owned();
                    if zone.id.is_empty() {
                        return Err(DeckUpdateError::Invalid("区块 ID 不能为空".into()));
                    }
                    if let Some(cols) = zone.columns {
                        if !(2..=4).contains(&cols) {
                            return Err(DeckUpdateError::Invalid("区块列数仅支持 2、3、4".into()));
                        }
                    }
                    for slot_id in &mut zone.tile_ids {
                        *slot_id = slot_id.trim().to_owned();
                    }
                    if zone.kind == DeckZoneKind::GesturePad {
                        if zone.tile_ids.len() > 6 {
                            return Err(DeckUpdateError::Invalid(
                                "手势触发垫最多支持 6 个手势槽位".into(),
                            ));
                        }
                        for slot_id in &zone.tile_ids {
                            if !slot_id.is_empty() && !page.tiles.iter().any(|t| t.id == *slot_id) {
                                return Err(DeckUpdateError::Invalid(format!(
                                    "手势触发垫引用的卡片不存在: {slot_id}"
                                )));
                            }
                        }
                    }
                }
                sanitized_pages.push(page);
            }
            next.pages = sanitized_pages;
        }
        if let Some(active) = patch.active_page_id {
            if !next.pages.iter().any(|p| p.id == active) {
                return Err(DeckUpdateError::Invalid(
                    "activePageId 不存在于当前页面列表".into(),
                ));
            }
            next.active_page_id = active;
        } else if !next.pages.iter().any(|p| p.id == next.active_page_id) {
            next.active_page_id = next.pages[0].id.clone();
        }

        let next_revision = self.revision + 1;
        let backup_rev = self.revision;
        let backup_snap = std::mem::replace(&mut self.snapshot, next);
        self.revision = next_revision;
        self.rehydrate_tile_metadata();
        if let Err(io_err) = self.save() {
            self.snapshot = backup_snap;
            self.revision = backup_rev;
            return Err(DeckUpdateError::Io(io_err));
        }
        Ok((self.revision, self.snapshot.clone()))
    }

    /// Gently migrates an unedited legacy 4-zone `classic-remote` page (which stacked a redundant
    /// `classic-quick` 2×2 block under the Siri Remote media strip) to the harmonious 3-band
    /// Plan B Siri Remote layout, preserving any user-customized tiles or zones untouched.
    fn migrate_stock_classic_remote_layout(&mut self) -> bool {
        let Some(page) = self
            .snapshot
            .pages
            .iter_mut()
            .find(|p| p.id == "classic-remote")
        else {
            return false;
        };
        if page.zones.len() != 4 {
            return false;
        }
        let fourth = &page.zones[3];
        let is_legacy_quick_id =
            fourth.id == "classic-quick" || fourth.id == "classic-remote-quick";
        let expected_q_ids = ["remote.q1", "remote.q2", "remote.q3", "remote.q4"];
        let exact_q_slots = fourth.kind == DeckZoneKind::BentoGrid
            && fourth.columns == Some(2)
            && fourth.tile_ids.len() == 4
            && fourth
                .tile_ids
                .iter()
                .zip(expected_q_ids.iter())
                .all(|(a, b)| a == b);
        if !is_legacy_quick_id || !exact_q_slots {
            return false;
        }
        let stock_labels = [
            "继续执行",
            "接受变更",
            "采纳修改",
            "撤销",
            "播放/暂停",
            "播放 / 暂停",
            "切换窗口",
            "复制",
            "粘贴",
        ];
        let any_customized = page
            .tiles
            .iter()
            .filter(|t| expected_q_ids.contains(&t.id.as_str()))
            .any(|t| {
                t.subtitle.is_some()
                    || t.col_span != 1
                    || t.row_span != 1
                    || !stock_labels.contains(&t.label.as_str())
            });
        if any_customized {
            return false;
        }
        page.zones.pop();
        page.tiles
            .retain(|t| !expected_q_ids.contains(&t.id.as_str()));
        self.revision += 1;
        true
    }

    fn rehydrate_tile_metadata(&mut self) {
        let voice_keys = self.resolve_voice_hold_keys();
        self.snapshot.voice_binding_summary = if voice_keys.is_empty() {
            None
        } else {
            Some(
                voice_keys
                    .iter()
                    .map(|k| pretty_key(k))
                    .collect::<Vec<_>>()
                    .join("+"),
            )
        };
        for page in &mut self.snapshot.pages {
            for tile in &mut page.tiles {
                tile.col_span = tile.col_span.clamp(1, 2);
                tile.row_span = tile.row_span.clamp(1, 2);
                if let Some(b) = self.bindings.get(&tile.id) {
                    tile.has_double_click = !b.double.is_empty();
                    tile.has_long_press = !b.long.is_empty();
                    tile.action_summary = if tile.mode == TileMode::Hold {
                        if let Some(keys) = resolve_hold_keys_from_binding(b) {
                            let keys_pretty = keys
                                .iter()
                                .map(|k| pretty_key(k))
                                .collect::<Vec<_>>()
                                .join("+");
                            Some(format!("按住 {keys_pretty}"))
                        } else {
                            summarize_binding(b)
                        }
                    } else {
                        summarize_binding(b)
                    };
                } else {
                    tile.has_double_click = false;
                    tile.has_long_press = false;
                    tile.action_summary = None;
                }
            }
        }
    }

    fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create deck parent dir: {e}"))?;
        }
        let persisted = PersistedDeck {
            version: 1,
            revision: self.revision,
            snapshot: self.snapshot.clone(),
            bindings: self.bindings.clone(),
            preset_applied: self.preset_applied,
        };
        let tmp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|e| format!("Failed to serialize mobile-deck.json: {e}"))?;
        fs::write(&tmp, bytes).map_err(|e| format!("Failed to write mobile-deck tmp: {e}"))?;
        fs::rename(&tmp, &self.path)
            .map_err(|e| format!("Failed to commit mobile-deck.json: {e}"))?;
        Ok(())
    }
}

fn resolve_hold_keys_from_binding(binding: &TileActionBindings) -> Option<Vec<String>> {
    if !binding.hold_keys.is_empty() {
        return Some(binding.hold_keys.clone());
    }
    binding.tap.iter().find_map(|behavior| match behavior {
        NativeBehavior::Key { enabled: true, key } if !key.trim().is_empty() => {
            Some(vec![key.clone()])
        }
        NativeBehavior::Shortcut {
            enabled: true,
            keys,
        } if !keys.is_empty() => {
            let non_empty: Vec<String> = keys
                .iter()
                .filter(|k| !k.trim().is_empty())
                .cloned()
                .collect();
            (!non_empty.is_empty()).then_some(non_empty)
        }
        _ => None,
    })
}

pub fn summarize_binding(binding: &TileActionBindings) -> Option<String> {
    if !binding.hold_keys.is_empty() {
        let keys_pretty = binding
            .hold_keys
            .iter()
            .map(|k| pretty_key(k))
            .collect::<Vec<_>>()
            .join("+");
        return Some(format!("按住 {keys_pretty}"));
    }
    summarize_behaviors(&binding.tap)
        .or_else(|| summarize_behaviors(&binding.double).map(|s| format!("2× {s}")))
        .or_else(|| summarize_behaviors(&binding.long).map(|s| format!("长按 {s}")))
}

fn summarize_behaviors(behaviors: &[NativeBehavior]) -> Option<String> {
    let first = behaviors.iter().find(|b| b.enabled())?;
    let label = match first {
        NativeBehavior::Key { key, .. } => pretty_key(key),
        NativeBehavior::Shortcut { keys, .. } => keys
            .iter()
            .map(|k| pretty_key(k))
            .collect::<Vec<_>>()
            .join("+"),
        NativeBehavior::Paste { text, .. } => {
            let preview: String = text.trim().chars().take(10).collect();
            if text.trim().chars().count() > 10 {
                format!("粘贴「{preview}…」")
            } else {
                format!("粘贴「{preview}」")
            }
        }
        NativeBehavior::TypeText { text, .. } => {
            let preview: String = text.trim().chars().take(10).collect();
            format!("输入「{preview}」")
        }
        NativeBehavior::Mouse { button, .. } => format!("鼠标 {:?}", button),
        NativeBehavior::Wheel { direction, .. } => format!("滚轮 {:?}", direction),
        NativeBehavior::CursorMove { direction, .. } => format!("移动 {:?}", direction),
        NativeBehavior::OpenApp { path, .. } | NativeBehavior::OpenPath { path, .. } => {
            format!("打开 {}", path.rsplit(['\\', '/']).next().unwrap_or(path))
        }
        NativeBehavior::OpenWebsite { url, .. } => format!("网页 {url}"),
        NativeBehavior::CopyText { text, .. } => {
            let preview: String = text.trim().chars().take(10).collect();
            format!("复制「{preview}」")
        }
        NativeBehavior::RunCommand { command, .. } => {
            let preview: String = command.trim().chars().take(12).collect();
            format!("命令 {preview}")
        }
        NativeBehavior::HttpRequest { method, .. } => format!("HTTP {method}"),
        NativeBehavior::SwitchProfile { .. } => "切换配置".into(),
        NativeBehavior::QuickOverlay { .. } => "快捷交互窗".into(),
        NativeBehavior::ClipboardOverlay { .. } => "剪贴板历史".into(),
        NativeBehavior::Delay { ms, .. } => format!("延时 {ms}ms"),
        NativeBehavior::Disabled { .. } => return None,
    };
    if behaviors.iter().filter(|b| b.enabled()).count() > 1 {
        Some(format!("{label} +"))
    } else {
        Some(label)
    }
}

fn pretty_key(key: &str) -> String {
    match key {
        "Control" => "Ctrl".into(),
        "Escape" => "Esc".into(),
        "ArrowUp" | "Up" => "↑".into(),
        "ArrowDown" | "Down" => "↓".into(),
        "ArrowLeft" | "Left" => "←".into(),
        "ArrowRight" | "Right" => "→".into(),
        "AudioVolumeUp" | "VolumeUp" => "音量+".into(),
        "AudioVolumeDown" | "VolumeDown" => "音量-".into(),
        "AudioVolumeMute" | "VolumeMute" => "静音".into(),
        "MediaPlayPause" => "播放/暂停".into(),
        "MediaTrackPrevious" | "MediaPrevious" => "上一曲".into(),
        "MediaTrackNext" | "MediaNext" => "下一曲".into(),
        "Backspace" => "退格".into(),
        other => other.to_owned(),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTriggerBehaviorsDto {
    pub click: Vec<NativeBehavior>,
    pub double_click: Vec<NativeBehavior>,
    pub long_press: Vec<NativeBehavior>,
}

pub fn bindings_to_trigger_behaviors_dto(
    bindings: &HashMap<String, TileActionBindings>,
) -> HashMap<String, DesktopTriggerBehaviorsDto> {
    let mut out = HashMap::new();
    for (tile_id, b) in bindings {
        if b.is_empty() {
            continue;
        }
        let click = if !b.tap.is_empty() {
            b.tap.clone()
        } else if b.hold_keys.len() == 1 {
            vec![key(&b.hold_keys[0])]
        } else if b.hold_keys.len() > 1 {
            vec![NativeBehavior::Shortcut {
                enabled: true,
                keys: b.hold_keys.clone(),
            }]
        } else {
            Vec::new()
        };
        out.insert(
            tile_id.clone(),
            DesktopTriggerBehaviorsDto {
                click,
                double_click: b.double.clone(),
                long_press: b.long.clone(),
            },
        );
    }
    out
}

#[cfg(test)]
pub fn dto_map_to_trigger_behaviors(
    dto: &HashMap<String, DesktopTriggerBehaviorsDto>,
) -> HashMap<String, TriggerBehaviors> {
    dto.iter()
        .map(|(k, v)| {
            (
                k.clone(),
                TriggerBehaviors {
                    click: v.click.clone(),
                    double_click: v.double_click.clone(),
                    long_press: v.long_press.clone(),
                    ..Default::default()
                },
            )
        })
        .collect()
}

fn classic_remote_default_zones() -> Vec<MobileDeckZone> {
    vec![
        MobileDeckZone {
            id: "classic-top".into(),
            kind: DeckZoneKind::BentoGrid,
            columns: Some(3),
            pointer_mode: None,
            pad_height: None,
            show_buttons: None,
            tile_ids: vec![
                "remote.esc".into(),
                "remote.menu".into(),
                "remote.home".into(),
            ],
        },
        MobileDeckZone {
            id: "classic-ring".into(),
            kind: DeckZoneKind::Dpad3x3,
            columns: None,
            pointer_mode: None,
            pad_height: None,
            show_buttons: None,
            tile_ids: vec![
                "".into(),
                "remote.up".into(),
                "".into(),
                "remote.left".into(),
                "remote.ok".into(),
                "remote.right".into(),
                "".into(),
                "remote.down".into(),
                "".into(),
            ],
        },
        MobileDeckZone {
            id: "classic-media".into(),
            kind: DeckZoneKind::BentoGrid,
            columns: Some(4),
            pointer_mode: None,
            pad_height: None,
            show_buttons: None,
            tile_ids: vec![
                "remote.back".into(),
                "remote.mute".into(),
                "remote.vol_down".into(),
                "remote.vol_up".into(),
            ],
        },
    ]
}

fn tile_with_span(
    id: &str,
    label: &str,
    icon: &str,
    accent: TileAccent,
    col_span: u8,
    row_span: u8,
) -> MobileTile {
    let mut t = tile(id, label, icon, accent, col_span);
    t.row_span = row_span;
    t
}

fn classic_remote_page_and_bindings(
    everyday_mode: bool,
) -> (MobileDeckPage, HashMap<String, TileActionBindings>) {
    let mut bindings = HashMap::new();
    bindings.insert(
        "remote.esc".into(),
        TileActionBindings {
            tap: vec![key("Esc")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.menu".into(),
        TileActionBindings {
            tap: vec![if everyday_mode {
                shortcut(&["Win", "Tab"])
            } else {
                shortcut(&["Ctrl", "K"])
            }],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.up".into(),
        TileActionBindings {
            tap: vec![key("Up")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.down".into(),
        TileActionBindings {
            tap: vec![key("Down")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.left".into(),
        TileActionBindings {
            tap: vec![key("Left")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.right".into(),
        TileActionBindings {
            tap: vec![key("Right")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.ok".into(),
        TileActionBindings {
            tap: vec![key("Enter")],
            double: vec![if everyday_mode {
                key("Space")
            } else {
                shortcut(&["Ctrl", "Enter"])
            }],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.back".into(),
        TileActionBindings {
            tap: vec![key("Backspace")],
            long: vec![if everyday_mode {
                shortcut(&["Alt", "Left"])
            } else {
                shortcut(&["Ctrl", "Z"])
            }],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.home".into(),
        TileActionBindings {
            tap: vec![if everyday_mode {
                shortcut(&["Win", "D"])
            } else {
                shortcut(&["Ctrl", "L"])
            }],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.vol_up".into(),
        TileActionBindings {
            tap: vec![key("VolumeUp")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.vol_down".into(),
        TileActionBindings {
            tap: vec![key("VolumeDown")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.mute".into(),
        TileActionBindings {
            tap: vec![key("VolumeMute")],
            ..Default::default()
        },
    );

    let tiles = vec![
        tile("remote.esc", "Esc", "power", TileAccent::Rose, 1),
        tile(
            "remote.menu",
            if everyday_mode { "任务" } else { "菜单" },
            if everyday_mode { "layout" } else { "menu" },
            TileAccent::Blue,
            1,
        ),
        tile("remote.up", "上", "arrow-up", TileAccent::Slate, 1),
        tile("remote.down", "下", "arrow-down", TileAccent::Slate, 1),
        tile("remote.left", "左", "arrow-left", TileAccent::Slate, 1),
        tile("remote.right", "右", "arrow-right", TileAccent::Slate, 1),
        tile("remote.ok", "确定", "enter", TileAccent::Blue, 1),
        tile("remote.back", "返回", "undo", TileAccent::Slate, 1),
        tile(
            "remote.home",
            if everyday_mode { "桌面" } else { "主页" },
            "home",
            TileAccent::Slate,
            1,
        ),
        tile("remote.vol_up", "音量+", "volume-up", TileAccent::Slate, 1),
        tile(
            "remote.vol_down",
            "音量-",
            "volume-down",
            TileAccent::Slate,
            1,
        ),
        tile("remote.mute", "静音", "volume-mute", TileAccent::Amber, 1),
    ];

    let page = MobileDeckPage {
        id: "classic-remote".into(),
        name: "经典遥控器".into(),
        layout: PageLayout::Remote,
        columns: 3,
        tiles,
        zones: classic_remote_default_zones(),
    };
    (page, bindings)
}

fn apply_voice_preset_binding(
    bindings: &mut HashMap<String, TileActionBindings>,
    voice_preset: VoicePresetKind,
) {
    match voice_preset {
        VoicePresetKind::DoubaoAlt => {
            bindings.insert(
                VOICE_KEY_ID.into(),
                TileActionBindings {
                    tap: vec![key("Alt")],
                    ..Default::default()
                },
            );
        }
        VoicePresetKind::SystemWinH => {
            bindings.insert(
                VOICE_KEY_ID.into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Win", "H"])],
                    ..Default::default()
                },
            );
        }
        VoicePresetKind::CtrlWin => {
            bindings.insert(
                VOICE_KEY_ID.into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "Win"])],
                    ..Default::default()
                },
            );
        }
        VoicePresetKind::PureMic => {
            bindings.remove(VOICE_KEY_ID);
        }
    }
}

pub fn build_starter_preset(
    preset: StarterPresetId,
    voice_preset: Option<VoicePresetKind>,
) -> (
    String,
    Vec<MobileDeckPage>,
    HashMap<String, TileActionBindings>,
) {
    let effective_voice = voice_preset.unwrap_or(match preset {
        StarterPresetId::BlankCanvas => VoicePresetKind::PureMic,
        StarterPresetId::DailyRemote
        | StarterPresetId::VibeCoding
        | StarterPresetId::PresentationMedia => VoicePresetKind::DoubaoAlt,
    });

    match preset {
        StarterPresetId::DailyRemote => {
            let (remote_page, mut bindings) = classic_remote_page_and_bindings(true);
            bindings.insert(
                "daily.play_pause".into(),
                TileActionBindings {
                    tap: vec![key("MediaPlayPause")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "daily.fullscreen".into(),
                TileActionBindings {
                    tap: vec![key("F")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "daily.prev_track".into(),
                TileActionBindings {
                    tap: vec![key("MediaPrevious")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "daily.next_track".into(),
                TileActionBindings {
                    tap: vec![key("MediaNext")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "daily.refresh".into(),
                TileActionBindings {
                    tap: vec![key("F5")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "daily.tab_prev".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "Shift", "Tab"])],
                    ..Default::default()
                },
            );
            bindings.insert(
                "daily.tab_next".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "Tab"])],
                    ..Default::default()
                },
            );
            bindings.insert(
                "daily.close_tab".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "W"])],
                    ..Default::default()
                },
            );
            let media_page = MobileDeckPage {
                id: "daily-media".into(),
                name: "影音与网页".into(),
                layout: PageLayout::Grid,
                columns: 3,
                tiles: vec![
                    tile(
                        "daily.play_pause",
                        "播放/暂停",
                        "play",
                        TileAccent::Violet,
                        2,
                    ),
                    tile("daily.fullscreen", "全屏", "tv", TileAccent::Blue, 1),
                    tile(
                        "daily.prev_track",
                        "上一曲",
                        "skip-back",
                        TileAccent::Slate,
                        1,
                    ),
                    tile(
                        "daily.next_track",
                        "下一曲",
                        "skip-forward",
                        TileAccent::Slate,
                        1,
                    ),
                    tile(
                        "daily.refresh",
                        "刷新网页",
                        "refresh",
                        TileAccent::Emerald,
                        1,
                    ),
                    tile(
                        "daily.tab_prev",
                        "上一标签",
                        "arrow-left",
                        TileAccent::Slate,
                        1,
                    ),
                    tile(
                        "daily.tab_next",
                        "下一标签",
                        "arrow-right",
                        TileAccent::Slate,
                        1,
                    ),
                    tile("daily.close_tab", "关闭标签", "esc", TileAccent::Rose, 1),
                ],
                zones: Vec::new(),
            };
            apply_voice_preset_binding(&mut bindings, effective_voice);
            (
                "classic-remote".into(),
                vec![remote_page, media_page],
                bindings,
            )
        }
        StarterPresetId::VibeCoding => {
            let (remote_page, mut bindings) = classic_remote_page_and_bindings(false);
            bindings.insert(
                "tile.continue".into(),
                TileActionBindings {
                    tap: vec![paste("继续执行，完成后汇报验证结果。"), key("Enter")],
                    long: vec![
                        paste("先停下来检查当前改动是否有边界问题，再继续。"),
                        key("Enter"),
                    ],
                    ..Default::default()
                },
            );
            bindings.insert(
                "tile.enter".into(),
                TileActionBindings {
                    tap: vec![key("Enter")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "tile.accept".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "Enter"])],
                    ..Default::default()
                },
            );
            bindings.insert(
                "tile.undo".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "Z"])],
                    double: vec![shortcut(&["Ctrl", "Y"])],
                    ..Default::default()
                },
            );
            bindings.insert(
                "tile.esc".into(),
                TileActionBindings {
                    tap: vec![key("Esc")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "tile.copy".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "C"])],
                    ..Default::default()
                },
            );
            bindings.insert(
                "tile.paste".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "V"])],
                    ..Default::default()
                },
            );
            bindings.insert(
                "tile.terminal".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Ctrl", "`"])],
                    ..Default::default()
                },
            );
            let vibe_page = MobileDeckPage {
                id: "vibe-coding".into(),
                name: "AI 编程副屏".into(),
                layout: PageLayout::Grid,
                columns: 3,
                tiles: vec![
                    tile("tile.continue", "继续执行", "sparkles", TileAccent::Blue, 2),
                    tile("tile.enter", "发送确认", "enter", TileAccent::Emerald, 1),
                    tile("tile.accept", "采纳", "check", TileAccent::Emerald, 1),
                    tile("tile.undo", "撤销", "undo", TileAccent::Amber, 1),
                    tile("tile.esc", "中断", "esc", TileAccent::Rose, 1),
                    tile("tile.copy", "复制", "copy", TileAccent::Slate, 1),
                    tile("tile.paste", "粘贴", "clipboard", TileAccent::Slate, 1),
                    tile("tile.terminal", "终端", "terminal", TileAccent::Violet, 1),
                ],
                zones: Vec::new(),
            };
            apply_voice_preset_binding(&mut bindings, effective_voice);
            ("vibe-coding".into(), vec![vibe_page, remote_page], bindings)
        }
        StarterPresetId::PresentationMedia => {
            let mut bindings = HashMap::new();
            bindings.insert(
                "ppt.prev".into(),
                TileActionBindings {
                    tap: vec![key("PageUp")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "ppt.next".into(),
                TileActionBindings {
                    tap: vec![key("PageDown")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "ppt.fullscreen".into(),
                TileActionBindings {
                    tap: vec![key("F5")],
                    long: vec![key("Esc")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "ppt.blackout".into(),
                TileActionBindings {
                    tap: vec![key("B")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "media.play_pause".into(),
                TileActionBindings {
                    tap: vec![key("MediaPlayPause")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "media.mute".into(),
                TileActionBindings {
                    tap: vec![key("VolumeMute")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "pres.prev".into(),
                TileActionBindings {
                    tap: vec![key("PageUp")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "pres.next".into(),
                TileActionBindings {
                    tap: vec![key("PageDown")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "pres.esc".into(),
                TileActionBindings {
                    tap: vec![key("Esc")],
                    ..Default::default()
                },
            );
            bindings.insert(
                "pres.play".into(),
                TileActionBindings {
                    tap: vec![key("MediaPlayPause")],
                    ..Default::default()
                },
            );

            let ppt_page = MobileDeckPage {
                id: "presentation-main".into(),
                name: "演示与影音".into(),
                layout: PageLayout::Grid,
                columns: 2,
                tiles: vec![
                    tile_with_span("ppt.prev", "上一页", "arrow-left", TileAccent::Slate, 1, 2),
                    tile_with_span("ppt.next", "下一页", "arrow-right", TileAccent::Blue, 1, 2),
                    tile("ppt.fullscreen", "全屏放映", "tv", TileAccent::Emerald, 1),
                    tile("ppt.blackout", "黑屏", "power", TileAccent::Amber, 1),
                    tile(
                        "media.play_pause",
                        "播放/暂停",
                        "play",
                        TileAccent::Violet,
                        1,
                    ),
                    tile("media.mute", "静音", "volume-mute", TileAccent::Rose, 1),
                ],
                zones: Vec::new(),
            };

            let mixed_page = MobileDeckPage {
                id: "presentation-touchpad".into(),
                name: "触控演示混排".into(),
                layout: PageLayout::Grid,
                columns: 2,
                tiles: vec![
                    tile("pres.prev", "上一页", "arrow-left", TileAccent::Slate, 1),
                    tile("pres.next", "下一页", "arrow-right", TileAccent::Blue, 1),
                    tile("pres.esc", "退出放映", "esc", TileAccent::Rose, 1),
                    tile("pres.play", "播放/暂停", "play", TileAccent::Violet, 1),
                ],
                zones: vec![
                    MobileDeckZone {
                        id: "pres-pad".into(),
                        kind: DeckZoneKind::PointerPad,
                        columns: None,
                        pointer_mode: Some(EmbeddedPointerMode::Trackpad),
                        pad_height: Some(EmbeddedPadHeight::Standard),
                        show_buttons: Some(true),
                        tile_ids: Vec::new(),
                    },
                    MobileDeckZone {
                        id: "pres-keys".into(),
                        kind: DeckZoneKind::BentoGrid,
                        columns: Some(2),
                        pointer_mode: None,
                        pad_height: None,
                        show_buttons: None,
                        tile_ids: vec![
                            "pres.prev".into(),
                            "pres.next".into(),
                            "pres.esc".into(),
                            "pres.play".into(),
                        ],
                    },
                ],
            };

            apply_voice_preset_binding(&mut bindings, effective_voice);
            (
                "presentation-main".into(),
                vec![ppt_page, mixed_page],
                bindings,
            )
        }
        StarterPresetId::BlankCanvas => {
            let mut bindings = HashMap::new();
            let canvas_page = MobileDeckPage {
                id: "custom-canvas".into(),
                name: "自定义面板".into(),
                layout: PageLayout::Grid,
                columns: 2,
                tiles: vec![
                    tile("custom.1", "自定义 1", "sparkles", TileAccent::Slate, 1),
                    tile("custom.2", "自定义 2", "command", TileAccent::Slate, 1),
                    tile("custom.3", "自定义 3", "zap", TileAccent::Slate, 1),
                    tile("custom.4", "自定义 4", "layout", TileAccent::Slate, 1),
                ],
                zones: Vec::new(),
            };
            apply_voice_preset_binding(&mut bindings, effective_voice);
            ("custom-canvas".into(), vec![canvas_page], bindings)
        }
    }
}

fn is_safe_icon_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 32
        && token
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn shortcut(keys: &[&str]) -> NativeBehavior {
    NativeBehavior::Shortcut {
        enabled: true,
        keys: keys.iter().map(|s| (*s).to_owned()).collect(),
    }
}

fn key(k: &str) -> NativeBehavior {
    NativeBehavior::Key {
        enabled: true,
        key: k.to_owned(),
    }
}

fn paste(text: &str) -> NativeBehavior {
    NativeBehavior::Paste {
        enabled: true,
        text: text.to_owned(),
    }
}

fn tile(id: &str, label: &str, icon: &str, accent: TileAccent, col_span: u8) -> MobileTile {
    MobileTile {
        id: id.into(),
        label: label.into(),
        subtitle: None,
        action_summary: None,
        icon: icon.into(),
        accent,
        col_span,
        row_span: 1,
        mode: TileMode::Gesture,
        has_double_click: false,
        has_long_press: false,
    }
}

fn default_mobile_deck() -> (DeckSnapshot, HashMap<String, TileActionBindings>) {
    let mut bindings = HashMap::new();

    // Classic Remote default PC-side key bindings
    bindings.insert(
        "remote.esc".into(),
        TileActionBindings {
            tap: vec![key("Escape")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.menu".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "K"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.up".into(),
        TileActionBindings {
            tap: vec![key("ArrowUp")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.down".into(),
        TileActionBindings {
            tap: vec![key("ArrowDown")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.left".into(),
        TileActionBindings {
            tap: vec![key("ArrowLeft")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.right".into(),
        TileActionBindings {
            tap: vec![key("ArrowRight")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.ok".into(),
        TileActionBindings {
            tap: vec![key("Enter")],
            double: vec![shortcut(&["Control", "Enter"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.back".into(),
        TileActionBindings {
            tap: vec![key("Backspace")],
            long: vec![shortcut(&["Control", "Z"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.home".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "L"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.vol_up".into(),
        TileActionBindings {
            tap: vec![key("AudioVolumeUp")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.vol_down".into(),
        TileActionBindings {
            tap: vec![key("AudioVolumeDown")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.mute".into(),
        TileActionBindings {
            tap: vec![key("AudioVolumeMute")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.q1".into(),
        TileActionBindings {
            tap: vec![paste("继续执行，完成后汇报验证结果。"), key("Enter")],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.q2".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "Enter"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.q3".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "Z"])],
            double: vec![shortcut(&["Control", "Y"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "remote.q4".into(),
        TileActionBindings {
            tap: vec![key("MediaPlayPause")],
            ..Default::default()
        },
    );
    bindings.insert(
        VOICE_KEY_ID.into(),
        TileActionBindings {
            tap: vec![key("Alt")],
            ..Default::default()
        },
    );

    // Vibe Coding Grid default PC-side bindings
    bindings.insert(
        "tile.continue".into(),
        TileActionBindings {
            tap: vec![paste("继续执行，完成后汇报验证结果。"), key("Enter")],
            long: vec![
                paste("先停下来检查当前改动是否有边界问题，再继续。"),
                key("Enter"),
            ],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.enter".into(),
        TileActionBindings {
            tap: vec![key("Enter")],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.accept".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "Enter"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.undo".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "Z"])],
            double: vec![shortcut(&["Control", "Y"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.esc".into(),
        TileActionBindings {
            tap: vec![key("Escape")],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.copy".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "C"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.paste".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "V"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.terminal".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "`"])],
            ..Default::default()
        },
    );

    let snapshot = DeckSnapshot {
        version: 1,
        active_page_id: "classic-remote".into(),
        trackpad_split: 0.0,
        pointer_sensitivity: 1.4,
        scroll_sensitivity: 1.0,
        double_click_window_ms: 300,
        long_press_window_ms: 600,
        voice_binding_summary: None,
        pages: vec![
            MobileDeckPage {
                id: "classic-remote".into(),
                name: "经典遥控器".into(),
                layout: PageLayout::Remote,
                columns: 3,
                tiles: vec![
                    tile("remote.esc", "Esc", "power", TileAccent::Rose, 1),
                    tile("remote.menu", "菜单", "menu", TileAccent::Blue, 1),
                    tile("remote.up", "上", "arrow-up", TileAccent::Slate, 1),
                    tile("remote.down", "下", "arrow-down", TileAccent::Slate, 1),
                    tile("remote.left", "左", "arrow-left", TileAccent::Slate, 1),
                    tile("remote.right", "右", "arrow-right", TileAccent::Slate, 1),
                    tile("remote.ok", "确定", "enter", TileAccent::Blue, 1),
                    tile("remote.back", "返回", "undo", TileAccent::Slate, 1),
                    tile("remote.home", "主页", "home", TileAccent::Slate, 1),
                    tile("remote.vol_up", "音量+", "volume-up", TileAccent::Slate, 1),
                    tile(
                        "remote.vol_down",
                        "音量-",
                        "volume-down",
                        TileAccent::Slate,
                        1,
                    ),
                    tile("remote.mute", "静音", "volume-mute", TileAccent::Amber, 1),
                ],
                zones: classic_remote_default_zones(),
            },
            MobileDeckPage {
                id: "vibe-coding".into(),
                name: "快捷面板".into(),
                layout: PageLayout::Grid,
                columns: 3,
                tiles: vec![
                    tile("tile.continue", "继续执行", "play", TileAccent::Emerald, 2),
                    tile("tile.enter", "确认", "enter", TileAccent::Blue, 1),
                    tile("tile.accept", "接受变更", "check", TileAccent::Emerald, 1),
                    tile("tile.undo", "撤销", "undo", TileAccent::Amber, 1),
                    tile("tile.esc", "中断", "esc", TileAccent::Rose, 1),
                    tile("tile.copy", "复制", "copy", TileAccent::Slate, 1),
                    tile("tile.paste", "粘贴", "clipboard", TileAccent::Slate, 1),
                    tile("tile.terminal", "终端", "terminal", TileAccent::Violet, 1),
                ],
                zones: Vec::new(),
            },
        ],
    };

    (snapshot, bindings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn optimistic_lock_rejects_stale_base_revision_with_latest_snapshot() {
        let dir = std::env::temp_dir().join(format!("axonkey-deck-test-{}", Uuid::new_v4()));
        let path = dir.join("mobile-deck.json");
        let mut store = DeckStore::load(path.clone()).unwrap();
        assert_eq!(store.revision(), 1);
        assert_eq!(store.snapshot().active_page_id, "classic-remote");
        // Verify PC-derived action_summary is populated automatically
        let ok_tile = store.snapshot().pages[0]
            .tiles
            .iter()
            .find(|t| t.id == "remote.ok")
            .unwrap()
            .clone();
        assert_eq!(ok_tile.action_summary.as_deref(), Some("Enter"));
        assert!(ok_tile.has_double_click);

        let (rev2, snap2) = store
            .apply_layout_patch(
                1,
                DeckLayoutPatch {
                    trackpad_split: Some(0.5),
                    ..Default::default()
                },
            )
            .ok()
            .unwrap();
        assert_eq!(rev2, 2);
        assert!((snap2.trackpad_split - 0.5).abs() < f64::EPSILON);

        // PC binding update dynamically recomputes action_summary and bumps revision
        let (rev3, snap3) = store
            .set_tile_binding(
                "remote.ok".into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Control", "Shift", "P"])],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(rev3, 3);
        let updated_ok = snap3.pages[0]
            .tiles
            .iter()
            .find(|t| t.id == "remote.ok")
            .unwrap();
        assert_eq!(updated_ok.action_summary.as_deref(), Some("Ctrl+Shift+P"));

        // Stale update based on revision 1 must return explicit Conflict.
        let err = store
            .apply_layout_patch(
                1,
                DeckLayoutPatch {
                    trackpad_split: Some(0.2),
                    ..Default::default()
                },
            )
            .err()
            .unwrap();
        match err {
            DeckUpdateError::Conflict(c) => {
                assert_eq!(c.revision, 3);
            }
            _ => panic!("Expected DeckUpdateError::Conflict"),
        }

        let reloaded = DeckStore::load(path).unwrap();
        assert_eq!(reloaded.revision(), 3);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn voice_binding_seeds_alt_auto_migrates_legacy_deck_and_supports_pure_vmic() {
        let dir = std::env::temp_dir().join(format!("axonkey-deck-voice-{}", Uuid::new_v4()));
        let path = dir.join("mobile-deck.json");
        let mut store = DeckStore::load(path.clone()).unwrap();
        assert!((store.pointer_sensitivity() - 1.4).abs() < f64::EPSILON);
        assert!((store.scroll_sensitivity() - 1.0).abs() < f64::EPSILON);
        assert_eq!(store.resolve_voice_hold_keys(), vec!["Alt".to_owned()]);
        assert_eq!(
            store.snapshot().voice_binding_summary.as_deref(),
            Some("Alt")
        );

        // Simulate a v1 persisted deck missing "mobile.voice": DeckStore::load must auto-insert Alt
        let mut raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        raw["bindings"]
            .as_object_mut()
            .unwrap()
            .remove(VOICE_KEY_ID);
        raw["snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("voiceBindingSummary");
        fs::write(&path, serde_json::to_vec_pretty(&raw).unwrap()).unwrap();

        let migrated = DeckStore::load(path.clone()).unwrap();
        assert_eq!(migrated.resolve_voice_hold_keys(), vec!["Alt".to_owned()]);
        assert_eq!(
            migrated.snapshot().voice_binding_summary.as_deref(),
            Some("Alt")
        );

        // Shortcut Win+H -> hold keys ["Win", "H"] and summary "Win+H"
        let (_, snap_win_h) = store
            .set_tile_binding(
                VOICE_KEY_ID.into(),
                TileActionBindings {
                    tap: vec![shortcut(&["Win", "H"])],
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(
            store.resolve_voice_hold_keys(),
            vec!["Win".to_owned(), "H".to_owned()]
        );
        assert_eq!(snap_win_h.voice_binding_summary.as_deref(), Some("Win+H"));

        // Explicit empty binding -> Pure Virtual Microphone mode (no hold keys, summary None),
        // and reloading must preserve explicit empty binding (not overwrite with Alt).
        let (_, snap_pure) = store
            .set_tile_binding(VOICE_KEY_ID.into(), TileActionBindings::default())
            .unwrap();
        assert!(store.resolve_voice_hold_keys().is_empty());
        assert_eq!(snap_pure.voice_binding_summary, None);

        let reloaded_pure = DeckStore::load(path).unwrap();
        assert!(reloaded_pure.resolve_voice_hold_keys().is_empty());
        assert_eq!(reloaded_pure.snapshot().voice_binding_summary, None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bento_row_span_and_zones_persist_clamp_and_validate() {
        use super::super::protocol::{DeckZoneKind, EmbeddedPointerMode, MobileDeckZone};

        let dir = std::env::temp_dir().join(format!("axonkey-deck-v3-zones-{}", Uuid::new_v4()));
        let path = dir.join("mobile-deck.json");
        let mut store = DeckStore::load(path.clone()).unwrap();

        // Default classic-remote page ships with the 3-band Plan B Siri Remote zones (top 3, ring 5-slot, media 4),
        // while vibe-coding has empty zones which must be omitted in serialized JSON.
        let default_json = serde_json::to_value(store.snapshot()).unwrap();
        let default_zones = default_json["pages"][0]["zones"].as_array().unwrap();
        assert_eq!(default_zones.len(), 3);
        assert_eq!(default_zones[0]["kind"], "bento-grid");
        assert_eq!(default_zones[0]["columns"], 3);
        assert_eq!(default_zones[1]["kind"], "dpad-3x3");
        assert_eq!(
            default_zones[1]["tileIds"],
            serde_json::json!([
                "",
                "remote.up",
                "",
                "remote.left",
                "remote.ok",
                "remote.right",
                "",
                "remote.down",
                ""
            ])
        );
        assert_eq!(default_zones[2]["kind"], "bento-grid");
        assert_eq!(default_zones[2]["columns"], 4);
        assert_eq!(
            default_zones[2]["tileIds"],
            serde_json::json!([
                "remote.back",
                "remote.mute",
                "remote.vol_down",
                "remote.vol_up"
            ])
        );
        assert!(default_json["pages"][1].get("zones").is_none());
        assert_eq!(default_json["pages"][0]["tiles"][0]["rowSpan"], 1);

        // Legacy tile JSON omitting rowSpan must deserialize with row_span == 1
        let legacy_tile: MobileTile = serde_json::from_value(serde_json::json!({
            "id": "legacy.1",
            "label": "旧版按键",
            "icon": "sparkles",
            "accent": "blue",
            "colSpan": 1,
            "mode": "gesture"
        }))
        .unwrap();
        assert_eq!(legacy_tile.row_span, 1);

        // Build a 32-tile mixed Bento + PointerPad + Dpad3x3 page with 1x2, 2x2, and out-of-bounds spans
        let mut tiles = Vec::new();
        for idx in 0..32 {
            let mut t = tile(
                &format!("custom.t{idx}"),
                &format!("键 {idx}"),
                "sparkles",
                TileAccent::Blue,
                if idx == 0 { 9 } else { 1 }, // idx 0 clamps col_span 9 -> 2
            );
            t.row_span = match idx {
                0 => 2, // 2x2 hero pad
                1 => 5, // clamps 5 -> 2 (1x2 vertical rocker)
                2 => 0, // clamps 0 -> 1 (1x1 standard)
                _ => 1,
            };
            tiles.push(t);
        }

        let zones = vec![
            MobileDeckZone {
                id: "  zone-pad  ".into(),
                kind: DeckZoneKind::PointerPad,
                columns: None,
                pointer_mode: Some(EmbeddedPointerMode::Trackpad),
                pad_height: None,
                show_buttons: None,
                tile_ids: Vec::new(),
            },
            MobileDeckZone {
                id: "zone-dpad".into(),
                kind: DeckZoneKind::Dpad3x3,
                columns: None,
                pointer_mode: None,
                pad_height: None,
                show_buttons: None,
                tile_ids: vec![
                    "".into(),
                    "custom.t0".into(),
                    "".into(),
                    "custom.t1".into(),
                    "custom.t2".into(),
                    "custom.t3".into(),
                    "".into(),
                    "custom.t4".into(),
                    "".into(),
                ],
            },
            MobileDeckZone {
                id: "zone-bento".into(),
                kind: DeckZoneKind::BentoGrid,
                columns: Some(4),
                pointer_mode: None,
                pad_height: None,
                show_buttons: None,
                tile_ids: (5..32).map(|i| format!("custom.t{i}")).collect(),
            },
        ];

        let custom_page = MobileDeckPage {
            id: "mixed-bento".into(),
            name: "混排面板".into(),
            layout: PageLayout::Grid,
            columns: 3,
            tiles,
            zones,
        };

        let (rev2, snap2) = store
            .apply_layout_patch(
                1,
                DeckLayoutPatch {
                    active_page_id: Some("mixed-bento".into()),
                    pages: Some(vec![custom_page.clone()]),
                    ..Default::default()
                },
            )
            .ok()
            .expect("32 tiles and 3 valid zones should succeed");
        assert_eq!(rev2, 2);
        let saved_page = &snap2.pages[0];
        assert_eq!(saved_page.tiles[0].col_span, 2);
        assert_eq!(saved_page.tiles[0].row_span, 2);
        assert_eq!(saved_page.tiles[1].col_span, 1);
        assert_eq!(saved_page.tiles[1].row_span, 2);
        assert_eq!(saved_page.tiles[2].row_span, 1);
        assert_eq!(saved_page.zones[0].id, "zone-pad");

        // Verify exact wire strings for DeckZoneKind and EmbeddedPointerMode + persistence reload
        let wire = serde_json::to_value(&saved_page.zones).unwrap();
        assert_eq!(wire[0]["kind"], "pointer-pad");
        assert_eq!(wire[0]["pointerMode"], "trackpad");
        assert_eq!(wire[1]["kind"], "dpad-3x3");
        assert_eq!(wire[2]["kind"], "bento-grid");
        assert_eq!(wire[2]["columns"], 4);

        let reloaded = DeckStore::load(path).unwrap();
        assert_eq!(reloaded.snapshot(), snap2);

        // Validation: reject invalid zone columns (1 or 5), empty zone.id, >6 zones, >32 tiles
        let mut bad_col_page = custom_page.clone();
        bad_col_page.zones[2].columns = Some(5);
        assert!(matches!(
            store.apply_layout_patch(
                rev2,
                DeckLayoutPatch {
                    pages: Some(vec![bad_col_page]),
                    ..Default::default()
                }
            ),
            Err(DeckUpdateError::Invalid(_))
        ));

        let mut empty_zone_id_page = custom_page.clone();
        empty_zone_id_page.zones[0].id = "   ".into();
        assert!(matches!(
            store.apply_layout_patch(
                rev2,
                DeckLayoutPatch {
                    pages: Some(vec![empty_zone_id_page]),
                    ..Default::default()
                }
            ),
            Err(DeckUpdateError::Invalid(_))
        ));

        let mut too_many_zones_page = custom_page.clone();
        too_many_zones_page.zones = (0..7)
            .map(|i| MobileDeckZone {
                id: format!("z-{i}"),
                kind: DeckZoneKind::BentoGrid,
                columns: Some(3),
                pointer_mode: None,
                pad_height: None,
                show_buttons: None,
                tile_ids: Vec::new(),
            })
            .collect();
        assert!(matches!(
            store.apply_layout_patch(
                rev2,
                DeckLayoutPatch {
                    pages: Some(vec![too_many_zones_page]),
                    ..Default::default()
                }
            ),
            Err(DeckUpdateError::Invalid(_))
        ));

        let mut too_many_tiles_page = custom_page;
        too_many_tiles_page.tiles.push(tile(
            "custom.t32",
            "超限",
            "sparkles",
            TileAccent::Slate,
            1,
        ));
        assert!(matches!(
            store.apply_layout_patch(
                rev2,
                DeckLayoutPatch {
                    pages: Some(vec![too_many_tiles_page]),
                    ..Default::default()
                }
            ),
            Err(DeckUpdateError::Invalid(_))
        ));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hold_mode_extracts_tap_keys_updates_silkscreen_and_decouples_profile_from_layout() {
        use super::super::protocol::{DeckZoneKind, EmbeddedPointerMode, MobileDeckZone};
        use crate::input_service::TriggerBehaviors;
        use std::collections::HashSet;

        let dir = std::env::temp_dir().join(format!("axonkey-deck-v3-hold-{}", Uuid::new_v4()));
        let path = dir.join("mobile-deck.json");
        let mut store = DeckStore::load(path).unwrap();

        let mut hold_space = tile(
            "custom.hold_space",
            "按住空格",
            "play",
            TileAccent::Emerald,
            1,
        );
        hold_space.row_span = 2; // 1x2 tall strip
        hold_space.mode = TileMode::Hold;

        let mut hold_combo = tile(
            "custom.hold_combo",
            "组合键按住",
            "command",
            TileAccent::Violet,
            2,
        );
        hold_combo.row_span = 2; // 2x2 hero pad
        hold_combo.mode = TileMode::Hold;

        let custom_zones = vec![
            MobileDeckZone {
                id: "top-pad".into(),
                kind: DeckZoneKind::PointerPad,
                columns: None,
                pointer_mode: Some(EmbeddedPointerMode::Relative),
                pad_height: None,
                show_buttons: None,
                tile_ids: Vec::new(),
            },
            MobileDeckZone {
                id: "bottom-bento".into(),
                kind: DeckZoneKind::BentoGrid,
                columns: Some(3),
                pointer_mode: None,
                pad_height: None,
                show_buttons: None,
                tile_ids: vec!["custom.hold_space".into(), "custom.hold_combo".into()],
            },
        ];

        let (_, layout_snap) = store
            .apply_layout_patch(
                1,
                DeckLayoutPatch {
                    active_page_id: Some("game-layout".into()),
                    pages: Some(vec![MobileDeckPage {
                        id: "game-layout".into(),
                        name: "游戏混排".into(),
                        layout: PageLayout::Grid,
                        columns: 3,
                        tiles: vec![hold_space, hold_combo],
                        zones: custom_zones.clone(),
                    }]),
                    ..Default::default()
                },
            )
            .ok()
            .unwrap();
        assert_eq!(layout_snap.active_page_id, "game-layout");

        // Profile A: Desktop right-hand lane binds `click` (mapped to `tap`) with Key & Shortcut
        let mut prof_a = HashMap::new();
        prof_a.insert(
            "custom.hold_space".to_owned(),
            TriggerBehaviors {
                click: vec![key("Space")],
                ..Default::default()
            },
        );
        prof_a.insert(
            "custom.hold_combo".to_owned(),
            TriggerBehaviors {
                click: vec![shortcut(&["Control", "Shift"])],
                ..Default::default()
            },
        );
        let prev_empty = HashSet::new();
        let (_, snap_prof_a) = store
            .sync_from_managed_profile_with_previous(&prof_a, &prev_empty)
            .unwrap()
            .expect("Profile A should update bindings");

        assert_eq!(
            store.resolve_hold_keys("custom.hold_space"),
            Some(vec!["Space".to_owned()])
        );
        assert_eq!(
            store.resolve_hold_keys("custom.hold_combo"),
            Some(vec!["Control".to_owned(), "Shift".to_owned()])
        );
        assert_eq!(
            snap_prof_a.pages[0].tiles[0].action_summary.as_deref(),
            Some("按住 Space")
        );
        assert_eq!(
            snap_prof_a.pages[0].tiles[1].action_summary.as_deref(),
            Some("按住 Ctrl+Shift")
        );

        // Profile B: Switch Desktop profile -> layout (active_page_id, pages, zones, spans) MUST NOT change!
        let prev_a: HashSet<String> = prof_a.keys().cloned().collect();
        let mut prof_b = HashMap::new();
        prof_b.insert(
            "custom.hold_space".to_owned(),
            TriggerBehaviors {
                click: vec![key("Escape")],
                ..Default::default()
            },
        );
        let (_, snap_prof_b) = store
            .sync_from_managed_profile_with_previous(&prof_b, &prev_a)
            .unwrap()
            .expect("Profile B should update bindings");

        assert_eq!(snap_prof_b.active_page_id, "game-layout");
        assert_eq!(snap_prof_b.pages.len(), 1);
        assert_eq!(snap_prof_b.pages[0].zones, custom_zones);
        assert_eq!(snap_prof_b.pages[0].tiles[0].row_span, 2);
        assert_eq!(snap_prof_b.pages[0].tiles[1].col_span, 2);
        assert_eq!(snap_prof_b.pages[0].tiles[1].row_span, 2);
        assert_eq!(
            snap_prof_b.pages[0].tiles[0].action_summary.as_deref(),
            Some("按住 Esc")
        );
        assert_eq!(snap_prof_b.pages[0].tiles[1].action_summary, None);
        assert_eq!(store.resolve_hold_keys("custom.hold_combo"), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gesture_pad_and_embedded_pad_options_validate_and_roundtrip_wire_json() {
        let dir = std::env::temp_dir().join(format!("axonkey-deck-v4-gpad-{}", Uuid::new_v4()));
        let path = dir.join("mobile-deck.json");
        let mut store = DeckStore::load(path.clone()).unwrap();

        let g_tiles = vec![
            tile("g.up", "上滑", "arrow-up", TileAccent::Blue, 1),
            tile("g.down", "下滑", "arrow-down", TileAccent::Slate, 1),
            tile("g.left", "左滑", "arrow-left", TileAccent::Slate, 1),
            tile("g.right", "右滑", "arrow-right", TileAccent::Slate, 1),
            tile("g.tap", "轻点", "enter", TileAccent::Emerald, 1),
            tile("g.double", "双击", "sparkles", TileAccent::Violet, 1),
        ];

        let valid_page = MobileDeckPage {
            id: "gesture-page".into(),
            name: "手势与触控".into(),
            layout: PageLayout::Grid,
            columns: 2,
            tiles: g_tiles.clone(),
            zones: vec![
                MobileDeckZone {
                    id: "ptr-compact".into(),
                    kind: DeckZoneKind::PointerPad,
                    columns: None,
                    pointer_mode: Some(EmbeddedPointerMode::Trackpad),
                    pad_height: Some(EmbeddedPadHeight::Compact),
                    show_buttons: Some(false),
                    tile_ids: Vec::new(),
                },
                MobileDeckZone {
                    id: "gpad-main".into(),
                    kind: DeckZoneKind::GesturePad,
                    columns: None,
                    pointer_mode: None,
                    pad_height: Some(EmbeddedPadHeight::Tall),
                    show_buttons: None,
                    tile_ids: vec![
                        "g.up".into(),
                        "g.down".into(),
                        "".into(), // empty slot allowed!
                        "g.right".into(),
                        "g.tap".into(),
                        "g.double".into(),
                    ],
                },
            ],
        };

        let (rev2, snap2) = store
            .apply_layout_patch(
                1,
                DeckLayoutPatch {
                    active_page_id: Some("gesture-page".into()),
                    pages: Some(vec![valid_page.clone()]),
                    ..Default::default()
                },
            )
            .ok()
            .expect("valid gesture-pad with <= 6 slots and empty slot should succeed");

        let wire = serde_json::to_value(&snap2.pages[0].zones).unwrap();
        assert_eq!(wire[0]["kind"], "pointer-pad");
        assert_eq!(wire[0]["padHeight"], "compact");
        assert_eq!(wire[0]["showButtons"], false);
        assert_eq!(wire[1]["kind"], "gesture-pad");
        assert_eq!(wire[1]["padHeight"], "tall");
        assert!(wire[1].get("showButtons").is_none());

        // Reject > 6 slots in gesture-pad
        let mut seven_slots_page = valid_page.clone();
        seven_slots_page.zones[1].tile_ids.push("g.left".into());
        assert!(matches!(
            store.apply_layout_patch(
                rev2,
                DeckLayoutPatch {
                    pages: Some(vec![seven_slots_page]),
                    ..Default::default()
                }
            ),
            Err(DeckUpdateError::Invalid(_))
        ));

        // Reject non-existent tile_id in gesture-pad
        let mut missing_tile_page = valid_page;
        missing_tile_page.zones[1].tile_ids[2] = "nonexistent.tile".into();
        assert!(matches!(
            store.apply_layout_patch(
                rev2,
                DeckLayoutPatch {
                    pages: Some(vec![missing_tile_page]),
                    ..Default::default()
                }
            ),
            Err(DeckUpdateError::Invalid(_))
        ));

        let reloaded = DeckStore::load(path).unwrap();
        assert_eq!(reloaded.snapshot(), snap2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn starter_presets_and_voice_presets_cover_all_16_combinations_and_blank_pure_mic_is_empty() {
        use std::collections::HashSet;

        let dir = std::env::temp_dir().join(format!("axonkey-deck-v4-presets-{}", Uuid::new_v4()));
        let path = dir.join("mobile-deck.json");
        let mut store = DeckStore::load(path.clone()).unwrap();

        let all_presets = [
            StarterPresetId::DailyRemote,
            StarterPresetId::VibeCoding,
            StarterPresetId::PresentationMedia,
            StarterPresetId::BlankCanvas,
        ];
        let all_voices = [
            VoicePresetKind::DoubaoAlt,
            VoicePresetKind::SystemWinH,
            VoicePresetKind::CtrlWin,
            VoicePresetKind::PureMic,
        ];

        for preset in all_presets {
            for voice in all_voices {
                let prev_rev = store.revision();
                let (rev, snap, bindings) = store.apply_preset(preset, Some(voice)).unwrap();
                assert_eq!(rev, prev_rev + 1);
                assert!(!snap.pages.is_empty());
                assert!(snap.pages.iter().any(|p| p.id == snap.active_page_id));

                match voice {
                    VoicePresetKind::DoubaoAlt => {
                        assert_eq!(store.resolve_voice_hold_keys(), vec!["Alt".to_owned()]);
                        assert_eq!(snap.voice_binding_summary.as_deref(), Some("Alt"));
                    }
                    VoicePresetKind::SystemWinH => {
                        assert_eq!(
                            store.resolve_voice_hold_keys(),
                            vec!["Win".to_owned(), "H".to_owned()]
                        );
                        assert_eq!(snap.voice_binding_summary.as_deref(), Some("Win+H"));
                    }
                    VoicePresetKind::CtrlWin => {
                        assert_eq!(
                            store.resolve_voice_hold_keys(),
                            vec!["Ctrl".to_owned(), "Win".to_owned()]
                        );
                        assert_eq!(snap.voice_binding_summary.as_deref(), Some("Ctrl+Win"));
                    }
                    VoicePresetKind::PureMic => {
                        assert!(store.resolve_voice_hold_keys().is_empty());
                        assert_eq!(snap.voice_binding_summary, None);
                        assert!(!bindings.contains_key(VOICE_KEY_ID));
                    }
                }

                if preset == StarterPresetId::BlankCanvas && voice == VoicePresetKind::PureMic {
                    assert!(
                        bindings.is_empty(),
                        "blank-canvas + pure-mic must have 100% empty bindings"
                    );
                    assert!(bindings_to_trigger_behaviors_dto(&bindings).is_empty());
                    for t in &snap.pages[0].tiles {
                        assert_eq!(t.action_summary, None);
                    }
                } else if preset != StarterPresetId::BlankCanvas {
                    assert!(!bindings.is_empty());
                }
            }
        }

        // Verify default voicePreset == None on BlankCanvas defaults to PureMic (empty bindings!)
        // and survives disk reload + idempotent Desktop profile sync without restoring Alt!
        let (rev_blank, snap_blank, bindings_blank) = store
            .apply_preset(StarterPresetId::BlankCanvas, None)
            .unwrap();
        assert!(bindings_blank.is_empty());
        assert_eq!(snap_blank.voice_binding_summary, None);
        assert_eq!(snap_blank.pages.len(), 1);
        assert_eq!(snap_blank.pages[0].name, "自定义面板");
        assert_eq!(snap_blank.pages[0].columns, 2);
        assert_eq!(snap_blank.pages[0].tiles.len(), 4);

        let prev_keys: HashSet<String> = [
            "remote.esc".to_owned(),
            "tile.continue".to_owned(),
            VOICE_KEY_ID.to_owned(),
        ]
        .into_iter()
        .collect();
        let sync_res = store
            .sync_from_managed_profile_with_previous(&HashMap::new(), &prev_keys)
            .unwrap();
        assert!(
            sync_res.is_none(),
            "Desktop syncing back empty behaviors after blank-canvas must be a clean no-op"
        );
        assert_eq!(store.revision(), rev_blank);

        let reloaded = DeckStore::load(path).unwrap();
        assert!(reloaded.bindings().is_empty());
        assert_eq!(reloaded.snapshot().voice_binding_summary, None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn voice_hold_keys_ignores_residual_long_slot_and_falls_back_to_long_when_tap_empty() {
        let dir = std::env::temp_dir().join(format!("axonkey-voice-hold-{}", Uuid::new_v4()));
        let mut store = DeckStore::load(dir.join("mobile-deck.json")).unwrap();

        // Case 1: User configured `单击: RAlt` AND also left an item in `长按` -> must still hold `RAlt`!
        store
            .set_tile_binding(
                VOICE_KEY_ID.into(),
                TileActionBindings {
                    tap: vec![key("RAlt")],
                    double: Vec::new(),
                    long: vec![key("Alt")],
                    hold_keys: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(store.resolve_voice_hold_keys(), vec!["RAlt".to_owned()]);

        // Case 2: User put `RAlt` only under `长按` (`单击` empty) -> falls back to `长按`!
        store
            .set_tile_binding(
                VOICE_KEY_ID.into(),
                TileActionBindings {
                    tap: Vec::new(),
                    double: Vec::new(),
                    long: vec![key("RAlt")],
                    hold_keys: Vec::new(),
                },
            )
            .unwrap();
        assert_eq!(store.resolve_voice_hold_keys(), vec!["RAlt".to_owned()]);

        let _ = fs::remove_dir_all(&dir);
    }
}
