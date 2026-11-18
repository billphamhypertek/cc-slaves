//! The engine LaunchAgent (§7.1; the menu bar is its child since hf-bg2): plist text, the install/update plan, and
//! `launchctl` calls. Only labels this app owns are ever touched; every `launchctl` call names one explicitly.
use crate::engine_info::version_mismatch;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// launchd `ExitTimeOut` of the agent; "Thoát hẳn" reads a longer engine exit as "forced" (menubar `quit.rs`).
pub const EXIT_TIMEOUT_SECS: u64 = 30;
/// How long a bootout may take before it counts as stuck: launchd's SIGKILL lands at `ExitTimeOut`, plus a grace.
pub const BOOTOUT_WAIT: Duration = Duration::from_secs(EXIT_TIMEOUT_SECS + 5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSpec {
    pub label: String,
    pub program: PathBuf,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
    /// Extra environment (only `CC_SLAVES_HOME` when the app itself runs with an override).
    pub env: Vec<(String, String)>,
    /// The engine needs the GUI (Aqua) session for the Keychain and for its menu-bar child.
    pub throttle_secs: u32,
}

impl AgentSpec {
    pub fn plist_path(&self, agents_dir: &Path) -> PathBuf {
        agents_dir.join(format!("{}.plist", self.label))
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// Deterministic plist text: same spec → byte-identical file, so "changed?" is a string compare.
pub fn plist_xml(spec: &AgentSpec) -> String {
    let mut s = String::from(concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
        "<plist version=\"1.0\">\n<dict>\n"
    ));
    let kv = |s: &mut String, k: &str, v: &str| s.push_str(&format!("\t<key>{k}</key>\n\t<string>{}</string>\n", esc(v)));
    kv(&mut s, "Label", &spec.label);
    s.push_str("\t<key>ProgramArguments</key>\n\t<array>\n");
    s.push_str(&format!("\t\t<string>{}</string>\n", esc(&spec.program.to_string_lossy())));
    s.push_str("\t</array>\n");
    s.push_str("\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>KeepAlive</key>\n\t<true/>\n");
    s.push_str("\t<key>LimitLoadToSessionType</key>\n\t<string>Aqua</string>\n");
    s.push_str(&format!("\t<key>ThrottleInterval</key>\n\t<integer>{}</integer>\n", spec.throttle_secs));
    // v2.8 §4.11.5: SIGTERM → SIGKILL after 30 s (default measured ~5 s), so `Engine.stop()` can stop lanes and persist.
    s.push_str(&format!("\t<key>ExitTimeOut</key>\n\t<integer>{EXIT_TIMEOUT_SECS}</integer>\n"));
    kv(&mut s, "StandardOutPath", &spec.stdout.to_string_lossy());
    kv(&mut s, "StandardErrorPath", &spec.stderr.to_string_lossy());
    if !spec.env.is_empty() {
        s.push_str("\t<key>EnvironmentVariables</key>\n\t<dict>\n");
        for (k, v) in &spec.env {
            s.push_str(&format!("\t\t<key>{}</key>\n\t\t<string>{}</string>\n", esc(k), esc(v)));
        }
        s.push_str("\t</dict>\n");
    }
    s.push_str("</dict>\n</plist>\n");
    s
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    WritePlist,
    Bootout,
    Bootstrap,
    /// `launchctl kickstart -k`: SIGTERM the running engine (it drains + persists, §7.1) and start it again.
    Kickstart,
}

/// What to do so the agent matches `desired`.
/// - plist differs (new binary path, new env) → write it; launchd only reads ProgramArguments at bootstrap, so a loaded
///   job must be booted out first.
/// - plist same but not loaded → bootstrap.
/// - plist same, loaded, but the live engine reports another version (binary replaced in place) → kickstart.
pub fn plan(desired: &str, on_disk: Option<&str>, loaded: bool, live_version: Option<&str>, app_version: &str) -> Vec<Action> {
    if on_disk != Some(desired) {
        let mut a = vec![Action::WritePlist];
        if loaded {
            a.push(Action::Bootout);
        }
        a.push(Action::Bootstrap);
        return a;
    }
    if !loaded {
        return vec![Action::Bootstrap];
    }
    match live_version {
        Some(v) if version_mismatch(app_version, v) => vec![Action::Kickstart],
        _ => vec![],
    }
}

pub trait Launchctl {
    fn is_loaded(&self, label: &str) -> bool;
    fn bootstrap(&self, plist: &Path) -> Result<(), String>;
    fn bootout(&self, label: &str) -> Result<(), String>;
    fn kickstart_kill(&self, label: &str) -> Result<(), String>;
}

pub struct RealLaunchctl {
    uid: u32,
}

impl Default for RealLaunchctl {
    fn default() -> Self {
        // SAFETY: getuid has no preconditions.
        Self { uid: unsafe { libc::getuid() } }
    }
}

impl RealLaunchctl {
    fn domain(&self) -> String {
        format!("gui/{}", self.uid)
    }
    fn run(&self, args: &[&str]) -> Result<(), String> {
        let out = Command::new("/bin/launchctl").args(args).output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("launchctl {}: {}", args[0], String::from_utf8_lossy(&out.stderr).trim()))
        }
    }
}

impl Launchctl for RealLaunchctl {
    fn is_loaded(&self, label: &str) -> bool {
        Command::new("/bin/launchctl")
            .args(["print", &format!("{}/{label}", self.domain())])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    fn bootstrap(&self, plist: &Path) -> Result<(), String> {
        self.run(&["bootstrap", &self.domain(), &plist.to_string_lossy()])
    }
    fn bootout(&self, label: &str) -> Result<(), String> {
        self.run(&["bootout", &format!("{}/{label}", self.domain())])
    }
    fn kickstart_kill(&self, label: &str) -> Result<(), String> {
        self.run(&["kickstart", "-k", &format!("{}/{label}", self.domain())])
    }
}

/// The "still loaded after bootout" error in `lang` (it reaches the F20 / uninstall dialogs, §6A).
pub fn still_running_text(lang: crate::i18n::Lang, label: &str) -> String {
    crate::i18n::tr(lang, "launchd.stillRunning", &[("label", label)])
}

/// Bootout is asynchronous: wait until the label is gone (≤ `BOOTOUT_WAIT`) so a following bootstrap does not fail with EIO.
pub fn bootout_and_wait(lc: &dyn Launchctl, label: &str) -> Result<(), String> {
    if !lc.is_loaded(label) {
        return Ok(());
    }
    lc.bootout(label)?;
    let t = Instant::now();
    while lc.is_loaded(label) {
        if t.elapsed() > BOOTOUT_WAIT {
            return Err(still_running_text(crate::i18n::current(), label));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// Brings one agent in line with `spec`. Returns the actions taken (for logs/tests).
pub fn ensure(lc: &dyn Launchctl, spec: &AgentSpec, agents_dir: &Path, live_version: Option<&str>, app_version: &str) -> Result<Vec<Action>, String> {
    let path = spec.plist_path(agents_dir);
    let desired = plist_xml(spec);
    let on_disk = std::fs::read_to_string(&path).ok();
    let actions = plan(&desired, on_disk.as_deref(), lc.is_loaded(&spec.label), live_version, app_version);
    for a in &actions {
        match a {
            Action::WritePlist => {
                std::fs::create_dir_all(agents_dir).map_err(|e| e.to_string())?;
                write_plist(&path, &desired)?;
            }
            Action::Bootout => bootout_and_wait(lc, &spec.label)?,
            Action::Bootstrap => {
                let mut last = Ok(());
                for i in 0..3 {
                    last = lc.bootstrap(&path);
                    if last.is_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500 * (i + 1)));
                }
                last?
            }
            Action::Kickstart => lc.kickstart_kill(&spec.label)?,
        }
    }
    Ok(actions)
}

fn write_plist(path: &Path, text: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let tmp = path.with_extension("plist.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    // launchd refuses group/world-writable plists.
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// "Tắt engine" (NC4): bootout, plist kept so the next app start bootstraps it again.
pub fn stop(lc: &dyn Launchctl, label: &str) -> Result<(), String> {
    bootout_and_wait(lc, label)
}

/// "Gỡ engine" (and the retired menu-bar agent on upgrade): bootout + delete the plists. Only the given labels are touched.
pub fn uninstall(lc: &dyn Launchctl, labels: &[&str], agents_dir: &Path) -> Result<(), String> {
    for label in labels {
        bootout_and_wait(lc, label)?;
        let p = agents_dir.join(format!("{label}.plist"));
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn s6a_still_running_text_both_languages() {
        use crate::i18n::Lang;
        assert_eq!(still_running_text(Lang::Vi, "x.engine"), "x.engine vẫn còn chạy sau khi bootout");
        assert_eq!(still_running_text(Lang::En, "x.engine"), "x.engine is still running after bootout");
    }

    use super::*;
    use std::cell::RefCell;

    fn spec(prog: &str) -> AgentSpec {
        AgentSpec {
            label: "com.ccslaves.app.engine".into(),
            program: PathBuf::from(prog),
            stdout: PathBuf::from("/h/.cc-slaves/logs/engine.out.log"),
            stderr: PathBuf::from("/h/.cc-slaves/logs/engine.err.log"),
            env: vec![],
            throttle_secs: 5,
        }
    }

    #[test]
    fn s7_1_plist_has_keepalive_label_and_bundle_binary() {
        let x = plist_xml(&spec("/Applications/cc-slaves.app/Contents/Resources/cc-slaves"));
        assert!(x.contains("<key>Label</key>\n\t<string>com.ccslaves.app.engine</string>"));
        assert!(x.contains("<key>KeepAlive</key>\n\t<true/>"));
        assert!(x.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(x.contains("<array>\n\t\t<string>/Applications/cc-slaves.app/Contents/Resources/cc-slaves</string>\n\t</array>"));
        assert!(!x.contains("EnvironmentVariables"));
    }

    #[test]
    fn v28_4_11_5_plist_gives_30s_between_sigterm_and_sigkill() {
        // measured default on macOS 27.2: SIGKILL ~5 s after bootout (research §14.5) — too short for Engine.stop()
        let x = plist_xml(&spec("/x/cc-slaves"));
        assert!(x.contains("<key>ExitTimeOut</key>\n\t<integer>30</integer>"), "{x}");
    }

    #[test]
    fn v28_g6a_minor1_bootout_waits_outlast_exit_timeout() {
        // a job may live up to ExitTimeOut after bootout (g6a review MINOR-1): ensure / stop / uninstall wait past it
        assert!(BOOTOUT_WAIT > Duration::from_secs(EXIT_TIMEOUT_SECS), "{BOOTOUT_WAIT:?}");
    }

    #[test]
    fn plist_escapes_xml_and_carries_env_override() {
        let mut s = spec("/tmp/a&b <c>/cc-slaves");
        s.env.push(("CC_SLAVES_HOME".into(), "/tmp/h\"x".into()));
        let x = plist_xml(&s);
        assert!(x.contains("/tmp/a&amp;b &lt;c&gt;/cc-slaves"));
        assert!(x.contains("<key>CC_SLAVES_HOME</key>\n\t\t<string>/tmp/h&quot;x</string>"));
    }

    #[test]
    fn plist_is_well_formed_for_plutil() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.plist");
        let mut s = spec("/tmp/a&b/cc-slaves");
        s.env.push(("CC_SLAVES_HOME".into(), "/tmp/h".into()));
        std::fs::write(&p, plist_xml(&s)).unwrap();
        let ok = Command::new("/usr/bin/plutil").args(["-lint", "-s"]).arg(&p).status().unwrap().success();
        assert!(ok, "plutil -lint failed");
    }

    #[test]
    fn s7_1_plan_fresh_install_writes_and_bootstraps() {
        assert_eq!(plan("A", None, false, None, "0.1.0"), vec![Action::WritePlist, Action::Bootstrap]);
    }

    #[test]
    fn s7_1_plan_new_binary_path_reloads_loaded_job() {
        assert_eq!(plan("B", Some("A"), true, Some("0.1.0"), "0.1.0"), vec![Action::WritePlist, Action::Bootout, Action::Bootstrap]);
    }

    #[test]
    fn s7_1_plan_after_tat_engine_bootstraps_again() {
        assert_eq!(plan("A", Some("A"), false, None, "0.1.0"), vec![Action::Bootstrap]);
    }

    #[test]
    fn s7_1_plan_version_mismatch_kickstarts() {
        assert_eq!(plan("A", Some("A"), true, Some("0.0.9"), "0.1.0"), vec![Action::Kickstart]);
    }

    #[test]
    fn s7_1_plan_up_to_date_does_nothing() {
        assert_eq!(plan("A", Some("A"), true, Some("v0.1.0"), "0.1.0"), Vec::<Action>::new());
        assert_eq!(plan("A", Some("A"), true, None, "0.1.0"), Vec::<Action>::new());
    }

    #[derive(Default)]
    struct FakeLc {
        loaded: RefCell<Vec<String>>,
        calls: RefCell<Vec<String>>,
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
            self.loaded.borrow_mut().retain(|l| l != label);
            Ok(())
        }
        fn kickstart_kill(&self, label: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("kickstart {label}"));
            Ok(())
        }
    }

    #[test]
    fn s7_1_ensure_writes_0644_plist_then_is_idempotent() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let lc = FakeLc::default();
        let s = spec("/x/cc-slaves");
        assert_eq!(ensure(&lc, &s, d.path(), None, "0.1.0").unwrap(), vec![Action::WritePlist, Action::Bootstrap]);
        let meta = std::fs::metadata(s.plist_path(d.path())).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o644);
        assert_eq!(ensure(&lc, &s, d.path(), Some("0.1.0"), "0.1.0").unwrap(), vec![]);
        assert_eq!(*lc.calls.borrow(), vec!["bootstrap com.ccslaves.app.engine"]);
    }

    #[test]
    fn s7_1_tat_engine_keeps_plist_go_engine_removes_both() {
        let d = tempfile::tempdir().unwrap();
        let lc = FakeLc::default();
        let e = spec("/x/cc-slaves");
        let mut m = spec("/x/cc-slaves-menubar");
        m.label = "com.ccslaves.app.menubar".into();
        ensure(&lc, &e, d.path(), None, "0.1.0").unwrap();
        ensure(&lc, &m, d.path(), None, "0.1.0").unwrap();
        std::fs::write(d.path().join("com.other.agent.plist"), "x").unwrap();

        stop(&lc, &e.label).unwrap();
        assert!(!lc.is_loaded(&e.label));
        assert!(e.plist_path(d.path()).exists());

        uninstall(&lc, &[&e.label, &m.label], d.path()).unwrap();
        assert!(!e.plist_path(d.path()).exists());
        assert!(!m.plist_path(d.path()).exists());
        assert!(!lc.is_loaded(&m.label));
        assert!(d.path().join("com.other.agent.plist").exists(), "never touch other agents");
    }

    /// Real launchd, throw-away label running /bin/sleep. Run by hand: `cargo test -- --ignored real_launchctl`.
    #[test]
    #[ignore]
    fn real_launchctl_roundtrip_stop_keeps_plist_uninstall_removes() {
        let d = tempfile::tempdir().unwrap();
        let lc = RealLaunchctl::default();
        let mut s = spec("/bin/sleep");
        s.label = "com.ccslaves.g4test.roundtrip".into();
        s.stdout = d.path().join("o.log");
        s.stderr = d.path().join("e.log");
        // ProgramArguments has only the program; /bin/sleep without args exits → KeepAlive restarts; enough for load state.
        assert_eq!(ensure(&lc, &s, d.path(), None, "0.1.0").unwrap(), vec![Action::WritePlist, Action::Bootstrap]);
        assert!(lc.is_loaded(&s.label));
        stop(&lc, &s.label).unwrap();
        assert!(!lc.is_loaded(&s.label));
        assert!(s.plist_path(d.path()).exists());
        assert_eq!(ensure(&lc, &s, d.path(), None, "0.1.0").unwrap(), vec![Action::Bootstrap]);
        uninstall(&lc, &[&s.label], d.path()).unwrap();
        assert!(!lc.is_loaded(&s.label));
        assert!(!s.plist_path(d.path()).exists());
    }
}
