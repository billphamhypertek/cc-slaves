//! cc-slaves app shell (§7, §8.3, §8.4, F20): boots the engine LaunchAgent, shows the engine-served UI with the localhost
//! token injected in memory, owns native dialogs, macOS notifications, the ⌘Q flow and self-update (v2.6).
mod agents;
mod commands;
pub mod dialogs;
mod guard;
pub use ccs_core::i18n;
mod notify;
mod theme;
pub mod update;

use ccs_core::{client, engine_info, keychain, launchd, paths};
use dialogs::QuitChoice;
use i18n::{tr, Lang};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub struct AppState {
    pub port: AtomicU16,
    pub notify: Mutex<notify::NotifyMemory>,
    quitting: AtomicBool,
}

impl AppState {
    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }
}

pub fn token() -> Option<String> {
    keychain::read_token(&keychain::RealSecurity, paths::KEYCHAIN_SERVICE)
}

#[derive(Clone, Serialize)]
struct WindowState {
    visible: bool,
    focused: bool,
}

/// §8.4: tell the web when the window is hidden/minimized/unfocused so it frees or pauses the 3D scene.
fn emit_window_state<R: Runtime>(w: &tauri::Window<R>, focused: Option<bool>) {
    let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
    let focused = focused.unwrap_or_else(|| w.is_focused().unwrap_or(false));
    let _ = w.emit_to(w.label(), "window_state", WindowState { visible, focused });
}

fn boot_status<R: Runtime>(app: &AppHandle<R>, title: &str, detail: &str, error: bool) {
    if let Some(w) = app.get_webview_window("boot") {
        let js = format!(
            "window.__setBoot&&window.__setBoot({},{},{})",
            serde_json::to_string(title).unwrap(),
            serde_json::to_string(detail).unwrap(),
            error
        );
        let _ = w.eval(&js);
    }
}

/// Background boot: install/update LaunchAgents, wait for `/healthz`, then open the UI window (F13/F10 parity).
fn boot<R: Runtime>(app: AppHandle<R>) {
    let state = app.state::<AppState>();
    let app_version = app.package_info().version.to_string();
    let ej = engine_info::read_engine_json(&paths::engine_json());
    let live = ej.as_ref().filter(|e| engine_info::pid_alive(e.pid));
    if let Some(e) = live {
        state.port.store(e.port, Ordering::Relaxed);
    }
    let res = app.path().resource_dir().ok();
    let engine_bin = agents::resolve_bin(res.as_deref(), agents::ENGINE_BIN, "CC_SLAVES_ENGINE_BIN");
    let lang = i18n::current();
    boot_status(&app, &tr(lang, "boot.starting", &[]), &tr(lang, "boot.firstRun", &[]), false);
    let lc = launchd::RealLaunchctl::default();
    let mut kicked = false;
    match &engine_bin {
        None => boot_status(&app, &tr(lang, "boot.noEngine", &[]), &tr(lang, "boot.noEngineDetail", &[]), true),
        Some(bin) => match agents::install(&lc, bin, live.map(|e| e.version.as_str()), &app_version) {
            Ok(actions) => {
                kicked = actions.contains(&launchd::Action::Kickstart);
                eprintln!("[cc-slaves] agent: {actions:?}");
            }
            Err(e) => boot_status(&app, &tr(lang, "boot.installFailed", &[]), &e, true),
        },
    }
    let started = Instant::now();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        if let Some(e) = engine_info::read_engine_json(&paths::engine_json()).filter(|e| engine_info::pid_alive(e.pid)) {
            state.port.store(e.port, Ordering::Relaxed);
            // After a kickstart the old engine may still answer for a moment: wait for the new version (≤ 20 s).
            let fresh = !kicked || !engine_info::version_mismatch(&app_version, &e.version) || started.elapsed() > Duration::from_secs(20);
            if fresh && client::engine_up(e.port) {
                break;
            }
        } else if engine_bin.is_none() && client::engine_up(state.port()) {
            break;
        }
        if attempt.is_multiple_of(4) {
            let lang = i18n::current();
            let detail = if started.elapsed() > Duration::from_secs(30) {
                tr(lang, "boot.slow", &[("secs", &started.elapsed().as_secs().to_string())])
            } else {
                tr(lang, "boot.waiting", &[("n", &(attempt / 4).to_string())])
            };
            boot_status(&app, &tr(lang, "boot.starting", &[]), &detail, false);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    open_main(&app);
}

fn open_main<R: Runtime>(app: &AppHandle<R>) {
    let port = app.state::<AppState>().port();
    let url = tauri::Url::parse(&format!("{}/", client::app_origin(port))).expect("static url");
    let tok = token();
    if tok.is_none() {
        eprintln!("[cc-slaves] Keychain item {} not found; UI will ask engine_token again", paths::KEYCHAIN_SERVICE);
    }
    let script = guard::token_script(tok.as_deref(), port);
    let (look, bg) = theme::opening(theme::read(), theme::system_dark());
    let built = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .theme(look)
        .background_color(bg)
        // v2.8 §5.3: the opening colour only covers the first paint; afterwards the title bar follows the page (§14 smoke)
        .on_page_load(|w, p| {
            if p.event() == PageLoadEvent::Finished {
                theme::follow_page(&w);
            }
        })
        .title("cc-slaves")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1024.0, 640.0)
        .initialization_script(&script)
        .on_navigation(move |u| match guard::navigation(u, port) {
            guard::Nav::Allow => true,
            guard::Nav::External => {
                let _ = std::process::Command::new("/usr/bin/open").arg(u.as_str()).spawn();
                false
            }
            guard::Nav::Block => false,
        })
        .build();
    match built {
        Ok(w) => {
            let _ = w.set_focus();
            if let Some(b) = app.get_webview_window("boot") {
                let _ = b.destroy();
            }
        }
        Err(e) => boot_status(app, &tr(i18n::current(), "boot.windowFailed", &[]), &e.to_string(), true),
    }
}

/// F20: ⌘Q / Dock "Quit". Lanes running → native dialog; otherwise quit at once (engine keeps running).
fn quit_flow<R: Runtime>(app: AppHandle<R>) {
    let state = app.state::<AppState>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let done = |exit: bool| {
        if exit {
            app.exit(0);
        } else {
            app.state::<AppState>().quitting.store(false, Ordering::SeqCst);
        }
    };
    let port = state.port();
    let tok = token();
    let summary = match client::status(port, tok.as_deref()) {
        Ok(s) => s,
        Err(_) => return done(true), // engine down or unreadable: nothing to protect
    };
    if summary.running.is_empty() {
        return done(true);
    }
    let lang = i18n::current();
    let choice = match dialogs::show_blocking(&app, dialogs::f20_alert(lang, summary.running.len(), summary.remote_enabled)) {
        Ok(r) => dialogs::f20_choice(r.button),
        Err(_) => QuitChoice::Cancel,
    };
    match choice {
        QuitChoice::Background => done(true),
        QuitChoice::Cancel => done(false),
        QuitChoice::DrainAll => {
            let r = tok
                .as_deref()
                .ok_or_else(|| tr(lang, "quit.noToken", &[]))
                .and_then(|t| client::command(port, t, serde_json::json!({"cmd":"stop_all"}), Duration::from_secs(10)).map_err(|e| e.text(lang)));
            match r {
                Ok(_) => done(true),
                Err(e) => {
                    let _ = dialogs::show_blocking(&app, dialogs::info_alert(lang, &tr(lang, "quit.drainFailed", &[]), &e));
                    done(false)
                }
            }
        }
        QuitChoice::ShutdownEngine => match commands::stop_engine_checked(lang, port) {
            Ok(()) => done(true),
            Err(e) => {
                let _ = dialogs::show_blocking(&app, dialogs::info_alert(lang, &tr(lang, "quit.shutdownFailed", &[]), &e));
                done(false)
            }
        },
    }
}

/// The menu bar in `lang` (v2 §6A). "cc-slaves" is the product name, never translated.
fn menu<R: Runtime>(app: &AppHandle<R>, lang: Lang) -> tauri::Result<Menu<R>> {
    let t = |k: &str| tr(lang, k, &[]);
    let quit = MenuItem::with_id(app, "quit", t("menu.quit"), true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "cc-slaves",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&t("menu.about")), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&t("menu.hide")))?,
            &PredefinedMenuItem::hide_others(app, Some(&t("menu.hideOthers")))?,
            &PredefinedMenuItem::show_all(app, Some(&t("menu.showAll")))?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        t("menu.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&t("menu.undo")))?,
            &PredefinedMenuItem::redo(app, Some(&t("menu.redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&t("menu.cut")))?,
            &PredefinedMenuItem::copy(app, Some(&t("menu.copy")))?,
            &PredefinedMenuItem::paste(app, Some(&t("menu.paste")))?,
            &PredefinedMenuItem::select_all(app, Some(&t("menu.selectAll")))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        t("menu.window"),
        true,
        &[&PredefinedMenuItem::minimize(app, Some(&t("menu.minimize")))?, &PredefinedMenuItem::close_window(app, Some(&t("menu.closeWindow")))?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

/// v2 §6A "switching applies at once": the engine writes `config.json` before it broadcasts `config`; poll `ui.lang`
/// once a second and rebuild the menu bar when it changes (the app is not on the engine's WS).
fn watch_lang<R: Runtime>(app: AppHandle<R>, shown: Lang) {
    let mut w = i18n::LangWatch::new(shown);
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let now = i18n::current();
        if let Some(Err(e)) = i18n::tick(&mut w, now, |l| menu(&app, l).and_then(|m| app.set_menu(m)).map(|_| ())) {
            eprintln!("[cc-slaves] menu rebuild ({now:?}) failed: {e}");
        }
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState { port: AtomicU16::new(paths::ENGINE_PORT), notify: Mutex::default(), quitting: AtomicBool::new(false) })
        .menu(|app| menu(app, i18n::current()))
        .on_menu_event(|app, ev| {
            if ev.id().as_ref() == "quit" {
                let a = app.clone();
                std::thread::spawn(move || quit_flow(a));
            }
        })
        .on_window_event(|w, ev| {
            if w.label() != "main" {
                return;
            }
            match ev {
                // §8.4: closing hides; the web gets visible=false and frees the 3D scene. Reopen from the Dock.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    theme::save_current();
                    let _ = w.hide();
                    emit_window_state(w, Some(false));
                }
                WindowEvent::Focused(f) => {
                    emit_window_state(w, Some(*f));
                    if !*f {
                        theme::save_current(); // v2.8 §5.3 the next launch opens in this theme
                    }
                    if *f {
                        let st = w.state::<AppState>();
                        let hit = st.notify.lock().map(|mut m| m.take_on_focus(Instant::now())).unwrap_or(None);
                        if let Some(target) = hit {
                            // §4.15 §4 `{ cardId, projectId?, lane? }`; older webs read only `cardId`
                            let _ = w.emit_to("main", "open_latest_card", &target);
                        }
                    }
                }
                WindowEvent::Resized(_) => emit_window_state(w, None),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::engine_token,
            commands::engine_status,
            commands::engine_stop,
            commands::engine_uninstall,
            commands::engine_restart,
            commands::open_path,
            commands::open_terminal,
            commands::open_url,
            commands::open_doc,
            commands::confirm_remote_enable,
            commands::pairing_code_entry,
            commands::pick_folder,
            commands::notify,
            commands::update_state,
            commands::update_check,
            commands::update_start,
            commands::update_cancel,
            commands::update_dismiss,
        ])
        .setup(|app| {
            let h = app.handle().clone();
            std::thread::spawn(move || boot(h));
            let h = app.handle().clone();
            let lang = i18n::current();
            std::thread::spawn(move || watch_lang(h, lang));
            // v2.6 §5.1 the update machine; `update_state` goes to the main window, the `update_*` commands drive it
            let h = app.handle().clone();
            let to = h.clone();
            let emit = move |s: &update::UpdateState| {
                let _ = to.emit_to("main", "update_state", s);
            };
            let m = Arc::new(update::Machine::new(Box::new(update::PluginUpdater::new(h)), Box::new(emit), paths::slaves_home().join("update-dismissed")));
            app.manage(m.clone());
            std::thread::spawn(move || update::run_checks(&m));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building cc-slaves");

    app.run(|app, ev| match ev {
        RunEvent::Reopen { .. } => show_main(app),
        // Dock "Quit" / Cmd-Q from outside our menu: route through F20; our own app.exit(0) has Some(code).
        RunEvent::ExitRequested { code: None, api, .. } => {
            api.prevent_exit();
            let a = app.clone();
            std::thread::spawn(move || quit_flow(a));
        }
        RunEvent::Exit => theme::save_current(),
        _ => {}
    });
}
