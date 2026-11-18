//! On-disk locations, mirroring `engine/src/paths.ts`: root from `CC_SLAVES_HOME` (default `~/.cc-slaves`).
use std::path::PathBuf;

pub const BUNDLE_ID: &str = "com.ccslaves.app";
pub const ENGINE_PORT: u16 = 47800;
pub const KEYCHAIN_SERVICE: &str = "cc-slaves-engine-token";

pub fn user_home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// `Some(dir)` only when `CC_SLAVES_HOME` overrides the default.
fn home_override() -> Option<PathBuf> {
    std::env::var_os("CC_SLAVES_HOME").filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn slaves_home() -> PathBuf {
    home_override().unwrap_or_else(|| user_home().join(".cc-slaves"))
}

pub fn engine_json() -> PathBuf {
    slaves_home().join("engine.json")
}

pub fn logs_dir() -> PathBuf {
    slaves_home().join("logs")
}

pub fn launch_agents_dir() -> PathBuf {
    user_home().join("Library").join("LaunchAgents")
}

/// Label prefix for the LaunchAgent. `CC_SLAVES_LABEL_PREFIX` exists only so measurements can install under a
/// throw-away label instead of the real one; default = the bundle id.
pub fn label_prefix() -> String {
    std::env::var("CC_SLAVES_LABEL_PREFIX").ok().filter(|s| valid_label(s)).unwrap_or_else(|| BUNDLE_ID.to_string())
}

pub fn valid_label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

pub fn engine_label() -> String {
    format!("{}.engine", label_prefix())
}

/// The menu-bar agent of installs before hf-bg2 (the engine now runs the menu bar); only ever booted out and deleted.
pub fn retired_menubar_label() -> String {
    format!("{}.menubar", label_prefix())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_rejects_path_and_shell_chars() {
        assert!(valid_label("com.ccslaves.app"));
        assert!(!valid_label("../evil"));
        assert!(!valid_label("a b"));
        assert!(!valid_label(""));
    }
}
