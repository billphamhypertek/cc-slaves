//! "Thoát hẳn" (v2.8 §4.11.5, MB6, D116, L12, L13): stop the engine, close the app, then close this icon — in that order,
//! never half-way. Pure parts the panel hosts (G6b): `confirm` (ask or not, the texts), `on_dismiss` (Esc / outside /
//! icon click cancel only before the run starts), `view` (title, 3 step lines, stuck footer). `run` is the sequencer over
//! `Launchctl` + a `Host` (app, "Thoát tiếp" button) + a `Clock`, reporting each `Progress` to whoever shows it.
use crate::model::{IconState, MenuModel};
use ccs_core::i18n::{tr, Lang};
use ccs_core::launchd::{Launchctl, BOOTOUT_WAIT, EXIT_TIMEOUT_SECS};
use std::time::Duration;

/// Countdown before carrying on by itself after a forced stop (no app left open overnight).
pub const AUTO_CONTINUE_SECS: u64 = 10;
/// How long the app gets to quit after `terminate()` (it does not ask: the engine is already off, F20 is skipped).
const APP_WAIT: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Confirm {
    pub title: String,
    pub body: String,
    pub note: String,
    /// Left button, the only one Esc / outside maps to. Neither button is the default (HIG Alerts): Enter does nothing.
    pub cancel: String,
    /// Right button, red text.
    pub go: String,
}

/// `None` = do not ask (engine off, or 0 lanes running): go straight to the run.
pub fn confirm(m: &MenuModel, lang: Lang) -> Option<Confirm> {
    let t = |k: &str, p: &[(&str, &str)]| tr(lang, k, p);
    if m.icon == IconState::Off || (m.running.is_empty() && !m.lanes_unknown) {
        return None;
    }
    let body = if m.lanes_unknown {
        t("quitAll.lanesMaybe", &[])
    } else {
        let mut names = m.running.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        if m.running.len() > 5 {
            names.push_str(", …");
        }
        t("quitAll.lanes", &[("n", &m.running.len().to_string()), ("names", &names)])
    };
    let mut note = t("quitAll.note", &[]);
    if m.remote_ring {
        note = format!("{note} {}", t("quitAll.noteRemote", &[]));
    }
    Some(Confirm { title: t("quitAll.title", &[]), body, note, cancel: t("quitAll.cancel", &[]), go: t("quitAll.go", &[]) })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Confirming,
    Quitting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dismiss {
    Esc,
    /// A click outside the panel.
    Outside,
    IconClick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reaction {
    Cancel,
    Ignore,
}

/// The panel lock: while confirming, Esc / outside / icon = Huỷ (Enter does nothing: the confirm has no default button,
/// `panel::layout`); once the run started nothing closes the panel and nothing cancels it.
pub fn on_dismiss(stage: Stage, ev: Dismiss) -> Reaction {
    match (stage, ev) {
        (Stage::Confirming, _) => Reaction::Cancel,
        (Stage::Quitting, _) => Reaction::Ignore,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepState {
    Pending,
    Running(u64),
    Done(u64),
    /// Step 2 when the app is not open.
    Skipped,
    /// Step 1 when launchd had to SIGKILL the engine after `ExitTimeOut`.
    Forced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    pub steps: [StepState; 3],
    /// Seconds left before carrying on by itself after a forced stop.
    pub stuck_left: Option<u64>,
}

pub trait Clock {
    fn now(&self) -> Duration;
    fn sleep(&self, d: Duration);
}

pub trait Host {
    /// hf-bg2: this icon is a child in the engine job's process group, which launchd ends with the job. Leave the group
    /// and ignore the engine's SIGTERM so the run outlives the engine stop it reports (measured 18/11).
    fn leave_job(&self);
    /// Asks the running cc-slaves app to quit; false when it is not open.
    fn terminate_app(&self) -> bool;
    fn app_running(&self) -> bool;
    /// Waits up to `wait` for a "Thoát tiếp" press.
    fn continue_pressed(&self, wait: Duration) -> bool;
}

/// Engine first, app second, this icon last (research §14.5). Every step is reported; the caller exits after `run`
/// returns (this icon has no job of its own: it is the engine job's child, hf-bg2).
pub fn run(lc: &dyn Launchctl, host: &dyn Host, clock: &dyn Clock, engine: &str, report: &mut dyn FnMut(&Progress)) {
    use StepState::*;
    let mut p = Progress { steps: [Running(0), Pending, Pending], stuck_left: None };
    report(&p);
    host.leave_job();
    // 1. bootout (never `stop` / `kill`: KeepAlive restarts it) → SIGTERM → Engine.stop() → wait for the job to go.
    if lc.is_loaded(engine) {
        if let Err(e) = lc.bootout(engine) {
            eprintln!("[menubar] Thoát hẳn: bootout engine: {e}");
        }
    }
    let t0 = clock.now();
    while lc.is_loaded(engine) && clock.now() - t0 <= BOOTOUT_WAIT {
        let secs = (clock.now() - t0).as_secs();
        if p.steps[0] != Running(secs) {
            p.steps[0] = Running(secs);
            report(&p);
        }
        clock.sleep(POLL);
    }
    let took = clock.now() - t0;
    if took >= Duration::from_secs(EXIT_TIMEOUT_SECS) {
        p.steps[0] = Forced;
        for left in (1..=AUTO_CONTINUE_SECS).rev() {
            p.stuck_left = Some(left);
            report(&p);
            if host.continue_pressed(Duration::from_secs(1)) {
                break;
            }
        }
        p.stuck_left = None;
    } else {
        p.steps[0] = Done(took.as_secs());
    }
    // 2. the app: engine already off, so its quit flow does not ask (F20).
    p.steps[1] = Running(0);
    report(&p);
    let t1 = clock.now();
    p.steps[1] = if host.terminate_app() {
        while host.app_running() && clock.now() - t1 < APP_WAIT {
            clock.sleep(POLL);
        }
        Done((clock.now() - t1).as_secs())
    } else {
        Skipped
    };
    // 3. this icon: the engine is gone, so nothing restarts it; the caller exits.
    p.steps[2] = Running(0);
    report(&p);
    p.steps[2] = Done(0);
    report(&p);
}

/// One step line: label + state + the detail on the right ("4 s", "bỏ qua · app đang đóng", "buộc dừng sau 30 s").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub label: String,
    pub state: StepState,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressView {
    pub title: String,
    pub lines: Vec<Line>,
    /// Stuck only: the explanation, "Tự thoát tiếp sau n s" and the "Thoát tiếp (n)" button.
    pub stuck: Option<(String, String, String)>,
}

pub fn view(p: &Progress, lang: Lang) -> ProgressView {
    let t = |k: &str, a: &[(&str, &str)]| tr(lang, k, a);
    let limit = EXIT_TIMEOUT_SECS.to_string();
    let lines = ["quitAll.step1", "quitAll.step2", "quitAll.step3"]
        .iter()
        .zip(p.steps)
        .map(|(k, state)| {
            let detail = match state {
                StepState::Pending => String::new(),
                StepState::Running(s) | StepState::Done(s) => t("quitAll.secs", &[("s", &s.to_string())]),
                StepState::Skipped => t("quitAll.skippedApp", &[]),
                StepState::Forced => t("quitAll.forced", &[("s", &limit)]),
            };
            Line { label: t(k, &[]), state, detail }
        })
        .collect();
    let stuck = p.stuck_left.map(|n| {
        let n = n.to_string();
        (t("quitAll.stuckBody", &[("s", &limit)]), t("quitAll.autoIn", &[("s", &n)]), t("quitAll.continue", &[("s", &n)]))
    });
    let title = if p.stuck_left.is_some() { t("quitAll.stuckTitle", &[]) } else { t("quitAll.running", &[]) };
    ProgressView { title, lines, stuck }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{model, Observation};
    use ccs_core::status::{RunningLane, Summary};
    use std::cell::{Cell, RefCell};
    use std::path::Path;

    const ENG: &str = "com.ccslavesmeasure.tmp.engine";

    /// One fake world: a clock, launchd jobs that leave `exit_after` after their bootout, the app, a log of calls.
    struct World {
        now: Cell<Duration>,
        log: RefCell<Vec<String>>,
        loaded: RefCell<Vec<String>>,
        gone_at: RefCell<Vec<(String, Duration)>>,
        exit_after: Duration,
        app_open: Cell<bool>,
        press_at_left: Option<u64>,
        presses_seen: Cell<u64>,
    }

    impl World {
        fn new(exit_after_secs: u64, app_open: bool) -> World {
            World {
                now: Cell::new(Duration::ZERO),
                log: RefCell::new(vec![]),
                loaded: RefCell::new(vec![ENG.into()]),
                gone_at: RefCell::new(vec![]),
                exit_after: Duration::from_secs(exit_after_secs),
                app_open: Cell::new(app_open),
                press_at_left: None,
                presses_seen: Cell::new(0),
            }
        }
        fn go(&self) -> Vec<Progress> {
            let mut seen = vec![];
            run(self, self, self, ENG, &mut |p| seen.push(*p));
            seen
        }
    }

    impl Launchctl for World {
        fn is_loaded(&self, label: &str) -> bool {
            let gone = self.gone_at.borrow().iter().any(|(l, at)| l == label && self.now.get() >= *at);
            if gone {
                self.loaded.borrow_mut().retain(|l| l != label);
            }
            self.loaded.borrow().iter().any(|l| l == label)
        }
        fn bootstrap(&self, _: &Path) -> Result<(), String> {
            unreachable!("Thoát hẳn never bootstraps")
        }
        fn bootout(&self, label: &str) -> Result<(), String> {
            self.log.borrow_mut().push(format!("bootout {label} @{}", self.now.get().as_secs()));
            self.gone_at.borrow_mut().push((label.into(), self.now.get() + self.exit_after));
            Ok(())
        }
        fn kickstart_kill(&self, _: &str) -> Result<(), String> {
            unreachable!("Thoát hẳn never kickstarts")
        }
    }

    impl Clock for World {
        fn now(&self) -> Duration {
            self.now.get()
        }
        fn sleep(&self, d: Duration) {
            self.now.set(self.now.get() + d);
        }
    }

    impl Host for World {
        fn leave_job(&self) {
            self.log.borrow_mut().push(format!("leave job @{}", self.now.get().as_secs()));
        }
        fn terminate_app(&self) -> bool {
            self.log.borrow_mut().push(format!("terminate app @{}", self.now.get().as_secs()));
            let was = self.app_open.get();
            self.app_open.set(false);
            was
        }
        fn app_running(&self) -> bool {
            self.app_open.get()
        }
        fn continue_pressed(&self, wait: Duration) -> bool {
            self.presses_seen.set(self.presses_seen.get() + 1);
            let left = AUTO_CONTINUE_SECS + 1 - self.presses_seen.get();
            if self.press_at_left == Some(left) {
                return true;
            }
            self.sleep(wait);
            false
        }
    }

    fn mm(o: Observation) -> MenuModel {
        model(&o, Lang::Vi)
    }

    fn obs(healthz: bool, running: &[&str], remote: bool, known: bool) -> Observation {
        let s = Summary {
            running: running.iter().map(|n| RunningLane { name: n.to_string(), ..Default::default() }).collect(),
            remote_enabled: remote,
            remote_host: Some("h".into()),
            ..Default::default()
        };
        Observation { engine_alive: healthz, healthz_ok: healthz, lock_age_s: None, started_ms: None, summary: known.then_some(s), summary_ms: None, now_ms: 0, tz_off_s: 0 }
    }

    #[test]
    fn v28_confirm_only_when_lanes_run_or_unknown() {
        let c = confirm(&mm(obs(true, &["D2", "B3", "D4"], false, true)), Lang::Vi).expect("3 lanes → ask");
        assert_eq!(c.title, "Thoát hẳn cc-slaves?");
        assert_eq!(c.body, "3 lane đang chạy sẽ dừng (D2, B3, D4). Mở lại app rồi bấm Tiếp tục ở project là chạy tiếp.");
        assert_eq!(c.note, "Engine sẽ tắt; cửa sổ cc-slaves và biểu tượng này cũng đóng.");
        assert_eq!((c.cancel.as_str(), c.go.as_str()), ("Huỷ", "Thoát hẳn"));
        assert_eq!(confirm(&mm(obs(true, &[], true, true)), Lang::Vi), None, "0 lanes → no question");
        assert_eq!(confirm(&mm(obs(false, &[], false, false)), Lang::Vi), None, "engine off → no question");
        let unknown = confirm(&mm(obs(true, &[], true, false)), Lang::Vi).expect("unreadable lanes → still ask");
        assert!(unknown.body.starts_with("Có thể còn lane đang chạy — chúng sẽ dừng."));
        assert!(!unknown.note.contains("Truy cập từ xa"), "remote state unknown without a summary: not claimed");
        let remote = confirm(&mm(obs(true, &["D2"], true, true)), Lang::Vi).unwrap();
        assert_eq!(remote.note, "Engine sẽ tắt; cửa sổ cc-slaves và biểu tượng này cũng đóng. Truy cập từ xa cũng tắt.");
        let silent = Observation { engine_alive: true, ..obs(false, &[], false, false) };
        assert!(confirm(&mm(silent), Lang::Vi).is_some(), "engine not answering may still run lanes → ask");
        let many = confirm(&mm(obs(true, &["a", "b", "c", "d", "e", "f"], false, true)), Lang::Vi).unwrap();
        assert!(many.body.starts_with("6 lane đang chạy sẽ dừng (a, b, c, d, e, …)."), "{}", many.body);
    }

    #[test]
    fn v28_panel_lock_cancel_only_before_start() {
        use Dismiss::*;
        for ev in [Esc, Outside, IconClick] {
            assert_eq!(on_dismiss(Stage::Confirming, ev), Reaction::Cancel, "{ev:?}");
            assert_eq!(on_dismiss(Stage::Quitting, ev), Reaction::Ignore, "{ev:?} during the run");
        }
    }

    #[test]
    fn v28_order_engine_then_app_then_icon_three_lines() {
        let w = World::new(3, true);
        let seen = w.go();
        // hf-bg2: this icon is the engine job's child — it leaves the job first, so the bootout does not end it half-way
        assert_eq!(*w.log.borrow(), vec!["leave job @0".to_string(), format!("bootout {ENG} @0"), "terminate app @3".into()]);
        let last = seen.last().unwrap();
        assert_eq!(last.steps, [StepState::Done(3), StepState::Done(0), StepState::Done(0)]);
        assert_eq!(last.stuck_left, None);
        // each step goes Running before the next one starts
        let firsts: Vec<usize> = (0..3).map(|i| seen.iter().position(|p| matches!(p.steps[i], StepState::Running(_))).unwrap()).collect();
        assert!(firsts[0] < firsts[1] && firsts[1] < firsts[2], "{firsts:?}");
        assert!(seen.iter().any(|p| p.steps[0] == StepState::Running(2)), "seconds tick on line 1");
        let v = view(last, Lang::Vi);
        assert_eq!(v.title, "Đang thoát hẳn…");
        assert_eq!(v.lines.iter().map(|l| l.label.as_str()).collect::<Vec<_>>(), ["Dừng lane và tắt engine", "Đóng cửa sổ cc-slaves", "Đóng biểu tượng này"]);
        assert_eq!(v.lines[0].detail, "3 s");
    }

    #[test]
    fn v28_app_closed_line_two_skipped() {
        let w = World::new(1, false);
        let last = *w.go().last().unwrap();
        assert_eq!(last.steps[1], StepState::Skipped);
        assert_eq!(view(&last, Lang::Vi).lines[1].detail, "bỏ qua · app đang đóng");
    }

    #[test]
    fn v28_stuck_30s_forced_then_auto_continue_after_10s() {
        let w = World::new(30, true);
        let seen = w.go();
        let stuck: Vec<u64> = seen.iter().filter_map(|p| p.stuck_left).collect();
        assert_eq!(stuck, (1..=10).rev().collect::<Vec<_>>(), "10 s countdown");
        assert!(seen.iter().filter(|p| p.stuck_left.is_some()).all(|p| p.steps[0] == StepState::Forced && p.steps[1] == StepState::Pending));
        // app terminated only after the 10 s countdown ran out
        assert_eq!(w.log.borrow()[2], "terminate app @40");
        let v = view(seen.iter().find(|p| p.stuck_left == Some(8)).unwrap(), Lang::Vi);
        assert_eq!(v.title, "Engine không dừng kịp");
        assert_eq!(v.lines[0].detail, "buộc dừng sau 30 s");
        let (body, auto, button) = v.stuck.unwrap();
        assert!(body.starts_with("launchd đã buộc dừng engine sau 30 s."));
        assert_eq!((auto.as_str(), button.as_str()), ("Tự thoát tiếp sau 8 s", "Thoát tiếp (8)"));
        assert_eq!(seen.last().unwrap().steps[2], StepState::Done(0));
    }

    #[test]
    fn v28_stuck_continue_button_goes_at_once() {
        let mut w = World::new(31, true);
        w.press_at_left = Some(9);
        let seen = w.go();
        assert_eq!(seen.iter().filter_map(|p| p.stuck_left).collect::<Vec<_>>(), vec![10, 9]);
        assert_eq!(w.log.borrow()[2], "terminate app @32");
    }

    #[test]
    fn v28_engine_never_leaves_still_closes_app_and_icon() {
        let w = World::new(3600, true);
        let last = *w.go().last().unwrap();
        assert_eq!(last.steps[0], StepState::Forced);
        assert_eq!(w.log.borrow().len(), 3, "app still closed: never half-way");
    }

    #[test]
    fn v28_engine_already_off_no_bootout_needed() {
        let w = World::new(0, false);
        w.loaded.borrow_mut().retain(|l| l != ENG);
        let last = *w.go().last().unwrap();
        assert_eq!(last.steps[0], StepState::Done(0));
        assert!(!w.log.borrow().iter().any(|l| l.contains(ENG)));
    }
    /// Real launchd on throw-away labels (never `com.ccslaves.app.*`), run by hand:
    /// `cargo test measure_real_launchd -- --ignored --nocapture` (engine cleans up 8 s after SIGTERM) and with
    /// `G6A_STUCK=1` (engine ignores SIGTERM → launchd SIGKILLs it after `ExitTimeOut`). Plists come from `plist_xml`.
    #[test]
    #[ignore]
    fn measure_real_launchd_order_on_temp_labels() {
        use ccs_core::launchd::{plist_xml, AgentSpec, RealLaunchctl};
        use std::os::unix::fs::PermissionsExt;
        let stuck = std::env::var("G6A_STUCK").is_ok();
        let dir = std::env::temp_dir().join(format!("g6a-measure-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lc = RealLaunchctl::default();
        let job = |name: &str, body: &str| {
            let prog = dir.join(format!("{name}.sh"));
            std::fs::write(&prog, format!("#!/bin/sh\n{body}\nwhile :; do sleep 1; done\n")).unwrap();
            std::fs::set_permissions(&prog, std::fs::Permissions::from_mode(0o755)).unwrap();
            let spec = AgentSpec { label: format!("com.ccslavesmeasure.tmp.g6a.{name}"), program: prog, stdout: dir.join(format!("{name}.log")), stderr: dir.join(format!("{name}.log")), env: vec![], throttle_secs: 1 };
            let plist = spec.plist_path(&dir);
            std::fs::write(&plist, plist_xml(&spec)).unwrap();
            lc.bootstrap(&plist).unwrap();
            spec.label
        };
        let engine = job("engine", if stuck { "trap '' TERM" } else { "trap 'echo term; sleep 8; echo exit; exit 0' TERM" });
        std::thread::sleep(Duration::from_secs(2));
        struct NoApp;
        impl Host for NoApp {
            fn leave_job(&self) {}
            fn terminate_app(&self) -> bool {
                false
            }
            fn app_running(&self) -> bool {
                false
            }
            fn continue_pressed(&self, wait: Duration) -> bool {
                std::thread::sleep(wait);
                false
            }
        }
        struct Wall(std::time::Instant);
        impl Clock for Wall {
            fn now(&self) -> Duration {
                self.0.elapsed()
            }
            fn sleep(&self, d: Duration) {
                std::thread::sleep(d);
            }
        }
        let wall = Wall(std::time::Instant::now());
        let mut seen = vec![];
        run(&lc, &NoApp, &wall, &engine, &mut |p| seen.push((wall.0.elapsed().as_millis(), *p)));
        let gone = !lc.is_loaded(&engine);
        for (ms, p) in seen.iter().filter(|(_, p)| p.steps[0] != StepState::Running(0) || p.steps[1] != StepState::Pending) {
            eprintln!("{ms:>6} ms  {:?}  stuck {:?}", p.steps, p.stuck_left);
        }
        eprintln!("engine log: {:?}", std::fs::read_to_string(dir.join("engine.log")).unwrap_or_default());
        let _ = lc.bootout(&engine);
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(gone, "temp job gone, not restarted");
        let first = seen.last().unwrap().1.steps[0];
        if stuck {
            assert_eq!(first, StepState::Forced);
        } else {
            assert!(matches!(first, StepState::Done(8..=9)), "{first:?}: ExitTimeOut 30 kept the 8 s cleanup");
        }
    }
}
