//! v2.6 §5.4 / §5.5 the app's side of an update: take the engine hold over the app's own WS, and after `update_commit`
//! stop the ONE engine job (hf-bg2: its menu-bar child goes with it), `open -n` the running bundle, quit without the
//! ⌘Q dialog (F20). `open -n` failing → the reopen dialog, then quit (§5.5-5).
use super::{HoldLink, Host, Machine};
use crate::i18n::{self, tr};
use crate::{dialogs, token, AppState};
use ccs_core::launchd::{self, Launchctl, RealLaunchctl};
use ccs_core::{client, paths};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

/// What the relaunch needs besides launchd: real in the app, a fake in tests (never a real `open` / exit).
pub trait Reopen {
    fn open_new(&self) -> Result<(), String>;
    fn tell_reopen(&self, version: &str);
    fn exit(&self);
}

/// §5.5 steps 2, 3, 5. A failed bootout returns before anything is opened (the machine shows `error{relaunch}`).
pub fn relaunch(lc: &dyn Launchctl, sys: &dyn Reopen, version: &str) -> Result<(), String> {
    launchd::stop(lc, &paths::engine_label())?;
    if let Err(e) = sys.open_new() {
        eprintln!("[cc-slaves] update: open -n failed: {e}");
        sys.tell_reopen(version);
    }
    sys.exit();
    Ok(())
}

/// The `.app` whose main binary is `exe` (`…/X.app/Contents/MacOS/<bin>`): the bundle that is running, wherever it is.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent().filter(|p| p.file_name().is_some_and(|n| n == "MacOS"))?;
    let contents = macos.parent().filter(|p| p.file_name().is_some_and(|n| n == "Contents"))?;
    contents.parent().filter(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf)
}

/// `update::Host` in the app.
pub struct AppHost<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AppHost<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        AppHost { app }
    }
}

impl<R: Runtime> Reopen for AppHost<R> {
    fn open_new(&self) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let bundle = bundle_of(&exe).ok_or_else(|| format!("not in an app bundle: {}", exe.display()))?;
        let st = std::process::Command::new("/usr/bin/open").arg("-n").arg(&bundle).status().map_err(|e| e.to_string())?;
        if st.success() { Ok(()) } else { Err(tr(i18n::current(), "cmd.openExit", &[("code", &st.code().unwrap_or(-1).to_string())])) }
    }
    fn tell_reopen(&self, version: &str) {
        let _ = dialogs::show_blocking(&self.app, dialogs::reopen_alert(i18n::current(), version));
    }
    fn exit(&self) {
        self.app.exit(0);
    }
}

impl<R: Runtime> Host for AppHost<R> {
    fn hold(&self) -> Result<Box<dyn HoldLink>, String> {
        let lang = i18n::current();
        let tok = token().ok_or_else(|| tr(lang, "client.noToken", &[]))?;
        let port = self.app.state::<AppState>().port();
        client::Hold::open(port, &tok).map(|h| Box::new(h) as Box<dyn HoldLink>).map_err(|e| e.text(lang))
    }
    fn relaunch(&self, version: &str) -> Result<(), String> {
        relaunch(&RealLaunchctl::default(), self, version)
    }
}

/// `update_start`: the machine on its own thread (it blocks until the relaunch; a second start meanwhile is dropped).
pub fn spawn_start<R: Runtime>(app: AppHandle<R>, m: std::sync::Arc<Machine>) {
    std::thread::spawn(move || {
        let host = AppHost::new(app);
        m.start(&host);
    });
}

#[cfg(test)]
mod tests {
    use super::{bundle_of, relaunch, Reopen};
    use ccs_core::launchd::Launchctl;
    use ccs_core::paths;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    type Log = Arc<Mutex<Vec<String>>>;
    fn push(l: &Log, s: impl Into<String>) {
        l.lock().unwrap().push(s.into());
    }

    struct FakeLc {
        log: Log,
        loaded: Mutex<bool>,
        bootout: Result<(), String>,
    }
    impl Launchctl for FakeLc {
        fn is_loaded(&self, _label: &str) -> bool {
            *self.loaded.lock().unwrap()
        }
        fn bootstrap(&self, p: &Path) -> Result<(), String> {
            push(&self.log, format!("bootstrap {}", p.display()));
            Ok(())
        }
        fn bootout(&self, label: &str) -> Result<(), String> {
            push(&self.log, format!("bootout {label}"));
            if self.bootout.is_ok() {
                *self.loaded.lock().unwrap() = false;
            }
            self.bootout.clone()
        }
        fn kickstart_kill(&self, label: &str) -> Result<(), String> {
            push(&self.log, format!("kickstart {label}"));
            Ok(())
        }
    }

    struct FakeSys {
        log: Log,
        open: Result<(), String>,
    }
    impl Reopen for FakeSys {
        fn open_new(&self) -> Result<(), String> {
            push(&self.log, "open -n");
            self.open.clone()
        }
        fn tell_reopen(&self, version: &str) {
            push(&self.log, format!("dialog {version}"));
        }
        fn exit(&self) {
            push(&self.log, "exit 0");
        }
    }

    fn rig(bootout: Result<(), String>, open: Result<(), String>) -> (Log, FakeLc, FakeSys) {
        let log: Log = Arc::default();
        (log.clone(), FakeLc { log: log.clone(), loaded: Mutex::new(true), bootout }, FakeSys { log, open })
    }

    #[test]
    fn s5_5_bootout_the_one_engine_job_then_open_n_then_exit() {
        let (log, lc, sys) = rig(Ok(()), Ok(()));
        assert_eq!(relaunch(&lc, &sys, "0.3.1"), Ok(()));
        assert_eq!(*log.lock().unwrap(), vec![format!("bootout {}", paths::engine_label()), "open -n".into(), "exit 0".into()]);
    }

    #[test]
    fn hf_bg2_only_the_engine_label_is_booted_out_never_the_retired_menubar() {
        let (log, lc, sys) = rig(Ok(()), Ok(()));
        relaunch(&lc, &sys, "0.3.1").unwrap();
        let outs: Vec<String> = log.lock().unwrap().iter().filter(|l| l.starts_with("bootout")).cloned().collect();
        assert_eq!(outs, vec![format!("bootout {}", paths::engine_label())]);
        assert!(!outs.iter().any(|l| l.ends_with(".menubar")));
    }

    #[test]
    fn s5_5_5_open_n_fails_shows_the_reopen_dialog_then_exits() {
        let (log, lc, sys) = rig(Ok(()), Err("open exit 1".into()));
        assert_eq!(relaunch(&lc, &sys, "0.3.1"), Ok(()));
        assert_eq!(*log.lock().unwrap(), vec![format!("bootout {}", paths::engine_label()), "open -n".into(), "dialog 0.3.1".into(), "exit 0".into()]);
    }

    #[test]
    fn s5_5_bootout_fails_nothing_is_opened_and_the_app_stays() {
        let (log, lc, sys) = rig(Err("launchctl bootout: EPERM".into()), Ok(()));
        assert_eq!(relaunch(&lc, &sys, "0.3.1"), Err("launchctl bootout: EPERM".into()));
        assert_eq!(*log.lock().unwrap(), vec![format!("bootout {}", paths::engine_label())], "no open -n, no exit (error{{relaunch}})");
    }

    #[test]
    fn s5_5_3_the_running_bundle_is_reopened_not_a_fixed_applications_path() {
        let p = |s: &str| bundle_of(Path::new(s));
        assert_eq!(p("/Applications/cc-slaves.app/Contents/MacOS/cc-slaves"), Some(PathBuf::from("/Applications/cc-slaves.app")));
        assert_eq!(p("/Users/po/Tạm thử/cc-slaves.app/Contents/MacOS/cc-slaves"), Some(PathBuf::from("/Users/po/Tạm thử/cc-slaves.app")));
        assert_eq!(p("/x/target/debug/cc-slaves"), None, "a dev binary is not a bundle (→ the reopen dialog)");
        assert_eq!(p("/x/cc-slaves.app/Contents/Resources/cc-slaves"), None, "only the bundle's main binary");
        assert_eq!(p("/x/Other/Contents/MacOS/cc-slaves"), None, "the folder must be a .app");
    }
}
