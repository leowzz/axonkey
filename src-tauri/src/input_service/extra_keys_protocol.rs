// SPDX-License-Identifier: GPL-3.0-only
//! Automatic extra-key stream acquisition. Never persist UMDF handles.
use std::collections::BTreeSet;

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
pub struct ExtraKeyStream {
    stream: Option<String>,
    held: BTreeSet<u16>,
}

impl ExtraKeyStream {
    /// The caller restricts reports to the current RC003 host and allowed objects.
    /// Matching a report is not proof of a shared UMDF proxy's hardware identity.
    pub fn report(&mut self, stream: &str, usages: BTreeSet<u16>) -> Vec<(u16, bool)> {
        let next: BTreeSet<_> = usages
            .into_iter()
            .filter(|v| EXTRA_KEYS.iter().any(|k| k.0 == *v))
            .collect();
        if self.stream.is_none() {
            // Idle reports and ordinary keys must not claim the stream. Forward
            // the very first extra-key press instead of consuming it as setup.
            if next.is_empty() {
                return vec![];
            }
            self.stream = Some(stream.into());
        }
        if self.stream.as_deref() != Some(stream) {
            return vec![];
        }
        let mut edges: Vec<_> = self.held.difference(&next).map(|v| (*v, false)).collect();
        edges.extend(next.difference(&self.held).map(|v| (*v, true)));
        self.held = next;
        edges
    }

    pub fn closed(&mut self, stream: &str) -> bool {
        if self.stream.as_deref() != Some(stream) {
            return false;
        }
        *self = Self::default();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn report(s: &mut ExtraKeyStream, stream: &str, usages: &[u16]) -> Vec<(u16, bool)> {
        s.report(stream, usages.iter().copied().collect())
    }
    #[test]
    fn any_extra_key_works_on_its_first_press_without_confirmation() {
        for (usage, _) in EXTRA_KEYS {
            let mut s = ExtraKeyStream::default();
            assert!(report(&mut s, "other", &[]).is_empty());
            assert!(report(&mut s, "other", &[0x28]).is_empty());
            assert_eq!(report(&mut s, "remote", &[usage]), vec![(usage, true)]);
            assert!(report(&mut s, "remote", &[usage]).is_empty());
            assert!(report(&mut s, "other", &[]).is_empty());
            assert!(report(&mut s, "other", &[0x80]).is_empty());
            assert_eq!(report(&mut s, "remote", &[]), vec![(usage, false)]);
        }
    }
    #[test]
    fn tracks_simultaneous_keys_and_reacquires_after_handle_close() {
        let mut s = ExtraKeyStream::default();
        assert_eq!(
            report(&mut s, "remote", &[0x80, 0x81, 0x28]),
            vec![(0x80, true), (0x81, true)]
        );
        assert_eq!(report(&mut s, "remote", &[0x81]), vec![(0x80, false)]);
        assert!(!s.closed("other"));
        assert!(s.closed("remote"));
        assert_eq!(report(&mut s, "reconnected", &[0xf1]), vec![(0xf1, true)]);
        assert_eq!(report(&mut s, "reconnected", &[]), vec![(0xf1, false)]);
    }
    #[test]
    fn malformed_reports_are_not_releases() {
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
        assert_eq!(decode("010000000000000000"), Some(BTreeSet::new()));
    }
}
