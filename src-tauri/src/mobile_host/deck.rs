use super::protocol::{
    DeckLayoutPatch, DeckSnapshot, MobileDeckPage, MobileTile, TileAccent, TileGestureKind,
    TileMode,
};
use crate::input_service::NativeBehavior;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const MAX_PAGES: usize = 8;
const MAX_TILES_PER_PAGE: usize = 24;

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
            return Ok(Self {
                path,
                revision: persisted.revision.max(1),
                snapshot: persisted.snapshot,
                bindings: persisted.bindings,
            });
        }
        let (snapshot, bindings) = default_vibe_coding_deck();
        let store = Self {
            path,
            revision: 1,
            snapshot,
            bindings,
        };
        store.save()?;
        Ok(store)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn snapshot(&self) -> DeckSnapshot {
        self.snapshot.clone()
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
                return Err(DeckUpdateError::Invalid("trackpadSplit 必须在 0..=1 之间".into()));
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
                    // Preserve authoritative gesture-capability flags from desktop bindings.
                    if let Some(b) = self.bindings.get(&tile.id) {
                        tile.has_double_click = !b.double.is_empty();
                        tile.has_long_press = !b.long.is_empty();
                    }
                }
                sanitized_pages.push(page);
            }
            next.pages = sanitized_pages;
        }
        if let Some(active) = patch.active_page_id {
            if !next.pages.iter().any(|p| p.id == active) {
                return Err(DeckUpdateError::Invalid("activePageId 不存在于当前页面列表".into()));
            }
            next.active_page_id = active;
        } else if !next.pages.iter().any(|p| p.id == next.active_page_id) {
            next.active_page_id = next.pages[0].id.clone();
        }

        let next_revision = self.revision + 1;
        let backup_rev = self.revision;
        let backup_snap = std::mem::replace(&mut self.snapshot, next);
        self.revision = next_revision;
        if let Err(io_err) = self.save() {
            self.snapshot = backup_snap;
            self.revision = backup_rev;
            return Err(DeckUpdateError::Io(io_err));
        }
        Ok((self.revision, self.snapshot.clone()))
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

fn default_vibe_coding_deck() -> (DeckSnapshot, HashMap<String, TileActionBindings>) {
    let mut bindings = HashMap::new();

    bindings.insert(
        "tile.continue".into(),
        TileActionBindings {
            tap: vec![paste("继续执行，完成后汇报验证结果。"), key("Enter")],
            double: vec![],
            long: vec![paste("先停下来检查当前改动是否有边界问题，再继续。"), key("Enter")],
            hold_keys: vec![],
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
    bindings.insert(
        "tile.search".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "K"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.save".into(),
        TileActionBindings {
            tap: vec![shortcut(&["Control", "S"])],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.prev".into(),
        TileActionBindings {
            tap: vec![key("MediaTrackPrevious")],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.play".into(),
        TileActionBindings {
            tap: vec![key("MediaPlayPause")],
            ..Default::default()
        },
    );
    bindings.insert(
        "tile.next".into(),
        TileActionBindings {
            tap: vec![key("MediaTrackNext")],
            ..Default::default()
        },
    );

    let snapshot = DeckSnapshot {
        version: 1,
        active_page_id: "vibe-coding".into(),
        trackpad_split: 0.35,
        pointer_sensitivity: 1.4,
        scroll_sensitivity: 1.0,
        double_click_window_ms: 300,
        long_press_window_ms: 600,
        pages: vec![
            MobileDeckPage {
                id: "vibe-coding".into(),
                name: "Vibe Coding".into(),
                columns: 3,
                tiles: vec![
                    MobileTile {
                        id: "tile.continue".into(),
                        label: "继续执行".into(),
                        subtitle: Some("发送提示词".into()),
                        icon: "sparkles".into(),
                        accent: TileAccent::Blue,
                        col_span: 2,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: true,
                    },
                    MobileTile {
                        id: "tile.enter".into(),
                        label: "确认".into(),
                        subtitle: Some("Enter".into()),
                        icon: "enter".into(),
                        accent: TileAccent::Emerald,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.accept".into(),
                        label: "接受变更".into(),
                        subtitle: Some("Ctrl+Enter".into()),
                        icon: "check".into(),
                        accent: TileAccent::Emerald,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.undo".into(),
                        label: "撤销".into(),
                        subtitle: Some("Ctrl+Z".into()),
                        icon: "undo".into(),
                        accent: TileAccent::Amber,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: true,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.esc".into(),
                        label: "中断".into(),
                        subtitle: Some("Esc".into()),
                        icon: "esc".into(),
                        accent: TileAccent::Rose,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.copy".into(),
                        label: "复制".into(),
                        subtitle: Some("Ctrl+C".into()),
                        icon: "copy".into(),
                        accent: TileAccent::Slate,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.paste".into(),
                        label: "粘贴".into(),
                        subtitle: Some("Ctrl+V".into()),
                        icon: "clipboard".into(),
                        accent: TileAccent::Slate,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.terminal".into(),
                        label: "终端".into(),
                        subtitle: Some("Ctrl+`".into()),
                        icon: "terminal".into(),
                        accent: TileAccent::Violet,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                ],
            },
            MobileDeckPage {
                id: "nav-media".into(),
                name: "导航与媒体".into(),
                columns: 3,
                tiles: vec![
                    MobileTile {
                        id: "tile.search".into(),
                        label: "全局搜索".into(),
                        subtitle: Some("Ctrl+K".into()),
                        icon: "search".into(),
                        accent: TileAccent::Blue,
                        col_span: 2,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.save".into(),
                        label: "保存".into(),
                        subtitle: Some("Ctrl+S".into()),
                        icon: "save".into(),
                        accent: TileAccent::Emerald,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.prev".into(),
                        label: "上一曲".into(),
                        subtitle: None,
                        icon: "skip-back".into(),
                        accent: TileAccent::Slate,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.play".into(),
                        label: "播放/暂停".into(),
                        subtitle: None,
                        icon: "play".into(),
                        accent: TileAccent::Violet,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
                    MobileTile {
                        id: "tile.next".into(),
                        label: "下一曲".into(),
                        subtitle: None,
                        icon: "skip-forward".into(),
                        accent: TileAccent::Slate,
                        col_span: 1,
                        mode: TileMode::Gesture,
                        has_double_click: false,
                        has_long_press: false,
                    },
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
                assert_eq!(c.revision, 2);
                assert!((c.snapshot.trackpad_split - 0.5).abs() < f64::EPSILON);
            }
            _ => panic!("Expected DeckUpdateError::Conflict"),
        }

        // Reloading from disk preserves revision 2.
        let reloaded = DeckStore::load(path).unwrap();
        assert_eq!(reloaded.revision(), 2);
        let _ = fs::remove_dir_all(&dir);
    }
}
