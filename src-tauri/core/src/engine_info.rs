//! `~/.cc-slaves/engine.json` (§7.1: pid, port, version — never the token) and the app ↔ engine version rule.
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EngineJson {
    pub pid: i32,
    pub port: u16,
    pub version: String,
}

/// `None` when missing or malformed (engine not started yet, or mid-write).
pub fn read_engine_json(path: &Path) -> Option<EngineJson> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// `kill(pid, 0)`: alive if it succeeds or fails only for lack of permission.
pub fn pid_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 performs only the existence/permission check.
    let r = unsafe { libc::kill(pid, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// "v0.1.0+abc" → "0.1.0". Build metadata never makes two versions different.
pub fn normalize_version(v: &str) -> &str {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    v.split('+').next().unwrap_or(v)
}

/// §7.1: "Phiên bản engine khác app → app thay engine" — any difference (older or newer) means replace.
pub fn version_mismatch(app: &str, engine: &str) -> bool {
    normalize_version(app) != normalize_version(engine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s7_1_version_equal_after_normalizing() {
        assert!(!version_mismatch("0.1.0", "0.1.0"));
        assert!(!version_mismatch("0.1.0", "v0.1.0"));
        assert!(!version_mismatch("0.1.0", " 0.1.0+g3a1 \n"));
    }

    #[test]
    fn s7_1_version_any_difference_is_a_mismatch() {
        assert!(version_mismatch("0.1.0", "0.1.1"));
        assert!(version_mismatch("0.2.0", "0.10.0"));
        assert!(version_mismatch("0.1.0", "0.1.0-beta"));
        assert!(version_mismatch("0.1.0", ""));
    }

    #[test]
    fn engine_json_parses_and_rejects_garbage() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("engine.json");
        assert_eq!(read_engine_json(&p), None);
        std::fs::write(&p, r#"{"pid":42,"port":47800,"version":"0.1.0","extra":1}"#).unwrap();
        assert_eq!(read_engine_json(&p), Some(EngineJson { pid: 42, port: 47800, version: "0.1.0".into() }));
        std::fs::write(&p, "{\"pid\":4").unwrap();
        assert_eq!(read_engine_json(&p), None);
    }

    #[test]
    fn pid_alive_self_and_dead() {
        assert!(pid_alive(std::process::id() as i32));
        assert!(!pid_alive(0));
        assert!(!pid_alive(-1));
    }
}
