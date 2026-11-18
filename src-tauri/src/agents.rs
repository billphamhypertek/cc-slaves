//! Installs/updates the one LaunchAgent from the engine binary shipped in the bundle (§7.1). hf-bg2 (PO 18/11): the engine
//! supervises the menu bar as its child, so Login Items shows ONE entry, named after the program file: `cc-slaves`.
use ccs_core::launchd::{self, Action, AgentSpec, Launchctl};
use ccs_core::paths;
use std::path::{Path, PathBuf};

/// The engine binary's file name is what Login Items shows for an ad-hoc signed agent (measured 18/11).
pub const ENGINE_BIN: &str = "cc-slaves";

/// Bundle `Contents/Resources/<name>`; env override `CC_SLAVES_ENGINE_BIN`; in debug builds the repo `dist/`.
pub fn resolve_bin(resource_dir: Option<&Path>, name: &str, env_key: &str) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(env_key).map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Some(p) = resource_dir.map(|d| d.join(name)).filter(|p| p.is_file()) {
        return Some(p);
    }
    if cfg!(debug_assertions) {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("dist").join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Overrides in the app's own env reach the engine's plist: `CC_SLAVES_HOME` and (v2.4 §10.2 A11) `CC_SLAVES_ATTACH` — an
/// engine with an overridden home and no attach dir refuses to sweep — and `CC_SLAVES_MENUBAR_BIN` (the engine's child).
fn dir_overrides(var: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    ["CC_SLAVES_HOME", "CC_SLAVES_ATTACH", "CC_SLAVES_MENUBAR_BIN"]
        .into_iter()
        .filter_map(|k| var(k).filter(|v| !v.is_empty()).map(|v| (k.to_string(), v)))
        .collect()
}

pub fn spec(label: String, program: PathBuf, log_name: &str) -> AgentSpec {
    let logs = paths::logs_dir();
    let mut env = dir_overrides(|k| std::env::var_os(k).map(|v| v.to_string_lossy().into_owned()));
    // M1: the engine's `engine_shutdown` boots its own job out (else KeepAlive restarts it); it needs its label.
    env.push(("CC_SLAVES_LAUNCHD_LABEL".to_string(), label.clone()));
    AgentSpec {
        label,
        program,
        stdout: logs.join(format!("{log_name}.out.log")),
        stderr: logs.join(format!("{log_name}.err.log")),
        env,
        throttle_secs: 5,
    }
}

/// `~/.cc-slaves` 0700 and `logs/` 0700 must exist before launchd opens the log paths (M18).
pub fn ensure_dirs() -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    for d in [paths::slaves_home(), paths::logs_dir()] {
        if !d.exists() {
            std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&d).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn install(lc: &dyn Launchctl, engine_bin: &Path, live_version: Option<&str>, app_version: &str) -> Result<Vec<Action>, String> {
    ensure_dirs()?;
    install_in(lc, engine_bin, &paths::launch_agents_dir(), &paths::engine_label(), &paths::retired_menubar_label(), live_version, app_version)
}

/// Old installs (before hf-bg2) also had a menu-bar agent: boot it out and delete its plist first, so the engine's child
/// is the only menu bar. Orchestrator ruling hf-fx A1: a failure there is logged and never blocks the engine install
/// (two icons until the next start beat no engine).
fn install_in(lc: &dyn Launchctl, engine_bin: &Path, dir: &Path, engine_label: &str, retired_menubar: &str, live_version: Option<&str>, app_version: &str) -> Result<Vec<Action>, String> {
    if let Err(e) = launchd::uninstall(lc, &[retired_menubar], dir) {
        eprintln!("[cc-slaves] retired menubar agent: {e}");
    }
    launchd::ensure(lc, &spec(engine_label.to_string(), engine_bin.to_path_buf(), "engine"), dir, live_version, app_version)
}

#[cfg(test)]
mod tests {
    use super::{dir_overrides, install_in, spec};
    use ccs_core::launchd::{Action, Launchctl};
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    #[derive(Default)]
    struct FakeLc {
        loaded: RefCell<Vec<String>>,
        calls: RefCell<Vec<String>>,
        /// hf-fx A1: a label whose bootout fails, like a stuck old menubar job.
        stuck: Option<&'static str>,
    }
    impl Launchctl for FakeLc {
        fn is_loaded(&self, label: &str) -> bool {
            self.loaded.borrow().iter().any(|l| l == label)
        }
        fn bootstrap(&self, plist: &Path) -> Result<(), String> {
            let label = plist.file_stem().unwrap().to_string_lossy().to_string();
            self.calls.borrow_mut().push(format!("bootstrap {label}"));
            self.loaded.borrow_mut().push(label);
            Ok(())
        }
        fn bootout(&self, label: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("bootout {label}"));
            if self.stuck == Some(label) {
                return Err("EIO".into());
            }
            self.loaded.borrow_mut().retain(|l| l != label);
            Ok(())
        }
        fn kickstart_kill(&self, _: &str) -> Result<(), String> {
            unreachable!()
        }
    }

    fn plists(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn hf_bg2_one_agent_runs_the_engine_binary_named_cc_slaves() {
        let d = tempfile::tempdir().unwrap();
        let lc = FakeLc::default();
        let a = install_in(&lc, Path::new("/A/cc-slaves.app/Contents/Resources/cc-slaves"), d.path(), "x.engine", "x.menubar", None, "0.1.0").unwrap();
        assert_eq!(a, vec![Action::WritePlist, Action::Bootstrap]);
        assert_eq!(plists(d.path()), vec!["x.engine.plist"], "exactly one LaunchAgent, no menubar plist");
        let x = std::fs::read_to_string(d.path().join("x.engine.plist")).unwrap();
        assert!(x.contains("<string>/A/cc-slaves.app/Contents/Resources/cc-slaves</string>"), "{x}");
        assert_eq!(*lc.calls.borrow(), vec!["bootstrap x.engine"]);
    }

    #[test]
    fn hf_bg2_first_launch_boots_out_and_deletes_the_old_menubar_agent() {
        let d = tempfile::tempdir().unwrap();
        let lc = FakeLc::default();
        std::fs::write(d.path().join("x.menubar.plist"), "old").unwrap();
        std::fs::write(d.path().join("com.other.agent.plist"), "x").unwrap();
        lc.loaded.borrow_mut().push("x.menubar".into());
        install_in(&lc, Path::new("/A/cc-slaves"), d.path(), "x.engine", "x.menubar", None, "0.1.0").unwrap();
        assert!(!lc.is_loaded("x.menubar"));
        assert_eq!(plists(d.path()), vec!["com.other.agent.plist", "x.engine.plist"]);
        assert_eq!(lc.calls.borrow()[0], "bootout x.menubar", "old menubar out before the engine job (re)starts its child");
    }

    #[test]
    fn hf_fx_a1_a_stuck_old_menubar_does_not_block_the_engine_install() {
        let d = tempfile::tempdir().unwrap();
        let lc = FakeLc { stuck: Some("x.menubar"), ..Default::default() };
        std::fs::write(d.path().join("x.menubar.plist"), "old").unwrap();
        lc.loaded.borrow_mut().push("x.menubar".into());
        let a = install_in(&lc, Path::new("/A/cc-slaves"), d.path(), "x.engine", "x.menubar", None, "0.1.0").unwrap();
        assert_eq!(a, vec![Action::WritePlist, Action::Bootstrap]);
        assert!(d.path().join("x.engine.plist").exists(), "engine job installed although the old menubar is stuck");
        assert!(lc.is_loaded("x.engine"));
    }

    #[test]
    fn a11_attach_dir_is_forwarded_like_the_home() {
        let env = |k: &str| match k {
            "CC_SLAVES_HOME" => Some("/t/home".to_string()),
            "CC_SLAVES_ATTACH" => Some("/t/attach".to_string()),
            _ => None,
        };
        let v = dir_overrides(env);
        assert!(v.contains(&("CC_SLAVES_HOME".to_string(), "/t/home".to_string())));
        assert!(v.contains(&("CC_SLAVES_ATTACH".to_string(), "/t/attach".to_string())));
        let empty = |k: &str| if k == "CC_SLAVES_ATTACH" { Some(String::new()) } else { None };
        assert!(dir_overrides(empty).is_empty());
    }

    #[test]
    fn m1_plist_env_carries_the_launchd_label() {
        let s = spec("test.example.cc-slaves.engine".into(), PathBuf::from("/x/cc-slaves"), "engine");
        assert!(s.env.iter().any(|(k, v)| k == "CC_SLAVES_LAUNCHD_LABEL" && v == "test.example.cc-slaves.engine"));
    }
}
