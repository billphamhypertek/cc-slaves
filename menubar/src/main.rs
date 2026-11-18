//! cc-slaves menu-bar extra (spec v1 §7.1 N8; v2.8 §4.11). A child of the engine job (hf-bg2), lives with the engine, not with the app.
//! Polls engine.json + /healthz + one WS snapshot every 10 s, every 2 s while the panel is open. Budget ≤ 30 MB RSS (§8.4).
//! Texts in `config.json` `ui.lang` (§6A), re-read on each poll: a switch shows within one tick.
//! Icon: vector template image (`icon.rs`) on the status button — macOS tints it, so nothing here reads the bar's look.
//! A click on the icon opens the monitoring panel (`panel.rs`, NSPopover), which also hosts "Thoát hẳn" (`quit.rs`):
//! the confirm and the run's progress replace the panel's content; while it runs the panel stays open (§4.11.5).
//! Panel data is read over 127.0.0.1 with the Keychain token and never leaves this Mac (§7.3: no remote path).
mod icon;
mod model;
mod panel;
mod quit;

use ccs_core::status::Summary;
use ccs_core::{client, engine_info, i18n, keychain, launchd, paths};
use model::{model, MenuModel, Observation};
use std::cell::Cell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime};
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

const POLL: Duration = Duration::from_secs(10);
/// While the panel is open its numbers refresh this often (§4.11.2).
const POLL_OPEN: Duration = Duration::from_secs(2);
/// A click on the icon this soon after the panel closed is the click that closed it (transient popover): not a reopen.
const REOPEN_GUARD: Duration = Duration::from_millis(400);
/// Same override the engine honours (`engine/src/keychain.ts` `bootToken`): a temp engine started with it never writes
/// the Keychain, so a menubar run against it reads the token from here (measurements, live smoke).
const TOKEN_OVERRIDE_ENV: &str = "CC_SLAVES_TOKEN_OVERRIDE";

enum UserEvent {
    Model(Box<MenuModel>),
    Tray(TrayIconEvent),
    Act(panel::Act),
    /// Re-render the panel (Esc in the confirm went back to it).
    Redraw,
    Closed,
    Quit(quit::Progress),
}

/// The override counts only when it is a real token (≥ 32 chars, ruling 20:58); else the Keychain is read.
fn override_token(v: Option<String>) -> Option<String> {
    v.filter(|t| t.len() >= 32)
}

fn token() -> Option<String> {
    override_token(std::env::var(TOKEN_OVERRIDE_ENV).ok())
        .or_else(|| keychain::read_token(&keychain::RealSecurity, paths::KEYCHAIN_SERVICE))
}

/// Local offset from UTC in seconds, for the panel's clock times.
fn tz_offset(now_s: i64) -> i64 {
    let t: libc::time_t = now_s as libc::time_t;
    // SAFETY: localtime_r writes into the provided struct only.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::localtime_r(&t, &mut tm) };
    if r.is_null() {
        0
    } else {
        tm.tm_gmtoff as i64
    }
}

/// One poll. `last` keeps the last good read so a silent engine still shows its old lanes (grey, MB4).
fn observe(last: &mut Option<(Summary, i64)>) -> Observation {
    let ej = engine_info::read_engine_json(&paths::engine_json());
    // engine.json is written once the engine listens; engine.lock (pid) is taken at boot, so it also covers "starting".
    let lock = paths::engine_json().with_file_name("engine.lock");
    let lock_pid = std::fs::read_to_string(&lock).ok().and_then(|s| s.trim().parse::<i32>().ok());
    let alive = ej.as_ref().map(|e| e.pid).or(lock_pid).is_some_and(engine_info::pid_alive);
    let lock_age_s = std::fs::metadata(&lock).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).map(|a| a.as_secs());
    let port = ej.as_ref().map(|e| e.port).unwrap_or(paths::ENGINE_PORT);
    let now_ms = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let health = client::healthz(port, Duration::from_millis(800)).filter(|h| h.status == 200);
    let healthz_ok = health.is_some();
    let started_ms = health.and_then(|h| h.body).and_then(|b| b.get("startedAt").and_then(serde_json::Value::as_i64));
    let live = if healthz_ok { token().and_then(|t| client::snapshot(port, &t).ok()) } else { None };
    if let Some(s) = &live {
        *last = Some((s.clone(), now_ms));
    }
    if !alive && !healthz_ok {
        *last = None;
    }
    let (summary, summary_ms) = match (healthz_ok, live) {
        (true, s) => (s.clone(), s.map(|_| now_ms)),
        (false, _) => last.clone().map_or((None, None), |(s, at)| (Some(s), Some(at))),
    };
    Observation { engine_alive: alive, healthz_ok, lock_age_s, started_ms, summary, summary_ms, now_ms, tz_off_s: tz_offset(now_ms / 1000) }
}

fn open_app() {
    let _ = std::process::Command::new("/usr/bin/open").args(["-b", paths::BUNDLE_ID]).spawn();
}

fn status_button(tray: &TrayIcon) -> Option<objc2::rc::Retained<objc2_app_kit::NSStatusBarButton>> {
    tray.ns_status_item()?.button(objc2_foundation::MainThreadMarker::new()?)
}

/// Puts the state's template image on the status button, then the lane count as the title (which also makes tray-icon
/// re-measure its click target for the new width).
fn show_icon(tray: &TrayIcon, m: &MenuModel) {
    if let Some(button) = status_button(tray) {
        button.setImage(Some(&icon::ns_image(icon::look(m.icon, m.remote_ring))));
        button.setImagePosition(objc2_app_kit::NSCellImagePosition::ImageLeft);
    }
    tray.set_title(Some(&m.title));
}

struct RealClock(Instant);

impl quit::Clock for RealClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
    fn sleep(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

struct RealHost(mpsc::Receiver<()>);

fn running_app() -> Vec<objc2::rc::Retained<objc2_app_kit::NSRunningApplication>> {
    use objc2_app_kit::NSRunningApplication;
    let list = NSRunningApplication::runningApplicationsWithBundleIdentifier(&objc2_foundation::NSString::from_str(paths::BUNDLE_ID));
    list.iter().filter(|a| !a.isTerminated()).collect()
}

impl quit::Host for RealHost {
    fn leave_job(&self) {
        // SAFETY: plain syscalls with no preconditions. setsid fails (EPERM) when already a group leader (dev run from a
        // shell): then we are not in the engine job's group anyway.
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
            libc::setsid();
        }
    }
    fn terminate_app(&self) -> bool {
        let apps = running_app();
        for a in &apps {
            a.terminate();
        }
        !apps.is_empty()
    }
    fn app_running(&self) -> bool {
        !running_app().is_empty()
    }
    fn continue_pressed(&self, wait: Duration) -> bool {
        self.0.recv_timeout(wait).is_ok()
    }
}

fn remote_off(kick: mpsc::Sender<()>) {
    std::thread::spawn(move || {
        let port = engine_info::read_engine_json(&paths::engine_json()).map(|e| e.port).unwrap_or(paths::ENGINE_PORT);
        match token() {
            Some(t) => {
                if let Err(err) = client::command(port, &t, serde_json::json!({"cmd":"remote_off"}), Duration::from_secs(10)) {
                    eprintln!("[menubar] remote_off: {err}");
                }
            }
            None => open_app(),
        }
        let _ = kick.send(());
    });
}

/// The panel's state on the main thread: what it shows and where "Thoát hẳn" is.
struct Ui {
    pop: panel::Popover,
    tray: Option<TrayIcon>,
    current: Option<MenuModel>,
    /// Shared with the popover's close hook (the lock answers synchronously).
    stage: Rc<Cell<Option<quit::Stage>>>,
    confirm: Option<quit::Confirm>,
    progress: Option<quit::Progress>,
    closed_at: Rc<Cell<Option<Instant>>>,
    open: Arc<AtomicBool>,
    kick: mpsc::Sender<()>,
    cont_tx: mpsc::Sender<()>,
    cont_rx: Option<mpsc::Receiver<()>>,
}

impl Ui {
    fn render(&self) {
        let lang = i18n::current();
        match (self.stage.get(), &self.confirm, &self.progress, &self.current) {
            (Some(quit::Stage::Quitting), _, Some(p), _) => self.pop.set(&panel::Content::Progress(&quit::view(p, lang))),
            (Some(quit::Stage::Confirming), Some(c), _, _) => self.pop.set(&panel::Content::Confirm(c)),
            (None, _, _, Some(m)) => self.pop.set(&panel::Content::Monitor(&m.panel)),
            _ => {}
        }
    }

    fn show(&self) {
        let (Some(t), Some(m)) = (&self.tray, &self.current) else { return };
        let Some(button) = status_button(t) else { return };
        self.pop.show(&button, &panel::Content::Monitor(&m.panel));
        if self.stage.get().is_some() {
            self.render();
        }
        self.open.store(true, Ordering::Relaxed);
        let _ = self.kick.send(());
    }

    fn icon_click(&mut self) {
        if self.pop.is_shown() {
            match self.stage.get().map(|s| quit::on_dismiss(s, quit::Dismiss::IconClick)) {
                // the lock: a click on the icon neither closes the running "Thoát hẳn" nor cancels it
                Some(quit::Reaction::Ignore) => {
                    if let Some(b) = self.tray.as_ref().and_then(status_button) {
                        b.highlight(true);
                    }
                }
                Some(quit::Reaction::Cancel) | None => {
                    self.stage.set(None);
                    self.pop.close();
                }
            }
        } else if self.closed_at.get().is_none_or(|t| t.elapsed() > REOPEN_GUARD) {
            self.show();
        }
    }

    fn act(&mut self, a: panel::Act, proxy: &tao::event_loop::EventLoopProxy<UserEvent>) {
        use panel::Act;
        match a {
            Act::Open => {
                open_app();
                self.pop.close();
            }
            Act::Quit if self.stage.get().is_none() => {
                let Some(m) = &self.current else { return };
                match quit::confirm(m, i18n::current()) {
                    Some(c) => {
                        self.confirm = Some(c);
                        self.stage.set(Some(quit::Stage::Confirming));
                        self.render();
                    }
                    None => self.start_quit(proxy),
                }
            }
            Act::QuitGo => self.start_quit(proxy),
            Act::Cancel => {
                self.stage.set(None);
                self.render();
            }
            Act::Continue => {
                let _ = self.cont_tx.send(());
            }
            Act::RemoteOff => remote_off(self.kick.clone()),
            Act::Quit => {}
        }
    }

    /// Engine → app → this icon (§4.11.5); from here on the panel stays open until the process ends.
    fn start_quit(&mut self, proxy: &tao::event_loop::EventLoopProxy<UserEvent>) {
        let Some(rx) = self.cont_rx.take() else { return };
        self.stage.set(Some(quit::Stage::Quitting));
        self.pop.lock();
        let qp = proxy.clone();
        std::thread::spawn(move || {
            let (lc, host, clock) = (launchd::RealLaunchctl::default(), RealHost(rx), RealClock(Instant::now()));
            quit::run(&lc, &host, &clock, &paths::engine_label(), &mut |p| {
                let _ = qp.send_event(UserEvent::Quit(*p));
            });
            std::process::exit(0);
        });
    }
}

fn main() {
    let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let proxy = event_loop.create_proxy();
    let p2 = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |e| {
        let _ = p2.send_event(UserEvent::Tray(e));
    }));

    // Poller: one thread, sleeps between polls (2 s while the panel is open); also re-polls right after an action.
    let open = Arc::new(AtomicBool::new(false));
    let (kick, kick_rx) = mpsc::channel::<()>();
    let (poll_proxy, poll_open) = (proxy.clone(), open.clone());
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            let _ = poll_proxy.send_event(UserEvent::Model(Box::new(model(&observe(&mut last), i18n::current()))));
            let _ = kick_rx.recv_timeout(if poll_open.load(Ordering::Relaxed) { POLL_OPEN } else { POLL });
        }
    });

    let (cont_tx, cont_rx) = mpsc::channel::<()>();
    let mut ui: Option<Ui> = None;
    let mut setup = Some((kick, cont_tx, cont_rx, open));

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(tao::event::StartCause::Init) => {
                let Some((kick, cont_tx, cont_rx, open)) = setup.take() else { return };
                let mtm = objc2_foundation::MainThreadMarker::new().expect("event loop runs on the main thread");
                let stage: Rc<Cell<Option<quit::Stage>>> = Rc::default();
                let closed_at: Rc<Cell<Option<Instant>>> = Rc::default();
                let (ap, cp, dp) = (proxy.clone(), proxy.clone(), proxy.clone());
                let (st, ca, op) = (stage.clone(), closed_at.clone(), open.clone());
                let hooks = panel::Hooks {
                    act: Box::new(move |a| {
                        let _ = ap.send_event(UserEvent::Act(a));
                    }),
                    // Esc / a click outside: cancels the confirm (Esc goes back to the panel), never the run (§4.11.5)
                    should_close: Box::new(move |esc| {
                        let ev = if esc { quit::Dismiss::Esc } else { quit::Dismiss::Outside };
                        match st.get().map(|s| quit::on_dismiss(s, ev)) {
                            None => true,
                            Some(quit::Reaction::Ignore) => false,
                            Some(quit::Reaction::Cancel) => {
                                st.set(None);
                                if esc {
                                    let _ = cp.send_event(UserEvent::Redraw);
                                }
                                !esc
                            }
                        }
                    }),
                    did_close: Box::new(move || {
                        ca.set(Some(Instant::now()));
                        op.store(false, Ordering::Relaxed);
                        let _ = dp.send_event(UserEvent::Closed);
                    }),
                };
                let m = model(&observe(&mut None), i18n::current());
                let tray = TrayIconBuilder::new().with_tooltip("cc-slaves").build().ok();
                if let Some(t) = &tray {
                    show_icon(t, &m);
                }
                let pop = panel::Popover::new(mtm, hooks);
                ui = Some(Ui { pop, tray, current: Some(m), stage, confirm: None, progress: None, closed_at, open, kick, cont_tx, cont_rx: Some(cont_rx) });
            }
            Event::UserEvent(e) => {
                let Some(ui) = ui.as_mut() else { return };
                match e {
                    UserEvent::Model(m) => {
                        let m = *m;
                        if ui.current.as_ref() == Some(&m) {
                            return;
                        }
                        if let Some(t) = &ui.tray {
                            show_icon(t, &m);
                        }
                        ui.current = Some(m);
                        if ui.pop.is_shown() && ui.stage.get().is_none() {
                            ui.render();
                        }
                    }
                    UserEvent::Tray(TrayIconEvent::Click { button_state: MouseButtonState::Up, .. }) => ui.icon_click(),
                    UserEvent::Tray(_) => {}
                    UserEvent::Act(a) => ui.act(a, &proxy),
                    UserEvent::Redraw => ui.render(),
                    UserEvent::Closed => ui.pop.closed(),
                    UserEvent::Quit(p) => {
                        ui.progress = Some(p);
                        if !ui.pop.is_shown() {
                            ui.show();
                        }
                        ui.render();
                    }
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::override_token;

    #[test]
    fn fx_token_override_needs_32_chars() {
        assert_eq!(override_token(None), None);
        assert_eq!(override_token(Some("a".repeat(31))), None);
        assert_eq!(override_token(Some(String::new())), None);
        assert_eq!(override_token(Some("a".repeat(32))), Some("a".repeat(32)));
    }
}
