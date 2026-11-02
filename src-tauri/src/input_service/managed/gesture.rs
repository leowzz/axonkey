use super::super::{NativeBehavior, TriggerBehaviors};
use std::collections::HashMap;

#[derive(Default)]
struct Key {
    down: Option<u64>,
    click: Option<u64>,
    long: bool,
    second: bool,
}
#[derive(Default)]
pub(super) struct Gestures {
    keys: HashMap<String, Key>,
}
fn enabled(items: &[NativeBehavior]) -> bool {
    items.iter().any(NativeBehavior::enabled)
}
impl Gestures {
    pub fn edge(
        &mut self,
        id: &str,
        down: bool,
        now: u64,
        mapping: &TriggerBehaviors,
    ) -> Vec<NativeBehavior> {
        let mut out = self.tick(now, &HashMap::from([(id.to_string(), mapping.clone())]));
        let key = self.keys.entry(id.into()).or_default();
        if down {
            key.second = key.click.take().is_some();
            key.down = Some(now);
            key.long = false;
        } else if key.down.take().is_some() && !key.long {
            if key.second && enabled(&mapping.double_click) {
                out.extend(mapping.double_click.clone());
            } else if enabled(&mapping.double_click) {
                key.click = Some(now);
            } else {
                out.extend(mapping.click.clone());
            }
            key.second = false;
        }
        out
    }
    pub fn tick(
        &mut self,
        now: u64,
        mappings: &HashMap<String, TriggerBehaviors>,
    ) -> Vec<NativeBehavior> {
        let mut out = vec![];
        for (id, key) in &mut self.keys {
            let Some(mapping) = mappings.get(id) else {
                continue;
            };
            if !key.long
                && key
                    .down
                    .is_some_and(|start| now.saturating_sub(start) >= 600)
                && enabled(&mapping.long_press)
            {
                key.long = true;
                key.click = None;
                out.extend(mapping.long_press.clone());
            }
            if key
                .click
                .is_some_and(|start| now.saturating_sub(start) >= 300)
            {
                key.click = None;
                out.extend(mapping.click.clone());
            }
        }
        out
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn map() -> TriggerBehaviors {
        serde_json::from_str(r#"{"click":[{"type":"key","key":"a"}],"doubleClick":[{"type":"key","key":"b"}],"longPress":[{"type":"key","key":"c"}]}"#).unwrap()
    }
    #[test]
    fn separate_instances_never_form_a_double_click() {
        let m = map();
        let mut a = Gestures::default();
        let mut b = Gestures::default();
        assert!(a.edge("x", true, 0, &m).is_empty());
        assert!(a.edge("x", false, 10, &m).is_empty());
        b.edge("x", true, 20, &m);
        b.edge("x", false, 30, &m);
        assert_eq!(
            a.tick(320, &HashMap::from([("x".into(), m.clone())])).len(),
            1
        );
        assert_eq!(b.tick(340, &HashMap::from([("x".into(), m)])).len(), 1);
    }
    #[test]
    fn double_and_long_do_not_emit_click() {
        let m = map();
        let maps = HashMap::from([("x".into(), m.clone())]);
        let mut g = Gestures::default();
        g.edge("x", true, 0, &m);
        g.edge("x", false, 10, &m);
        g.edge("x", true, 100, &m);
        assert!(
            matches!(g.edge("x", false, 110, &m).as_slice(), [NativeBehavior::Key {key, ..}] if key == "b")
        );
        assert!(g.tick(500, &maps).is_empty());
        g.edge("x", true, 600, &m);
        assert!(
            matches!(g.tick(1200, &maps).as_slice(), [NativeBehavior::Key {key, ..}] if key == "c")
        );
        assert!(g.edge("x", false, 1210, &m).is_empty());
    }
}
