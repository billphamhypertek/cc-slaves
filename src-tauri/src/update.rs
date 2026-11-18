//! v2.6 §5.1–§5.5 the app's update machine: check (10 s after start, then every 6 h, or by hand), download, hold the
//! engine's user lines over the app's own long-lived WS, install on `update_ready`, `update_commit`, relaunch. The
//! updater and the engine side sit behind traits so the order is tested with fakes (§13).
use ccs_core::client::{self, ClientError, CommitResult, HoldEvent, UpdateBusy};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

/// §5.2 / §9.2 R1: 10 s after the app opens, then every 6 h while it runs.
pub const FIRST_CHECK: Duration = Duration::from_secs(10);
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
/// How long one `next_event` blocks, so Huỷ chờ is seen within it.
const TICK: Duration = Duration::from_millis(250);
/// Download progress is emitted at most this often (and always at the end).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// §5.1 `error{stage}`; `wait` = the hold could not be taken or the engine went away while waiting (UP6d).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Stage {
    Check,
    Download,
    Wait,
    Install,
    Relaunch,
}

/// §5.1, pushed to the web as the Tauri event `update_state` (camelCase fields, tag `state`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum UpdateState {
    Idle { checked_at: Option<u64> },
    Checking,
    Available { version: String, notes: String, current: String, dismissed: bool },
    Downloading { version: String, done: u64, total: Option<u64> },
    Waiting { version: String, busy: Vec<UpdateBusy>, held: u32, since: Option<u64>, installed: bool },
    Installing { version: String },
    Relaunching { version: String },
    Installed { version: String },
    Error { stage: Stage, reason: String, version: Option<String>, bad_signature: bool },
}

/// A newer version announced by `latest.json` (the plugin compares versions, §5.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub notes: String,
    pub current: String,
}

/// A download / install failure; `signature` = the package did not match the built-in public key (UP6b).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fail {
    pub reason: String,
    pub signature: bool,
}

/// `tauri-plugin-updater` in the app ([`PluginUpdater`]), a fake in tests.
pub trait Updater: Send + Sync {
    fn check(&self) -> Result<Option<Release>, String>;
    /// Stops early (any `Err`) once `cancelled` turns true (UP3 Huỷ).
    fn download(&self, progress: &mut dyn FnMut(u64, Option<u64>), cancelled: &dyn Fn() -> bool) -> Result<Vec<u8>, Fail>;
    fn install(&self, bytes: &[u8]) -> Result<(), Fail>;
}

/// The app's long-lived holding WS ([`client::Hold`]), a fake in tests.
pub trait HoldLink: Send {
    fn next_event(&mut self, wait: Duration) -> Result<Option<HoldEvent>, ClientError>;
    fn commit(&mut self) -> Result<CommitResult, ClientError>;
    fn release(&mut self) -> Result<(), ClientError>;
}

/// What the machine needs from the app around the engine: take the hold (§5.4) and stop + reopen (§5.5 steps 2–3).
pub trait Host {
    fn hold(&self) -> Result<Box<dyn HoldLink>, String>;
    fn relaunch(&self, version: &str) -> Result<(), String>;
}

type Emit = Box<dyn Fn(&UpdateState) + Send + Sync>;

/// Outcome of one wait for `update_ready`.
enum Wait {
    Ready,
    Cancelled,
    Lost(String),
}

pub struct Machine {
    updater: Box<dyn Updater>,
    emit: Emit,
    dismissed_file: PathBuf,
    state: Mutex<UpdateState>,
    release: Mutex<Option<Release>>,
    cancel: AtomicBool,
    /// Held by a running check or start, so a check never lands on top of a start (and the plugin's `Update` stays
    /// the one downloaded); a start waits for a check in flight.
    op: Mutex<()>,
    /// A start already running: a second Cập nhật click meanwhile is dropped.
    starting: Mutex<()>,
    /// `(version, package)` after a hold / install failure, so UP6 Thử lại does not download again (UP6d); Đóng drops it.
    kept: Mutex<Option<(String, Vec<u8>)>>,
}

impl Machine {
    pub fn new(updater: Box<dyn Updater>, emit: Emit, dismissed_file: PathBuf) -> Self {
        Machine { updater, emit, dismissed_file, state: Mutex::new(UpdateState::Idle { checked_at: None }), release: Mutex::default(), cancel: AtomicBool::new(false), op: Mutex::default(), starting: Mutex::default(), kept: Mutex::default() }
    }
    pub fn state(&self) -> UpdateState {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set(&self, s: UpdateState) {
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = s.clone();
        (self.emit)(&s);
    }

    fn dismissed(&self, version: &str) -> bool {
        std::fs::read_to_string(&self.dismissed_file).is_ok_and(|v| v.trim() == version)
    }

    fn available(&self, r: &Release) -> UpdateState {
        UpdateState::Available { version: r.version.clone(), notes: r.notes.clone(), current: r.current.clone(), dismissed: self.dismissed(&r.version) }
    }

    /// §5.2. Skipped while a start or another check runs; busy states and an installed bundle (also `error{relaunch}`)
    /// are left alone. Only a manual check shows `checking`. An automatic check error shows only in Settings (UP7c) and
    /// never replaces a release or another error the PO sees.
    pub fn check(&self, manual: bool) {
        let Ok(_op) = self.op.try_lock() else { return };
        let before = self.state();
        if matches!(before, UpdateState::Error { stage: Stage::Relaunch, .. }) || !matches!(before, UpdateState::Idle { .. } | UpdateState::Available { .. } | UpdateState::Error { .. }) {
            return;
        }
        if manual {
            self.set(UpdateState::Checking);
        }
        match self.updater.check() {
            Ok(Some(r)) => {
                let s = self.available(&r);
                *self.release.lock().unwrap_or_else(|e| e.into_inner()) = Some(r);
                self.set(s);
            }
            Ok(None) => self.set(UpdateState::Idle { checked_at: Some(now_ms()) }),
            Err(reason) if manual || matches!(before, UpdateState::Idle { .. } | UpdateState::Error { stage: Stage::Check, .. }) => {
                self.set(UpdateState::Error { stage: Stage::Check, reason, version: None, bad_signature: false })
            }
            Err(reason) => eprintln!("[cc-slaves] update check: {reason}"),
        }
    }

    /// "Để sau" (§5.2): remembered per version in the app state (`~/.cc-slaves/`, not `state.db`).
    pub fn dismiss(&self) {
        if let UpdateState::Available { version, notes, current, .. } = self.state() {
            self.remember_dismissed(&version);
            self.set(UpdateState::Available { version, notes, current, dismissed: true });
        }
    }

    fn remember_dismissed(&self, version: &str) {
        if let Err(e) = std::fs::write(&self.dismissed_file, version) {
            eprintln!("[cc-slaves] update dismiss: {e}");
        }
    }

    /// `update_cancel`. UP3 Huỷ / UP4 Huỷ chờ (§4.3, §4.4, R16): seen by `start` (download aborted, or the hold released
    /// within one tick). UP6 Đóng (§4.6): back to `available`, dismissed for a bad signature; `installed` after a relaunch
    /// error (the bundle is on disk); `idle` for a check error with no release known.
    pub fn cancel(&self) {
        match self.state() {
            UpdateState::Downloading { .. } | UpdateState::Waiting { .. } => self.cancel.store(true, Ordering::SeqCst),
            UpdateState::Error { stage: Stage::Relaunch, version: Some(version), .. } => self.set(UpdateState::Installed { version }),
            UpdateState::Error { bad_signature, .. } => {
                *self.kept.lock().unwrap_or_else(|e| e.into_inner()) = None;
                let rel = self.release.lock().unwrap_or_else(|e| e.into_inner()).clone();
                match rel {
                    Some(r) => {
                        if bad_signature {
                            self.remember_dismissed(&r.version);
                        }
                        self.set(self.available(&r));
                    }
                    None => self.set(UpdateState::Idle { checked_at: None }),
                }
            }
            _ => {}
        }
    }

    /// Back to `available` after Huỷ while downloading; nothing was held, so nothing is released.
    fn cancelled_download(&self) -> bool {
        if !self.cancel.swap(false, Ordering::SeqCst) {
            return false;
        }
        if let Some(r) = self.release.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            self.set(self.available(&r));
        }
        true
    }

    /// A hold / install failure after a good download: show it and keep the package for Thử lại.
    fn failed(&self, s: UpdateState, version: &str, bytes: Vec<u8>) {
        *self.kept.lock().unwrap_or_else(|e| e.into_inner()) = Some((version.to_string(), bytes));
        self.set(s);
    }

    fn wait_ready(&self, link: &mut dyn HoldLink, version: &str, installed: bool) -> Wait {
        loop {
            if self.cancel.swap(false, Ordering::SeqCst) {
                return Wait::Cancelled;
            }
            match link.next_event(TICK) {
                Ok(Some(HoldEvent::Ready)) => return Wait::Ready,
                Ok(Some(HoldEvent::Info(i))) => {
                    self.set(UpdateState::Waiting { version: version.into(), busy: i.busy, held: i.held, since: i.since, installed })
                }
                Ok(None) => {}
                Err(e) => return Wait::Lost(e.to_string()),
            }
        }
    }

    /// Blocking: §5.3 download → §5.4 hold and wait → §5.5 install, commit (busy → wait again), relaunch. From
    /// `installed` (R16) it goes straight to the hold and step 1b. UP6 Thử lại from an `error` with a version: again from
    /// the download (from the hold with the kept package after a hold / install error), or from the hold after a
    /// relaunch error. Ignored in any other state, and while another start runs.
    pub fn start(&self, host: &dyn Host) {
        let Ok(_starting) = self.starting.try_lock() else { return };
        let _op = self.op.lock().unwrap_or_else(|e| e.into_inner());
        let kept = self.kept.lock().unwrap_or_else(|e| e.into_inner()).take();
        let rel = self.release.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let (version, mut installed, mut bytes) = match (self.state(), rel) {
            (UpdateState::Error { stage: Stage::Relaunch, version: Some(version), .. } | UpdateState::Installed { version }, _) => (version, true, None),
            (UpdateState::Available { version, .. } | UpdateState::Error { version: Some(version), .. }, Some(r)) if r.version == version => {
                let bytes = kept.filter(|(v, _)| *v == version).map(|(_, b)| b);
                (version, false, bytes)
            }
            _ => return,
        };
        self.cancel.store(false, Ordering::SeqCst);
        let err = |stage, reason: String, bad_signature| UpdateState::Error { stage, reason, version: Some(version.clone()), bad_signature };
        if !installed && bytes.is_none() {
            self.set(UpdateState::Downloading { version: version.clone(), done: 0, total: None });
            let mut last: Option<std::time::Instant> = None;
            let mut progress = |done: u64, total: Option<u64>| {
                if last.is_none_or(|t| t.elapsed() >= PROGRESS_EVERY) || Some(done) == total {
                    last = Some(std::time::Instant::now());
                    self.set(UpdateState::Downloading { version: version.clone(), done, total });
                }
            };
            let result = self.updater.download(&mut progress, &|| self.cancel.load(Ordering::SeqCst));
            if self.cancelled_download() {
                return;
            }
            match result {
                Ok(b) => bytes = Some(b),
                Err(f) => return self.set(err(Stage::Download, f.reason, f.signature)),
            }
        }
        let bytes = bytes.unwrap_or_default();
        let mut link = match host.hold() {
            Ok(l) => l,
            Err(_) if installed => return self.set(UpdateState::Installed { version }),
            Err(reason) => return self.failed(err(Stage::Wait, reason, false), &version, bytes),
        };
        self.set(UpdateState::Waiting { version: version.clone(), busy: vec![], held: 0, since: None, installed });
        loop {
            match self.wait_ready(link.as_mut(), &version, installed) {
                Wait::Ready => {}
                Wait::Cancelled => {
                    let _ = link.release();
                    let back = match (installed, self.release.lock().unwrap_or_else(|e| e.into_inner()).as_ref()) {
                        (false, Some(r)) => self.available(r),
                        _ => UpdateState::Installed { version },
                    };
                    return self.set(back);
                }
                Wait::Lost(_) if installed => return self.set(UpdateState::Installed { version }),
                Wait::Lost(reason) => return self.failed(err(Stage::Wait, reason, false), &version, bytes),
            }
            if !installed {
                self.set(UpdateState::Installing { version: version.clone() });
                if let Err(f) = self.updater.install(&bytes) {
                    let _ = link.release();
                    return self.failed(err(Stage::Install, f.reason, f.signature), &version, bytes);
                }
                installed = true;
            }
            match link.commit() {
                Ok(CommitResult::Ok) => break,
                Ok(CommitResult::Busy(busy)) => self.set(UpdateState::Waiting { version: version.clone(), busy, held: 0, since: None, installed }),
                Err(_) => return self.set(UpdateState::Installed { version }),
            }
        }
        self.set(UpdateState::Relaunching { version: version.clone() });
        if let Err(reason) = host.relaunch(&version) {
            self.set(err(Stage::Relaunch, reason, false));
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl HoldLink for client::Hold {
    fn next_event(&mut self, wait: Duration) -> Result<Option<HoldEvent>, ClientError> {
        client::Hold::next_event(self, wait)
    }
    fn commit(&mut self) -> Result<CommitResult, ClientError> {
        client::Hold::commit(self)
    }
    fn release(&mut self) -> Result<(), ClientError> {
        client::Hold::release(self)
    }
}

/// §5.3 signature failures (UP6b) apart from every other download / install error.
pub fn fail(e: tauri_plugin_updater::Error) -> Fail {
    use tauri_plugin_updater::Error as E;
    let signature = matches!(e, E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion);
    Fail { reason: e.to_string(), signature }
}

/// The real updater: `tauri-plugin-updater` (endpoint + public key from `tauri.conf.json`, §7.2). The `Update` found by
/// `check` is kept for `download` / `install`; the package stays in memory (§5.3).
pub struct PluginUpdater<R: Runtime> {
    app: AppHandle<R>,
    found: Mutex<Option<tauri_plugin_updater::Update>>,
}

impl<R: Runtime> PluginUpdater<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        PluginUpdater { app, found: Mutex::default() }
    }

    fn found(&self) -> Result<tauri_plugin_updater::Update, Fail> {
        self.found.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or(Fail { reason: "no update checked".into(), signature: false })
    }
}

impl<R: Runtime> Updater for PluginUpdater<R> {
    fn check(&self) -> Result<Option<Release>, String> {
        let up = self.app.updater().map_err(|e| e.to_string())?;
        let found = tauri::async_runtime::block_on(up.check()).map_err(|e| e.to_string())?;
        let r = found.as_ref().map(|u| Release { version: u.version.clone(), notes: u.body.clone().unwrap_or_default(), current: u.current_version.clone() });
        *self.found.lock().unwrap_or_else(|e| e.into_inner()) = found;
        Ok(r)
    }

    /// The download runs as a task; this thread relays its progress and aborts the task on Huỷ (UP3).
    fn download(&self, progress: &mut dyn FnMut(u64, Option<u64>), cancelled: &dyn Fn() -> bool) -> Result<Vec<u8>, Fail> {
        enum Msg {
            Chunk(u64, Option<u64>),
            Done(Result<Vec<u8>, Fail>),
        }
        let u = self.found()?;
        let (tx, rx) = std::sync::mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            let mut done = 0u64;
            let chunks = tx.clone();
            let r = u
                .download(
                    move |chunk, total| {
                        done += chunk as u64;
                        let _ = chunks.send(Msg::Chunk(done, total));
                    },
                    || {},
                )
                .await;
            let _ = tx.send(Msg::Done(r.map_err(fail)));
        });
        loop {
            if cancelled() {
                task.abort();
                return Err(Fail { reason: "cancelled".into(), signature: false });
            }
            match rx.recv_timeout(TICK) {
                Ok(Msg::Chunk(done, total)) => progress(done, total),
                Ok(Msg::Done(r)) => return r,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(Fail { reason: "download stopped".into(), signature: false }),
            }
        }
    }

    fn install(&self, bytes: &[u8]) -> Result<(), Fail> {
        self.found()?.install(bytes).map_err(fail)
    }
}

/// §5.2 the automatic checks, forever on their own thread.
pub fn run_checks(m: &Machine) {
    std::thread::sleep(FIRST_CHECK);
    loop {
        m.check(false);
        std::thread::sleep(CHECK_EVERY);
    }
}

pub mod install;

#[cfg(test)]
mod tests;
