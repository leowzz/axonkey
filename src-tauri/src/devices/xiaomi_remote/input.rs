use std::collections::BTreeMap;

pub(crate) fn decode(report: &[u8]) -> Option<BTreeMap<String, f64>> {
    let mut values = BTreeMap::new();
    if report.len() != 7 || report[0] != 1 {
        return None;
    }
    let usages: Vec<u16> = report[1..]
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();
    for (key, usage) in [
        ("voice", 0x3e),
        ("power", 0x66),
        ("home", 0x4a),
        ("tv", 0x35),
        ("menu", 0x65),
        ("confirm", 0x28),
        ("up", 0x52),
        ("down", 0x51),
        ("left", 0x50),
        ("right", 0x4f),
        ("back", 0xf1),
        ("volumeUp", 0x80),
        ("volumeDown", 0x81),
    ] {
        values.insert(key.into(), if usages.contains(&usage) { 1. } else { 0. });
    }
    Some(values)
}
