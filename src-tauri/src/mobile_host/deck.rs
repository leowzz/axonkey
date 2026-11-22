use super::protocol::{
    DeckLayoutPatch, DeckSnapshot, MobileDeckPage, MobileTile, PageLayout, TileAccent,
    TileGestureKind, TileMode,
};
use crate::input_service::NativeBehavior;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const MAX_PAGES: usize = 8;
const MAX_TILES_PER_PAGE: usize = 24;
pub const VOICE_KEY_ID: &str = "mobile.voice";

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDeck {
    version: u32,
    revision: u64,
    snapshot: DeckSnapshot,
    bindings: HashMap<String, TileActionBindings>,
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
}

impl DeckStore {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        if path.exists() {
            let bytes =
                fs::read(&path).map_err(|e| format!("Failed to read mobile-deck.json: {e}"))?;
            let persisted: PersistedDeck = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Corrupt mobile-deck.json (refusing silent reset): {e}"))?;
            let mut store = Self {
                path,
                revision: persisted.revision.max(1),
                snapshot: persisted.snapshot,
                bindings: persisted.bindings,
            };
            let inserted_default_voice = !store.bindings.contains_key(VOICE_KEY_ID);
            if inserted_default_voice {
                store.bindings.insert(
                    VOICE_KEY_ID.into(),
                    TileActionBindings {
                        tap: vec![key("Alt")],
                        ..Default::default()
                    },
                );
            }
            store.rehydrate_tile_metadata();
            if inserted_default_voice {
                let _ = store.save();
            }
            return Ok(store);
        }
        let (snapshot, bindings) = default_mobile_deck();
        let mut store = Self {
            path,
            revision: 1,
            snapshot,
            bindings,
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
        let has_double = binding.double.iter().any(|b| b.enabled());
        let has_long = binding.long.iter().any(|b| b.enabled());
        if !has_double && !has_long {
            let mut enabled_tap = binding.tap.iter().filter(|b| b.enabled());
            if let (Some(only), None) = (enabled_tap.next(), enabled_tap.next()) {
                return match only {
                    NativeBehavior::Key { key, .. } if !key.trim().is_empty() => {
                        vec![key.clone()]
                    }
                    NativeBehavior::Shortcut { keys, .. } if !keys.is_empty() => keys.clone(),
                    _ => Vec::new(),
                };
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
        if binding.hold_keys.is_empty() {
            None
        } else {
            Some(binding.hold_keys.clone())
        }
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
    /// active profile (and restores defaults for keys removed since the previous managed profile),
    /// re-derives `action_summary` + `voice_binding_summary`, and bumps revision if anything changed.
    pub fn sync_from_managed_profile_with_previous(
        &mut self,
        behaviors: &HashMap<String, crate::input_service::TriggerBehaviors>,
        previous_managed_keys: &std::collections::HashSet<String>,
    ) -> Result<Option<(u64, DeckSnapshot)>, String> {
        let mut changed = false;
        let defaults = default_mobile_deck().1;
        for removed_key in previous_managed_keys {
            if behaviors.contains_key(removed_key) {
                continue;
            }
            let fallback = defaults.get(removed_key).cloned().unwrap_or_default();
            let same = self.bindings.get(removed_key).is_some_and(|p| {
                p.tap == fallback.tap
                    && p.double == fallback.double
                    && p.long == fallback.long
                    && p.hold_keys == fallback.hold_keys
            });
            if !same {
                self.bindings.insert(removed_key.clone(), fallback);
                changed = true;
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
            let same = prev.is_some_and(|p| {
                p.tap == next.tap
                    && p.double == next.double
                    && p.long == next.long
                    && p.hold_keys.is_empty()
            });
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
                for tile in &mut page.tiles {
                    if tile.id.trim().is_empty() || tile.label.trim().is_empty() {
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
                if let Some(b) = self.bindings.get(&tile.id) {
                    tile.has_double_click = !b.double.is_empty();
                    tile.has_long_press = !b.long.is_empty();
                    tile.action_summary = summarize_binding(b);
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

pub fn summarize_binding(binding: &TileActionBindings) -> Option<String> {
    if !binding.hold_keys.is_empty() {
        return Some(format!("按住 {}", binding.hold_keys.join("+")));
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
        "ArrowUp" => "↑".into(),
        "ArrowDown" => "↓".into(),
        "ArrowLeft" => "←".into(),
        "ArrowRight" => "→".into(),
        "AudioVolumeUp" => "音量+".into(),
        "AudioVolumeDown" => "音量-".into(),
        "AudioVolumeMute" => "静音".into(),
        "MediaPlayPause" => "播放/暂停".into(),
        "MediaTrackPrevious" => "上一曲".into(),
        "MediaTrackNext" => "下一曲".into(),
        "Backspace" => "退格".into(),
        other => other.to_owned(),
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
                    tile("remote.esc", "退出/中断", "esc", TileAccent::Rose, 1),
                    tile("remote.menu", "命令菜单", "search", TileAccent::Blue, 1),
                    tile("remote.up", "上", "arrow-up", TileAccent::Slate, 1),
                    tile("remote.down", "下", "arrow-down", TileAccent::Slate, 1),
                    tile("remote.left", "左", "arrow-left", TileAccent::Slate, 1),
                    tile("remote.right", "右", "arrow-right", TileAccent::Slate, 1),
                    tile("remote.ok", "确认", "enter", TileAccent::Blue, 1),
                    tile("remote.back", "返回", "undo", TileAccent::Slate, 1),
                    tile("remote.home", "主页/对话", "command", TileAccent::Slate, 1),
                    tile("remote.vol_up", "音量+", "volume-up", TileAccent::Slate, 1),
                    tile(
                        "remote.vol_down",
                        "音量-",
                        "volume-mute",
                        TileAccent::Slate,
                        1,
                    ),
                    tile("remote.mute", "静音", "volume-mute", TileAccent::Slate, 1),
                    tile("remote.q1", "继续执行", "sparkles", TileAccent::Blue, 1),
                    tile("remote.q2", "接受变更", "check", TileAccent::Emerald, 1),
                    tile("remote.q3", "撤销", "undo", TileAccent::Amber, 1),
                    tile("remote.q4", "播放/暂停", "play", TileAccent::Violet, 1),
                ],
            },
            MobileDeckPage {
                id: "vibe-coding".into(),
                name: "Vibe Coding".into(),
                layout: PageLayout::Grid,
                columns: 3,
                tiles: vec![
                    tile("tile.continue", "继续执行", "sparkles", TileAccent::Blue, 2),
                    tile("tile.enter", "确认", "enter", TileAccent::Emerald, 1),
                    tile("tile.accept", "接受变更", "check", TileAccent::Emerald, 1),
                    tile("tile.undo", "撤销", "undo", TileAccent::Amber, 1),
                    tile("tile.esc", "中断", "esc", TileAccent::Rose, 1),
                    tile("tile.copy", "复制", "copy", TileAccent::Slate, 1),
                    tile("tile.paste", "粘贴", "clipboard", TileAccent::Slate, 1),
                    tile("tile.terminal", "终端", "terminal", TileAccent::Violet, 1),
                ],
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
}
