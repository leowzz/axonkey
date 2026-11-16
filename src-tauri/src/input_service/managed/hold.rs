use super::super::{NativeBehavior, TriggerBehaviors};
use crate::devices::kivo_k18_lite::format_key_chord_summary;
use std::{
    collections::HashMap,
    hash::Hash,
    sync::{Mutex, MutexGuard},
};

pub(super) fn output_lock() -> MutexGuard<'static, ()> {
    static OUTPUT: Mutex<()> = Mutex::new(());
    OUTPUT.lock().unwrap_or_else(|e| e.into_inner())
}

pub(super) fn hold_behavior(mapping: &TriggerBehaviors) -> Option<&NativeBehavior> {
    if mapping.double_click.iter().any(NativeBehavior::enabled)
        || mapping.long_press.iter().any(NativeBehavior::enabled)
    {
        return None;
    }
    let mut clicks = mapping.click.iter().filter(|b| b.enabled());
    let behavior = clicks.next()?;
    if clicks.next().is_some() {
        return None;
    }
    matches!(
        behavior,
        NativeBehavior::Key { .. } | NativeBehavior::Shortcut { .. }
    )
    .then_some(behavior)
}

fn behavior_tokens(behavior: &NativeBehavior) -> Vec<String> {
    match behavior {
        NativeBehavior::Key { key, .. } => vec![key.clone()],
        NativeBehavior::Shortcut { keys, .. } => keys.clone(),
        _ => Vec::new(),
    }
}

struct Lease<K> {
    instance_id: String,
    input_key: String,
    chord: Vec<K>,
    tokens: Vec<String>,
}

pub(super) struct HoldPool<K> {
    leases: Vec<Lease<K>>,
    counts: HashMap<K, usize>,
}

impl<K> Default for HoldPool<K> {
    fn default() -> Self {
        Self {
            leases: Vec::new(),
            counts: HashMap::new(),
        }
    }
}

impl<K: Copy + Eq + Hash> HoldPool<K> {
    pub fn press(
        &mut self,
        instance_id: &str,
        input_key: &str,
        chord: Vec<K>,
        tokens: Vec<String>,
        macos_labels: bool,
    ) -> Option<(Vec<(K, bool)>, String)> {
        if chord.is_empty()
            || self
                .leases
                .iter()
                .any(|l| l.instance_id == instance_id && l.input_key == input_key)
        {
            return None;
        }
        let mut unique = Vec::with_capacity(chord.len());
        for key in chord {
            if !unique.contains(&key) {
                unique.push(key);
            }
        }
        let mut edges = Vec::new();
        for &key in &unique {
            let count = self.counts.entry(key).or_insert(0);
            *count += 1;
            if *count == 1 {
                edges.push((key, true));
            }
        }
        self.leases.push(Lease {
            instance_id: instance_id.to_owned(),
            input_key: input_key.to_owned(),
            chord: unique,
            tokens,
        });
        let all_tokens: Vec<String> = self
            .leases
            .iter()
            .filter(|l| l.instance_id == instance_id)
            .flat_map(|l| l.tokens.iter().cloned())
            .collect();
        let summary = format_key_chord_summary(&all_tokens, macos_labels);
        Some((edges, summary))
    }

    pub fn release(&mut self, instance_id: &str, input_key: &str) -> Option<Vec<(K, bool)>> {
        let index = self
            .leases
            .iter()
            .position(|l| l.instance_id == instance_id && l.input_key == input_key)?;
        let lease = self.leases.remove(index);
        Some(self.decrement_chord(lease.chord))
    }

    pub fn release_instance(&mut self, instance_id: &str) -> Vec<(K, bool)> {
        let mut edges = Vec::new();
        for index in (0..self.leases.len()).rev() {
            if self.leases[index].instance_id == instance_id {
                let lease = self.leases.remove(index);
                edges.extend(self.decrement_chord(lease.chord));
            }
        }
        edges
    }

    fn decrement_chord(&mut self, chord: Vec<K>) -> Vec<(K, bool)> {
        let mut edges = Vec::new();
        for key in chord.into_iter().rev() {
            if let Some(count) = self.counts.get_mut(&key) {
                *count -= 1;
                if *count == 0 {
                    self.counts.remove(&key);
                    edges.push((key, false));
                }
            }
        }
        edges
    }
}

#[cfg(target_os = "macos")]
type PlatformHoldKey = super::super::macos::MacKey;
#[cfg(windows)]
type PlatformHoldKey = u16;
#[cfg(not(any(target_os = "macos", windows)))]
type PlatformHoldKey = String;

fn platform_chord(behavior: &NativeBehavior) -> Option<Vec<PlatformHoldKey>> {
    #[cfg(target_os = "macos")]
    {
        super::super::macos::managed_hold_chord(behavior)
    }
    #[cfg(windows)]
    {
        super::super::windows::managed_hold_chord(behavior)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let tokens = behavior_tokens(behavior);
        (!tokens.is_empty()).then_some(tokens)
    }
}

fn emit_platform_edges(edges: &[(PlatformHoldKey, bool)]) {
    if edges.is_empty() {
        return;
    }
    let _guard = output_lock();
    for &(ref key, down) in edges {
        #[cfg(target_os = "macos")]
        super::super::macos::post_managed_held_key(*key, down);
        #[cfg(windows)]
        super::super::windows::send_managed_held_key(*key, down);
        #[cfg(not(any(target_os = "macos", windows)))]
        let _ = (key, down);
    }
}

pub(super) enum HoldOutcome {
    PassToGestures,
    Handled { triggered_summary: Option<String> },
}

#[derive(Default)]
pub(super) struct ManagedHolds {
    pool: Mutex<HoldPool<PlatformHoldKey>>,
}

impl ManagedHolds {
    pub fn try_edge(
        &self,
        instance_id: &str,
        input_key: &str,
        down: bool,
        mapping: &TriggerBehaviors,
    ) -> HoldOutcome {
        if !down {
            let released = self.pool.lock().unwrap().release(instance_id, input_key);
            if let Some(edges) = released {
                emit_platform_edges(&edges);
                return HoldOutcome::Handled {
                    triggered_summary: None,
                };
            }
            if hold_behavior(mapping).and_then(platform_chord).is_some() {
                return HoldOutcome::Handled {
                    triggered_summary: None,
                };
            }
            return HoldOutcome::PassToGestures;
        }

        let Some(behavior) = hold_behavior(mapping) else {
            return HoldOutcome::PassToGestures;
        };
        let Some(chord) = platform_chord(behavior) else {
            return HoldOutcome::PassToGestures;
        };
        let tokens = behavior_tokens(behavior);
        let acquired = self.pool.lock().unwrap().press(
            instance_id,
            input_key,
            chord,
            tokens,
            cfg!(target_os = "macos"),
        );
        if let Some((edges, summary)) = acquired {
            crate::library_usage::record_trigger(
                &format!("{instance_id}:{input_key}"),
                &mapping.click_sources,
            );
            emit_platform_edges(&edges);
            HoldOutcome::Handled {
                triggered_summary: Some(summary),
            }
        } else {
            HoldOutcome::Handled {
                triggered_summary: None,
            }
        }
    }

    pub fn release_instance(&self, instance_id: &str) {
        let edges = self.pool.lock().unwrap().release_instance(instance_id);
        emit_platform_edges(&edges);
    }

    #[cfg(test)]
    pub fn has_leases_for_test(&self, instance_id: &str) -> bool {
        self.pool
            .lock()
            .unwrap()
            .leases
            .iter()
            .any(|lease| lease.instance_id == instance_id)
    }
}

#[cfg(test)]
pub(super) fn test_platform_hold_lock() -> MutexGuard<'static, ()> {
    static SERIALIZE: Mutex<()> = Mutex::new(());
    SERIALIZE.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::super::gesture::{Gestures, TriggerKind};
    use super::*;
    use serde_json::json;

    fn parse_mapping(value: serde_json::Value) -> TriggerBehaviors {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn hold_pool_refcounts_overlapping_modifiers_and_isolates_instances() {
        let mut pool = HoldPool::<&'static str>::default();

        // Instance A holds Shift+A, Instance B holds Shift+B.
        let (edges, summary) = pool
            .press(
                "inst-a",
                "k01",
                vec!["Shift", "A"],
                vec!["Shift".into(), "A".into()],
                true,
            )
            .unwrap();
        assert_eq!(edges, vec![("Shift", true), ("A", true)]);
        assert_eq!(summary, "Shift+A");

        // Duplicate down on the same (instance, key) is ignored.
        assert!(pool
            .press(
                "inst-a",
                "k01",
                vec!["Shift", "A"],
                vec!["Shift".into(), "A".into()],
                true,
            )
            .is_none());

        let (edges, summary_b) = pool
            .press(
                "inst-b",
                "k01",
                vec!["Shift", "B"],
                vec!["LShift".into(), "B".into()],
                true,
            )
            .unwrap();
        assert_eq!(
            edges,
            vec![("B", true)],
            "shared Shift stays down without duplicate KeyDown"
        );
        assert_eq!(summary_b, "Shift+B");

        // Disconnecting Instance A releases A, but keeps Shift held for Instance B.
        assert_eq!(pool.release_instance("inst-a"), vec![("A", false)]);
        // Releasing Instance B's button releases B first, then Shift.
        assert_eq!(
            pool.release("inst-b", "k01").unwrap(),
            vec![("B", false), ("Shift", false)]
        );
        assert!(pool.release("inst-b", "k01").is_none());
    }

    #[test]
    fn disconnect_or_profile_switch_releases_in_reverse_acquisition_without_spurious_click() {
        let mut pool = HoldPool::<&'static str>::default();

        // K01=Ctrl, K02=Cmd, K03=A pressed in order.
        pool.press("k18", "k01", vec!["Ctrl"], vec!["Ctrl".into()], true)
            .unwrap();
        pool.press("k18", "k02", vec!["Cmd"], vec!["Win".into()], true)
            .unwrap();
        let (_, combo) = pool
            .press("k18", "k03", vec!["A"], vec!["A".into()], true)
            .unwrap();
        assert_eq!(combo, "Ctrl+Cmd+A");

        // Profile switch cancels hold leases in reverse order (A up, Cmd up, Ctrl up) and resets gestures.
        assert_eq!(
            pool.release_instance("k18"),
            vec![("A", false), ("Cmd", false), ("Ctrl", false)]
        );
        let mut gestures = Gestures::default();

        // Physical release in the new profile (where K03 is Paste) produces zero spurious actions.
        let new_k03 = parse_mapping(json!({"click": [{"type": "paste", "text": "hello"}]}));
        assert!(pool.release("k18", "k03").is_none());
        assert!(gestures.edge("k03", false, 50, &new_k03).is_empty());
    }

    #[test]
    fn hold_keys_coexist_side_by_side_with_double_click_and_long_press_gestures() {
        let hold_map = parse_mapping(json!({"click": [{"type": "key", "key": "Ctrl"}]}));
        let multi_gesture_map = parse_mapping(json!({
            "click": [{"type": "key", "key": "A"}],
            "doubleClick": [{"type": "paste", "text": "double"}],
            "longPress": [{"type": "switchProfile", "direction": "next", "wrap": true}]
        }));
        let multi_step_click = parse_mapping(json!({
            "click": [
                {"type": "key", "key": "A"},
                {"type": "key", "key": "B"}
            ]
        }));

        assert!(hold_behavior(&hold_map).is_some());
        assert!(hold_behavior(&multi_gesture_map).is_none());
        assert!(hold_behavior(&multi_step_click).is_none());

        let mut gestures = Gestures::default();
        assert!(gestures.edge("k04", true, 0, &multi_gesture_map).is_empty());
        assert!(gestures
            .edge("k04", false, 20, &multi_gesture_map)
            .is_empty());
        assert!(gestures
            .edge("k04", true, 100, &multi_gesture_map)
            .is_empty());
        let exec = gestures.edge("k04", false, 120, &multi_gesture_map);
        assert_eq!(exec.len(), 1);
        assert_eq!(exec[0].trigger, TriggerKind::DoubleClick);
    }

    #[test]
    fn windows_hold_chord_injects_vk_lcontrol_vk_lwin_and_a_edges() {
        let _ = super::super::super::windows::take_test_keyboard_batches();
        let mut pool = HoldPool::<u16>::default();
        let ctrl = super::super::super::windows::managed_hold_chord(&NativeBehavior::Key {
            enabled: true,
            key: "Ctrl".into(),
        })
        .unwrap();
        let cmd = super::super::super::windows::managed_hold_chord(&NativeBehavior::Key {
            enabled: true,
            key: "Cmd".into(),
        })
        .unwrap();
        let a = super::super::super::windows::managed_hold_chord(&NativeBehavior::Key {
            enabled: true,
            key: "A".into(),
        })
        .unwrap();
        assert_eq!(ctrl, vec![0xa2]); // VK_LCONTROL
        assert_eq!(cmd, vec![0x5b]); // VK_LWIN
        assert_eq!(a, vec![0x41]); // 'A'

        for (input, chord) in [("k01", ctrl), ("k02", cmd), ("k03", a)] {
            let (edges, _) = pool
                .press("win-k18", input, chord, vec![], false)
                .unwrap();
            for (vk, down) in edges {
                super::super::super::windows::send_managed_held_key(vk, down);
            }
        }
        for input in ["k03", "k01", "k02"] {
            for (vk, down) in pool.release("win-k18", input).unwrap() {
                super::super::super::windows::send_managed_held_key(vk, down);
            }
        }
        let batches = super::super::super::windows::take_test_keyboard_batches();
        let simplified: Vec<(u16, bool)> = batches
            .into_iter()
            .flatten()
            .map(|(vk, flags)| (vk, (flags & 2) == 0))
            .collect();
        assert_eq!(
            simplified,
            vec![
                (0xa2, true),
                (0x5b, true),
                (0x41, true),
                (0x41, false),
                (0xa2, false),
                (0x5b, false),
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_hold_and_pressed_chord_aggregate_modifier_flags_across_buttons() {
        let _guard = test_platform_hold_lock();
        use super::super::super::macos::{
            clear_managed_held_keys_for_test, execute_behaviors, FLAG_COMMAND, FLAG_CONTROL,
            FLAG_DEVICE_LEFT_COMMAND, FLAG_DEVICE_LEFT_CONTROL, FLAG_DEVICE_LEFT_SHIFT, FLAG_SHIFT,
            TEST_POSTED_KEYS,
        };

        clear_managed_held_keys_for_test();
        let holds = ManagedHolds::default();
        let k01 = parse_mapping(json!({"click": [{"type": "key", "key": "Ctrl"}]}));
        let k02 = parse_mapping(json!({"click": [{"type": "key", "key": "Cmd"}]}));
        let k03 = parse_mapping(json!({"click": [{"type": "key", "key": "A"}]}));

        holds.try_edge("mac-k18", "k01", true, &k01);
        holds.try_edge("mac-k18", "k02", true, &k02);
        let outcome = holds.try_edge("mac-k18", "k03", true, &k03);
        assert!(matches!(
            outcome,
            HoldOutcome::Handled {
                triggered_summary: Some(ref s)
            } if s == "Ctrl+Cmd+A"
        ));

        // While Ctrl+Cmd are held on K01+K02, a gesture tap of Shift+B must preserve Ctrl|Cmd!
        execute_behaviors(&[NativeBehavior::Shortcut {
            enabled: true,
            keys: vec!["Shift".into(), "B".into()],
        }]);

        holds.try_edge("mac-k18", "k03", false, &k03);
        holds.try_edge("mac-k18", "k01", false, &k01);
        holds.try_edge("mac-k18", "k02", false, &k02);

        let f_ctrl = FLAG_CONTROL | FLAG_DEVICE_LEFT_CONTROL;
        let f_cmd = FLAG_COMMAND | FLAG_DEVICE_LEFT_COMMAND;
        let f_shift = FLAG_SHIFT | FLAG_DEVICE_LEFT_SHIFT;

        let events: Vec<(u16, bool, u64)> = TEST_POSTED_KEYS
            .lock()
            .unwrap()
            .drain(..)
            .map(|(key, down, flags, _)| {
                let code = match key {
                    super::super::super::macos::MacKey::Keyboard { code, .. } => code,
                    super::super::super::macos::MacKey::System { .. } => u16::MAX,
                };
                (code, down, flags)
            })
            .collect();

        assert_eq!(
            events,
            vec![
                (59, true, f_ctrl),                   // K01 Ctrl down
                (55, true, f_ctrl | f_cmd),           // K02 Cmd down
                (0, true, f_ctrl | f_cmd),            // K03 A down
                (56, true, f_ctrl | f_cmd | f_shift), // Gesture Shift down
                (11, true, f_ctrl | f_cmd | f_shift), // Gesture B down
                (11, false, f_ctrl | f_cmd | f_shift), // Gesture B up
                (56, false, f_ctrl | f_cmd),          // Gesture Shift up (Ctrl|Cmd preserved!)
                (0, false, f_ctrl | f_cmd),           // K03 A up
                (59, false, f_cmd),                   // K01 Ctrl up (Cmd preserved!)
                (55, false, 0),                       // K02 Cmd up (all cleared!)
            ]
        );
        clear_managed_held_keys_for_test();
    }
}
