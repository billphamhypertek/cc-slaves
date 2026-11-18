//! v2.6 §13 "Unit Rust": the §5.1 machine with a fake updater (trait) and a fake engine (hold link + host).
use super::*;
use ccs_core::client::{ClientError, CommitResult, HoldEvent, UpdateBusy, UpdateInfo};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The state's tag, for the waits below.
impl UpdateState {
    fn name(&self) -> &'static str {
        match self {
            Self::Idle { .. } => "idle",
            Self::Checking => "checking",
            Self::Available { .. } => "available",
            Self::Downloading { .. } => "downloading",
            Self::Waiting { .. } => "waiting",
            Self::Installing { .. } => "installing",
            Self::Relaunching { .. } => "relaunching",
            Self::Installed { .. } => "installed",
            Self::Error { .. } => "error",
        }
    }
}

type Log = Arc<Mutex<Vec<String>>>;

fn push(log: &Log, s: impl Into<String>) {
    log.lock().unwrap().push(s.into());
}

type Hook = Box<dyn Fn() + Send>;

#[derive(Clone)]
struct FakeUpdater {
    log: Log,
    check: Arc<Mutex<Result<Option<Release>, String>>>,
    download: Arc<Mutex<Result<Vec<u8>, Fail>>>,
    install: Arc<Mutex<Result<(), Fail>>>,
    /// The download never finishes on its own: it polls `cancelled` like the plugin wrapper and then fails.
    hang: Arc<AtomicBool>,
    /// Runs inside the last progress tick (a Huỷ press the download can no longer see).
    last_chunk: Arc<Mutex<Option<Hook>>>,
    /// Held by a test to keep a `check` in flight (the 6 h timer racing a Cập nhật press).
    check_gate: Arc<Mutex<()>>,
}

impl Updater for FakeUpdater {
    fn check(&self) -> Result<Option<Release>, String> {
        push(&self.log, "check");
        drop(self.check_gate.lock().unwrap());
        self.check.lock().unwrap().clone()
    }
    fn download(&self, progress: &mut dyn FnMut(u64, Option<u64>), cancelled: &dyn Fn() -> bool) -> Result<Vec<u8>, Fail> {
        push(&self.log, "download");
        progress(5, Some(10));
        if self.hang.load(Ordering::SeqCst) {
            until(cancelled);
            push(&self.log, "download aborted");
            return Err(Fail { reason: "cancelled".into(), signature: false });
        }
        progress(10, Some(10));
        if let Some(f) = self.last_chunk.lock().unwrap().take() {
            f();
        }
        self.download.lock().unwrap().clone()
    }
    fn install(&self, bytes: &[u8]) -> Result<(), Fail> {
        push(&self.log, format!("install {}", String::from_utf8_lossy(bytes)));
        self.install.lock().unwrap().clone()
    }
}

/// Scripted engine side: each `next_event` pops one step (`None` = quiet tick); empty script = quiet forever.
type Step = Result<Option<HoldEvent>, ClientError>;

struct FakeLink {
    log: Log,
    events: VecDeque<Step>,
    commits: VecDeque<Result<CommitResult, ClientError>>,
    /// Events pushed after each commit (the engine re-sends `update_ready` once busy empties again).
    after_commit: VecDeque<Vec<Step>>,
}

impl HoldLink for FakeLink {
    fn next_event(&mut self, _wait: Duration) -> Result<Option<HoldEvent>, ClientError> {
        let e = self.events.pop_front().unwrap_or(Ok(None));
        match &e {
            Ok(Some(HoldEvent::Info(_))) => push(&self.log, "event Info"),
            Ok(Some(HoldEvent::Ready)) => push(&self.log, "event Ready"),
            _ => {}
        }
        e
    }
    fn commit(&mut self) -> Result<CommitResult, ClientError> {
        push(&self.log, "commit");
        if let Some(more) = self.after_commit.pop_front() {
            self.events.extend(more);
        }
        self.commits.pop_front().unwrap_or(Ok(CommitResult::Ok))
    }
    fn release(&mut self) -> Result<(), ClientError> {
        push(&self.log, "release");
        Ok(())
    }
}

struct FakeHost {
    log: Log,
    link: Mutex<Option<FakeLink>>,
    relaunch: Result<(), String>,
}

impl Host for FakeHost {
    fn hold(&self) -> Result<Box<dyn HoldLink>, String> {
        push(&self.log, "hold");
        match self.link.lock().unwrap().take() {
            Some(l) => Ok(Box::new(l)),
            None => Err("engine down".into()),
        }
    }
    fn relaunch(&self, version: &str) -> Result<(), String> {
        push(&self.log, format!("relaunch {version}"));
        self.relaunch.clone()
    }
}

fn rel(v: &str) -> Release {
    Release { version: v.into(), notes: "notes".into(), current: "0.3.0".into() }
}

fn busy() -> Vec<UpdateBusy> {
    vec![UpdateBusy { project_id: "p".into(), kind: "lane".into(), name: "api".into(), turn_started_at: 7 }]
}

fn info(b: Vec<UpdateBusy>, held: u32) -> Step {
    Ok(Some(HoldEvent::Info(UpdateInfo { since: Some(5), busy: b, held })))
}

fn ready() -> Step {
    Ok(Some(HoldEvent::Ready))
}

struct Rig {
    m: Arc<Machine>,
    up: FakeUpdater,
    log: Log,
    seen: Arc<Mutex<Vec<UpdateState>>>,
    _dir: tempfile::TempDir,
}

fn rig(check: Result<Option<Release>, String>) -> Rig {
    let log: Log = Arc::default();
    let seen: Arc<Mutex<Vec<UpdateState>>> = Arc::default();
    let up = FakeUpdater { log: log.clone(), check: Arc::new(Mutex::new(check)), download: Arc::new(Mutex::new(Ok(b"pkg".to_vec()))), install: Arc::new(Mutex::new(Ok(()))), hang: Arc::default(), last_chunk: Arc::default(), check_gate: Arc::default() };
    let dir = tempfile::tempdir().unwrap();
    let s2 = seen.clone();
    let m = Machine::new(Box::new(up.clone()), Box::new(move |s: &UpdateState| s2.lock().unwrap().push(s.clone())), dir.path().join("update-dismissed"));
    Rig { m: Arc::new(m), up, log, seen, _dir: dir }
}

impl Rig {
    fn host(&self, events: Vec<Step>, commits: Vec<Result<CommitResult, ClientError>>, after_commit: Vec<Vec<Step>>) -> FakeHost {
        let link = FakeLink { log: self.log.clone(), events: events.into(), commits: commits.into(), after_commit: after_commit.into() };
        FakeHost { log: self.log.clone(), link: Mutex::new(Some(link)), relaunch: Ok(()) }
    }
    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
    fn names(&self) -> Vec<&'static str> {
        self.seen.lock().unwrap().iter().map(UpdateState::name).collect()
    }
}

/// Spins until `f` holds; panics after 5 s so a broken machine fails instead of hanging the suite.
fn until(f: impl Fn() -> bool) {
    let t = std::time::Instant::now();
    while !f() {
        assert!(t.elapsed() < Duration::from_secs(5), "state never reached");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn available(v: &str, dismissed: bool) -> UpdateState {
    UpdateState::Available { version: v.into(), notes: "notes".into(), current: "0.3.0".into(), dismissed }
}

#[test]
fn s5_2_check_found_is_available_and_nothing_new_is_idle_with_the_time() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(true);
    assert_eq!(r.names(), vec!["checking", "available"], "a manual check shows checking (UP7b)");
    assert_eq!(r.m.state(), available("0.3.1", false));
    *r.up.check.lock().unwrap() = Ok(None);
    r.m.check(false);
    assert!(matches!(r.m.state(), UpdateState::Idle { checked_at: Some(t) } if t > 0), "UP7a 'kiểm tra lúc HH:MM'");
}

fn check_error(reason: &str) -> UpdateState {
    UpdateState::Error { stage: Stage::Check, reason: reason.into(), version: None, bad_signature: false }
}

#[test]
fn up7c_an_automatic_check_error_is_a_check_error_without_flashing_checking() {
    let r = rig(Err("GitHub 404".into()));
    r.m.check(false);
    assert_eq!(r.names(), vec!["error"], "no `checking`; the chip hides stage check, Settings shows it (UP7c)");
    assert_eq!(r.m.state(), check_error("GitHub 404"));
    r.m.check(true);
    assert_eq!(r.names(), vec!["error", "checking", "error"]);
    assert_eq!(r.m.state(), check_error("GitHub 404"));
}

#[test]
fn up7c_an_automatic_check_error_leaves_a_download_error_on_screen() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    *r.up.download.lock().unwrap() = Err(Fail { reason: "offline".into(), signature: false });
    r.m.start(&r.host(vec![], vec![], vec![]));
    let shown = r.m.state();
    *r.up.check.lock().unwrap() = Err("offline".into());
    r.m.check(false);
    assert_eq!(r.m.state(), shown, "UP6a stays; the 6 h check failing does not replace it");
}

#[test]
fn rv_a_i2_a_check_after_a_relaunch_error_keeps_the_installed_bundle() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let mut h = r.host(vec![ready()], vec![], vec![]);
    h.relaunch = Err("open -n".into());
    r.m.start(&h);
    let shown = r.m.state();
    r.log.lock().unwrap().clear();
    r.m.check(false);
    r.m.check(true);
    assert!(r.log().is_empty(), "no check: the new bundle is already on disk");
    assert_eq!(r.m.state(), shown);
}

#[test]
fn rv_a_i1_a_check_in_flight_never_overwrites_a_start() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let gate = r.up.check_gate.lock().unwrap();
    let m = r.m.clone();
    let checking = std::thread::spawn(move || m.check(false));
    until(|| r.log().iter().filter(|l| *l == "check").count() == 2);
    let (m, h) = (r.m.clone(), r.host(vec![], vec![], vec![]));
    let starting = std::thread::spawn(move || m.start(&h));
    std::thread::sleep(Duration::from_millis(100));
    drop(gate);
    checking.join().unwrap();
    until(|| r.m.state().name() == "waiting");
    r.m.cancel();
    starting.join().unwrap();
    assert_eq!(r.log().last().map(String::as_str), Some("release"), "Huỷ chờ still works: the hold is released");
    assert_eq!(r.m.state(), available("0.3.1", false));
}

#[test]
fn update_start_runs_one_machine_at_a_time() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    r.up.hang.store(true, Ordering::SeqCst);
    let (m, h) = (r.m.clone(), r.host(vec![], vec![], vec![]));
    let first = std::thread::spawn(move || m.start(&h));
    until(|| r.m.state().name() == "downloading");
    r.m.start(&r.host(vec![], vec![], vec![]));
    assert_eq!(r.log().iter().filter(|l| *l == "download").count(), 1, "a second click while one runs does nothing");
    r.m.cancel();
    first.join().unwrap();
    r.up.hang.store(false, Ordering::SeqCst);
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert_eq!(r.m.state().name(), "relaunching", "after it ends a new start runs");
}

#[test]
fn rv_a_m1_retry_after_a_wait_error_reuses_the_downloaded_package() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    r.m.start(&FakeHost { log: r.log.clone(), link: Mutex::new(None), relaunch: Ok(()) });
    assert!(matches!(r.m.state(), UpdateState::Error { stage: Stage::Wait, .. }));
    *r.up.download.lock().unwrap() = Ok(b"other".to_vec());
    r.log.lock().unwrap().clear();
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert_eq!(r.log(), vec!["hold", "event Ready", "install pkg", "commit", "relaunch 0.3.1"], "UP6d Thử lại: no second download");
}

#[test]
fn rv_a_m1_closing_a_wait_error_drops_the_package() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    r.m.start(&FakeHost { log: r.log.clone(), link: Mutex::new(None), relaunch: Ok(()) });
    r.m.cancel();
    r.log.lock().unwrap().clear();
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert_eq!(r.log().first().map(String::as_str), Some("download"), "Đóng then Cập nhật starts over");
}

#[test]
fn s5_2_auto_check_error_keeps_a_known_release() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    *r.up.check.lock().unwrap() = Err("offline".into());
    r.m.check(false);
    assert_eq!(r.m.state(), available("0.3.1", false), "the chip stays when GitHub is briefly unreachable");
}

#[test]
fn s5_2_auto_check_does_not_flash_checking() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    assert_eq!(r.names(), vec!["available"]);
}

#[test]
fn s5_2_dismiss_is_per_version() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    r.m.dismiss();
    assert_eq!(r.m.state(), available("0.3.1", true));
    r.m.check(false);
    assert_eq!(r.m.state(), available("0.3.1", true), "the same version stays dismissed after the next check");
    *r.up.check.lock().unwrap() = Ok(Some(rel("0.3.2")));
    r.m.check(false);
    assert_eq!(r.m.state(), available("0.3.2", false), "a newer version shows again");
}

#[test]
fn s5_5_happy_path_downloads_before_hold_installs_on_ready_then_commits_then_relaunches() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let h = r.host(vec![info(busy(), 2), Ok(None), info(vec![], 2), ready()], vec![], vec![]);
    r.m.start(&h);
    assert_eq!(
        r.log(),
        vec!["check", "download", "hold", "event Info", "event Info", "event Ready", "install pkg", "commit", "relaunch 0.3.1"],
        "§5.3 download before the hold; §5.5 install → commit → relaunch"
    );
    assert_eq!(r.names(), vec!["available", "downloading", "downloading", "downloading", "waiting", "waiting", "waiting", "installing", "relaunching"]);
    let waits: Vec<UpdateState> = r.seen.lock().unwrap().iter().filter(|s| s.name() == "waiting").cloned().collect();
    assert_eq!(waits[1], UpdateState::Waiting { version: "0.3.1".into(), busy: busy(), held: 2, since: Some(5), installed: false });
    assert!(r.seen.lock().unwrap().contains(&UpdateState::Downloading { version: "0.3.1".into(), done: 10, total: Some(10) }));
}

#[test]
fn s5_3_bad_signature_is_a_download_error_and_never_holds() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    *r.up.download.lock().unwrap() = Err(Fail { reason: "minisign".into(), signature: true });
    let h = r.host(vec![ready()], vec![], vec![]);
    r.m.start(&h);
    assert_eq!(r.log(), vec!["check", "download"]);
    assert_eq!(r.m.state(), UpdateState::Error { stage: Stage::Download, reason: "minisign".into(), version: Some("0.3.1".into()), bad_signature: true });
}

#[test]
fn s5_5_install_error_releases_the_hold() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    *r.up.install.lock().unwrap() = Err(Fail { reason: "disk".into(), signature: false });
    let h = r.host(vec![ready()], vec![], vec![]);
    r.m.start(&h);
    assert_eq!(r.log(), vec!["check", "download", "hold", "event Ready", "install pkg", "release"]);
    assert_eq!(r.m.state(), UpdateState::Error { stage: Stage::Install, reason: "disk".into(), version: Some("0.3.1".into()), bad_signature: false });
}

#[test]
fn s5_4_9_commit_busy_waits_again_installed_then_commits_without_reinstalling() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let h = r.host(vec![ready()], vec![Ok(CommitResult::Busy(busy())), Ok(CommitResult::Ok)], vec![vec![Ok(None), ready()]]);
    r.m.start(&h);
    assert_eq!(r.log(), vec!["check", "download", "hold", "event Ready", "install pkg", "commit", "event Ready", "commit", "relaunch 0.3.1"]);
    assert!(r.seen.lock().unwrap().contains(&UpdateState::Waiting { version: "0.3.1".into(), busy: busy(), held: 0, since: None, installed: true }), "UP4c");
}

#[test]
fn s5_4_cancel_while_waiting_releases_and_returns_to_available() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let h = r.host(vec![info(busy(), 1)], vec![], vec![]);
    let m = r.m.clone();
    let t = std::thread::spawn(move || {
        until(|| m.state().name() == "waiting");
        m.cancel();
    });
    r.m.start(&h);
    t.join().unwrap();
    assert_eq!(r.log().last().map(String::as_str), Some("release"));
    assert!(!r.log().iter().any(|l| l.starts_with("install")));
    assert_eq!(r.m.state(), available("0.3.1", false));
}

#[test]
fn r16_cancel_after_install_is_installed_and_restart_skips_download_and_install() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let h = r.host(vec![ready()], vec![Ok(CommitResult::Busy(busy()))], vec![]);
    let m = r.m.clone();
    let t = std::thread::spawn(move || {
        until(|| matches!(m.state(), UpdateState::Waiting { installed: true, .. }));
        m.cancel();
    });
    r.m.start(&h);
    t.join().unwrap();
    assert_eq!(r.m.state(), UpdateState::Installed { version: "0.3.1".into() });
    r.log.lock().unwrap().clear();
    r.m.check(true);
    assert_eq!(r.m.state(), UpdateState::Installed { version: "0.3.1".into() }, "no check over an installed bundle");
    let h = r.host(vec![ready()], vec![], vec![]);
    r.m.start(&h);
    assert_eq!(r.log(), vec!["hold", "event Ready", "commit", "relaunch 0.3.1"], "§5.4-9 straight to step 1b");
}

#[test]
fn s5_4_6_lost_engine_while_waiting_is_an_error_and_nothing_installed() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let h = r.host(vec![info(busy(), 1), Err(ClientError::Closed)], vec![], vec![]);
    r.m.start(&h);
    assert!(!r.log().iter().any(|l| l.starts_with("install")));
    assert!(matches!(r.m.state(), UpdateState::Error { stage: Stage::Wait, .. }), "UP6d");
}

#[test]
fn s5_4_6_lost_engine_after_install_is_installed() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let h = r.host(vec![ready()], vec![Ok(CommitResult::Busy(busy()))], vec![vec![Err(ClientError::Closed)]]);
    r.m.start(&h);
    assert_eq!(r.m.state(), UpdateState::Installed { version: "0.3.1".into() });
}

#[test]
fn s5_4_hold_refused_is_a_wait_error() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let h = FakeHost { log: r.log.clone(), link: Mutex::new(None), relaunch: Ok(()) };
    r.m.start(&h);
    assert_eq!(r.m.state(), UpdateState::Error { stage: Stage::Wait, reason: "engine down".into(), version: Some("0.3.1".into()), bad_signature: false });
}

#[test]
fn s5_5_5_relaunch_error() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let mut h = r.host(vec![ready()], vec![], vec![]);
    h.relaunch = Err("open -n".into());
    r.m.start(&h);
    assert!(matches!(r.m.state(), UpdateState::Error { stage: Stage::Relaunch, .. }));
}

#[test]
fn start_is_ignored_unless_available_or_installed() {
    let r = rig(Ok(None));
    let h = r.host(vec![ready()], vec![], vec![]);
    r.m.start(&h);
    assert!(r.log().is_empty());
    assert_eq!(r.m.state(), UpdateState::Idle { checked_at: None });
}

#[test]
fn s5_1_wire_shape_for_the_web() {
    let s = UpdateState::Waiting { version: "0.3.1".into(), busy: busy(), held: 2, since: Some(5), installed: true };
    assert_eq!(
        serde_json::to_value(&s).unwrap(),
        serde_json::json!({"state":"waiting","version":"0.3.1","busy":[{"projectId":"p","kind":"lane","name":"api","turnStartedAt":7}],"held":2,"since":5,"installed":true})
    );
    let e = UpdateState::Error { stage: Stage::Download, reason: "x".into(), version: Some("0.3.1".into()), bad_signature: true };
    assert_eq!(serde_json::to_value(&e).unwrap(), serde_json::json!({"state":"error","stage":"download","reason":"x","version":"0.3.1","badSignature":true}));
    assert_eq!(serde_json::to_value(UpdateState::Idle { checked_at: None }).unwrap(), serde_json::json!({"state":"idle","checkedAt":null}));
}

#[test]
fn s5_2_schedule_10s_then_every_6h() {
    assert_eq!(FIRST_CHECK, Duration::from_secs(10));
    assert_eq!(CHECK_EVERY, Duration::from_secs(6 * 3600));
}

#[test]
fn s5_3_plugin_errors_classify_signature() {
    use tauri_plugin_updater::Error as E;
    assert!(fail(E::Minisign(minisign_verify::PublicKey::from_base64("x").unwrap_err())).signature, "a package not signed by the key");
    use base64::Engine;
    assert!(fail(E::Base64(base64::engine::general_purpose::STANDARD.decode("O2-PLACEHOLDER: x").unwrap_err())).signature);
    assert!(fail(E::SignatureUtf8("x".into())).signature);
    assert!(fail(E::MissingSignedVersion).signature);
    assert!(!fail(E::Network("offline".into())).signature);
    assert!(!fail(E::ReleaseNotFound).signature);
}

#[test]
fn s7_2_config_has_the_public_endpoint_and_a_pubkey_field() {
    let c: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let u = &c["plugins"]["updater"];
    assert!(u["pubkey"].is_string(), "O2 commits the real key into this field");
    assert_eq!(u["endpoints"], serde_json::json!(["https://github.com/billphamhypertek/cc-slaves/releases/latest/download/latest.json"]));
}

#[test]
fn s4_3_cancel_while_downloading_aborts_it_and_returns_to_available_without_a_hold() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    r.up.hang.store(true, Ordering::SeqCst);
    let h = r.host(vec![ready()], vec![], vec![]);
    let m = r.m.clone();
    let t = std::thread::spawn(move || {
        until(|| m.state().name() == "downloading");
        m.cancel();
    });
    r.m.start(&h);
    t.join().unwrap();
    assert_eq!(r.log(), vec!["check", "download", "download aborted"], "UP3 Huỷ: no hold taken, so none released");
    assert_eq!(r.m.state(), available("0.3.1", false));
}

#[test]
fn s4_3_a_cancel_landing_as_the_download_ends_still_returns_to_available() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let m = r.m.clone();
    *r.up.last_chunk.lock().unwrap() = Some(Box::new(move || m.cancel()));
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert_eq!(r.log(), vec!["check", "download"], "the press after the last chunk is not lost: no hold, no install");
    assert_eq!(r.m.state(), available("0.3.1", false));
}

#[test]
fn s4_6_close_a_download_error_returns_to_available() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    *r.up.download.lock().unwrap() = Err(Fail { reason: "offline".into(), signature: false });
    r.m.start(&r.host(vec![], vec![], vec![]));
    r.m.cancel();
    assert_eq!(r.m.state(), available("0.3.1", false), "UP6 Đóng: the chip 'Bản mới 0.3.1' comes back");
}

#[test]
fn s4_6_close_a_bad_signature_error_is_available_dismissed_for_that_version() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    *r.up.download.lock().unwrap() = Err(Fail { reason: "minisign".into(), signature: true });
    r.m.start(&r.host(vec![], vec![], vec![]));
    r.m.cancel();
    assert_eq!(r.m.state(), available("0.3.1", true), "UP6b Đóng: chip gone, Settings still sees it");
    r.m.check(false);
    assert_eq!(r.m.state(), available("0.3.1", true), "stays dismissed for that version");
}

#[test]
fn s4_6_close_a_relaunch_error_is_installed() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let mut h = r.host(vec![ready()], vec![], vec![]);
    h.relaunch = Err("open -n".into());
    r.m.start(&h);
    r.m.cancel();
    assert_eq!(r.m.state(), UpdateState::Installed { version: "0.3.1".into() }, "the bundle is already on disk");
}

#[test]
fn s4_6_retry_after_a_download_error_downloads_again() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    *r.up.download.lock().unwrap() = Err(Fail { reason: "offline".into(), signature: false });
    r.m.start(&r.host(vec![], vec![], vec![]));
    *r.up.download.lock().unwrap() = Ok(b"pkg".to_vec());
    r.log.lock().unwrap().clear();
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert_eq!(r.log(), vec!["download", "hold", "event Ready", "install pkg", "commit", "relaunch 0.3.1"], "UP6 Thử lại");
}

#[test]
fn s4_6_retry_after_a_relaunch_error_skips_download_and_install() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    let mut h = r.host(vec![ready()], vec![], vec![]);
    h.relaunch = Err("open -n".into());
    r.m.start(&h);
    r.log.lock().unwrap().clear();
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert_eq!(r.log(), vec!["hold", "event Ready", "commit", "relaunch 0.3.1"]);
}

#[test]
fn retry_after_a_check_error_does_nothing() {
    let r = rig(Err("GitHub 404".into()));
    r.m.check(true);
    r.log.lock().unwrap().clear();
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert!(r.log().is_empty(), "a check error has no version to install; Settings re-checks instead");
    r.m.cancel();
    assert_eq!(r.m.state(), UpdateState::Idle { checked_at: None }, "closing a check error with nothing known is idle");
}

#[test]
fn s4_6_retry_ignores_a_huy_press_that_the_lost_engine_swallowed() {
    let r = rig(Ok(Some(rel("0.3.1"))));
    r.m.check(false);
    r.m.set(UpdateState::Waiting { version: "0.3.1".into(), busy: vec![], held: 0, since: None, installed: false });
    r.m.cancel();
    r.m.set(UpdateState::Error { stage: Stage::Wait, reason: "closed".into(), version: Some("0.3.1".into()), bad_signature: false });
    r.m.start(&r.host(vec![ready()], vec![], vec![]));
    assert_eq!(r.names().last(), Some(&"relaunching"), "UP6d Thử lại runs, the old press does not cancel it");
}
