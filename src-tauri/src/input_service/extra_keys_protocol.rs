// SPDX-License-Identifier: GPL-3.0-only
//! Session-scoped, user-confirmed RC003 stream selection. Never persist UMDF handles.
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

pub const EXTRA_KEYS: [(u16, &str); 3] = [(0xf1, "back"), (0x80, "volumeUp"), (0x81, "volumeDown")];

pub fn decode(raw: &str) -> Option<BTreeSet<u16>> {
    if raw.len() != 18 || !raw.is_ascii() {
        return None;
    }
    let bytes: Vec<u8> = (0..18)
        .step_by(2)
        .map(|i| u8::from_str_radix(&raw[i..i + 2], 16).ok())
        .collect::<Option<_>>()?;
    if bytes[..3] != [1, 0, 0] {
        return None;
    }
    Some(
        bytes[3..]
            .chunks_exact(2)
            .map(|p| u16::from_le_bytes([p[0], p[1]]))
            .filter(|v| *v != 0)
            .collect(),
    )
}

#[derive(Default)]
pub struct Selection {
    pub stream: Option<String>,
    candidate: Option<String>,
    pub step: usize,
    down: bool,
    began: Option<Instant>,
    held: BTreeSet<u16>,
}

impl Selection {
    /// Confirmation requires three complete taps, in order, on one handle lifetime.
    /// It is user selection, not a claim that a UMDF proxy has a hardware VID/PID.
    pub fn report(
        &mut self,
        stream: &str,
        usages: BTreeSet<u16>,
        now: Instant,
    ) -> Vec<(u16, bool)> {
        if self.stream.is_none() {
            if self
                .began
                .is_some_and(|t| now.duration_since(t) > Duration::from_secs(30))
            {
                *self = Self::default();
            }
            if self.candidate.as_deref().is_some_and(|c| c != stream) {
                return vec![];
            }
            if usages.is_empty() {
                if self.down {
                    self.down = false;
                    self.step += 1;
                    if self.step == EXTRA_KEYS.len() {
                        self.stream = Some(stream.into());
                    }
                }
            } else if usages.len() == 1 && usages.contains(&EXTRA_KEYS[self.step].0) {
                self.candidate = Some(stream.into());
                self.began.get_or_insert(now);
                self.down = true;
            } else {
                *self = Self::default();
            }
            return vec![];
        }
        if self.stream.as_deref() != Some(stream) {
            return vec![];
        }
        let next: BTreeSet<_> = usages
            .into_iter()
            .filter(|v| EXTRA_KEYS.iter().any(|k| k.0 == *v))
            .collect();
        let mut edges: Vec<_> = self.held.difference(&next).map(|v| (*v, false)).collect();
        edges.extend(next.difference(&self.held).map(|v| (*v, true)));
        self.held = next;
        edges
    }

    pub fn closed(&self, stream: &str) -> bool {
        self.stream.as_deref() == Some(stream) || self.candidate.as_deref() == Some(stream)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report(s: &mut Selection, stream: &str, usages: &[u16]) -> Vec<(u16, bool)> {
        s.report(stream, usages.iter().copied().collect(), Instant::now())
    }
    fn select(s: &mut Selection) {
        for (usage, _) in EXTRA_KEYS {
            assert!(report(s, "remote", &[usage]).is_empty());
            assert!(report(s, "remote", &[]).is_empty());
        }
    }
    #[test]
    fn selection_requires_releases_and_cannot_mix_devices() {
        let mut s = Selection::default();
        report(&mut s, "remote", &[0xf1]);
        report(&mut s, "other", &[]);
        assert_eq!(s.step, 0);
        report(&mut s, "remote", &[0x80]);
        assert!(s.stream.is_none());
        select(&mut s);
        assert_eq!(s.stream.as_deref(), Some("remote"));
        assert!(report(&mut s, "other", &[0x80]).is_empty());
        assert_eq!(
            report(&mut s, "remote", &[0x80, 0x81, 0x28]),
            vec![(0x80, true), (0x81, true)]
        );
        assert!(report(&mut s, "remote", &[0x81, 0x80]).is_empty());
        assert!(report(&mut s, "other", &[]).is_empty());
        assert_eq!(
            report(&mut s, "remote", &[]),
            vec![(0x80, false), (0x81, false)]
        );
        assert!(s.closed("remote"));
    }
    #[test]
    fn malformed_reports_are_not_releases_and_selection_expires() {
        assert_eq!(
            decode("010000F10080008100").unwrap(),
            [0xf1, 0x80, 0x81].into()
        );
        for raw in [
            "",
            "000000F10080008100",
            "010000XX0080008100",
            "你好000000000000",
        ] {
            assert!(decode(raw).is_none());
        }
        let mut s = Selection::default();
        let now = Instant::now();
        s.report("remote", [0xf1].into(), now);
        s.report("remote", BTreeSet::new(), now + Duration::from_secs(31));
        assert_eq!(s.step, 0);
        assert!(s.candidate.is_none());
    }
}
