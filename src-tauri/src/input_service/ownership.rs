use super::MouseButton;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum HeldOutput {
    MouseButton(MouseButton),
    Key(String),
}

/// Refcounted ownership ledger for synthetic held inputs across sessions/sources.
/// Guarantees that revoking one owner never releases outputs still held by another.
#[derive(Default, Debug)]
pub struct OwnershipLedger {
    leases: HashMap<(String, String), Vec<HeldOutput>>,
    refcounts: HashMap<HeldOutput, usize>,
}

impl OwnershipLedger {
    pub fn acquire(
        &mut self,
        owner: impl Into<String>,
        press_id: impl Into<String>,
        outputs: Vec<HeldOutput>,
    ) -> Vec<HeldOutput> {
        let key = (owner.into(), press_id.into());
        if self.leases.contains_key(&key) {
            return Vec::new();
        }
        let mut unique = Vec::with_capacity(outputs.len());
        let mut seen = HashSet::with_capacity(outputs.len());
        for out in outputs {
            if seen.insert(out.clone()) {
                unique.push(out);
            }
        }
        if unique.is_empty() {
            return Vec::new();
        }
        let mut to_press = Vec::new();
        for out in &unique {
            let count = self.refcounts.entry(out.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                to_press.push(out.clone());
            }
        }
        self.leases.insert(key, unique);
        to_press
    }

    pub fn release(&mut self, owner: &str, press_id: &str) -> Vec<HeldOutput> {
        let Some(outputs) = self.leases.remove(&(owner.to_owned(), press_id.to_owned())) else {
            return Vec::new();
        };
        self.decrement(outputs)
    }

    pub fn revoke_owner(&mut self, owner: &str) -> Vec<HeldOutput> {
        let keys: Vec<(String, String)> = self
            .leases
            .keys()
            .filter(|(o, _)| o == owner)
            .cloned()
            .collect();
        let mut released = Vec::new();
        for key in keys {
            if let Some(outputs) = self.leases.remove(&key) {
                released.extend(self.decrement(outputs));
            }
        }
        released
    }

    #[cfg(test)]
    pub fn held_count(&self, owner: &str) -> usize {
        self.leases.keys().filter(|(o, _)| o == owner).count()
    }

    pub fn is_empty(&self) -> bool {
        self.leases.is_empty()
    }

    fn decrement(&mut self, outputs: Vec<HeldOutput>) -> Vec<HeldOutput> {
        let mut to_release = Vec::new();
        for out in outputs {
            if let Some(count) = self.refcounts.get_mut(&out) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    self.refcounts.remove(&out);
                    to_release.push(out);
                }
            }
        }
        to_release
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn revoking_one_owner_preserves_other_owners_held_outputs() {
        let mut ledger = OwnershipLedger::default();
        let shared_btn = HeldOutput::MouseButton(MouseButton::Left);
        let mobile_only_key = HeldOutput::Key("Shift".into());

        let first = ledger.acquire(
            "session-1",
            "p1",
            vec![shared_btn.clone(), mobile_only_key.clone()],
        );
        assert_eq!(first.len(), 2);

        // Second owner acquires the same mouse button: should NOT re-press down.
        let second = ledger.acquire("session-2", "p1", vec![shared_btn.clone()]);
        assert!(second.is_empty());

        // Revoking session-1 releases Shift, but NOT Left mouse button.
        let revoked = ledger.revoke_owner("session-1");
        assert_eq!(revoked, vec![mobile_only_key]);
        assert_eq!(ledger.held_count("session-1"), 0);
        assert_eq!(ledger.held_count("session-2"), 1);

        // Releasing session-2 now releases Left mouse button.
        let final_rel = ledger.release("session-2", "p1");
        assert_eq!(final_rel, vec![shared_btn]);
        assert_eq!(ledger.held_count("session-2"), 0);
    }

    #[test]
    fn duplicate_press_id_is_ignored() {
        let mut ledger = OwnershipLedger::default();
        let btn = HeldOutput::MouseButton(MouseButton::Right);
        assert_eq!(ledger.acquire("s1", "p1", vec![btn.clone()]).len(), 1);
        assert!(ledger.acquire("s1", "p1", vec![btn.clone()]).is_empty());
        assert_eq!(ledger.release("s1", "p1"), vec![btn]);
    }
}
