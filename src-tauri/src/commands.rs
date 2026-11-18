//! `invoke` commands for the engine-served UI. Every command first checks the caller's origin (§7.2); the capability
//! file already limits IPC to window `main` on http://127.0.0.1:47800.
use crate::i18n::{self, tr, Lang};
use crate::{dialogs, guard, token, update, AppState};
use ccs_core::{client, launchd, paths};
use serde::Serialize;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Manager, Runtime, State, Webview};
use tauri_plugin_notification::NotificationExt;

fn check_origin<R: Runtime>(w: &Webview<R>) -> Result<u16, String> {
    let port = w.state::<AppState>().port();
    let url = w.url().map_err(|e| e.to_string())?;
    if w.label() == "main" && guard::is_app_origin(&url, port) {
        Ok(port)
    } else {
        Err("forbidden_origin".into())
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Re-read after an engine restart (new token per start, §7.1). Memory only.
#[tauri::command]
pub async fn engine_token<R: Runtime>(webview: Webview<R>) -> Result<Option<String>, String> {
    check_origin(&webview)?;
    blocking(token).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatusView {
    up: bool,
    lanes_running: usize,
    remote_enabled: bool,
    engine_loaded: bool,
}

#[tauri::command]
pub async fn engine_status<R: Runtime>(webview: Webview<R>) -> Result<EngineStatusView, String> {
    let port = check_origin(&webview)?;
    blocking(move || {
        let lc = launchd::RealLaunchctl::default();
        let loaded = launchd::Launchctl::is_loaded(&lc, &paths::engine_label());
        match client::status(port, token().as_deref()) {
            Ok(s) => EngineStatusView { up: true, lanes_running: s.running.len(), remote_enabled: s.remote_enabled, engine_loaded: loaded },
            Err(_) => EngineStatusView { up: client::engine_up(port), lanes_running: 0, remote_enabled: false, engine_loaded: loaded },
        }
    })
    .await
}

/// NC4 "Tắt engine": refuse while lanes run (or while the engine is up but its lanes cannot be read), then bootout.
pub fn stop_engine_checked(lang: Lang, port: u16) -> Result<(), String> {
    if client::engine_up(port) {
        let s = client::status(port, token().as_deref()).map_err(|e| tr(lang, "cmd.lanesUnreadable", &[("error", &e.text(lang))]))?;
        if !s.running.is_empty() {
            return Err(tr(lang, "cmd.lanesRunning", &[("n", &s.running.len().to_string())]));
        }
    }
    launchd::stop(&launchd::RealLaunchctl::default(), &paths::engine_label())
}

#[tauri::command]
pub async fn engine_stop<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    let port = check_origin(&webview)?;
    blocking(move || stop_engine_checked(i18n::current(), port)).await?
}

/// "Gỡ engine": native confirm, same no-lanes rule, then bootout + delete the plist (the menu bar is the job's child).
#[tauri::command]
pub async fn engine_uninstall<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Result<bool, String> {
    let port = check_origin(&webview)?;
    blocking(move || {
        let lang = i18n::current();
        let r = dialogs::show_blocking(&app, dialogs::uninstall_alert(lang))?;
        if r.button != 0 {
            return Ok(false);
        }
        stop_engine_checked(lang, port)?;
        launchd::uninstall(&launchd::RealLaunchctl::default(), &[&paths::engine_label()], &paths::launch_agents_dir())?;
        Ok(true)
    })
    .await?
}

#[tauri::command]
pub async fn confirm_remote_enable<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, hostname: String) -> Result<bool, String> {
    check_origin(&webview)?;
    blocking(move || dialogs::show_blocking(&app, dialogs::remote_enable_alert(i18n::current(), &hostname)).map(|r| r.button == 0)).await?
}

/// "Thêm project" / "Thêm skill từ thư mục": the chosen folder, or None on "Huỷ". `message` is the web's catalog string.
#[tauri::command]
pub async fn pick_folder<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, message: String) -> Result<Option<String>, String> {
    check_origin(&webview)?;
    blocking(move || dialogs::pick_folder_blocking(&app, message)).await?
}

/// F19: returns the 6-digit code the PO typed, or None on "Huỷ". Malformed input re-shows the box.
#[tauri::command]
pub async fn pairing_code_entry<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, device: String, replaced: bool) -> Result<Option<String>, String> {
    check_origin(&webview)?;
    blocking(move || {
        let lang = i18n::current();
        let mut err: Option<String> = None;
        loop {
            let r = dialogs::show_blocking(&app, dialogs::pairing_alert(lang, &device, replaced, err.as_deref()))?;
            if r.button != 0 {
                return Ok(None);
            }
            match r.input.as_deref().and_then(dialogs::normalize_pair_code) {
                Some(code) => return Ok(Some(code)),
                None => err = Some(tr(lang, "pair.badCode", &[])),
            }
        }
    })
    .await?
}

/// F10 "Khởi động lại engine": `launchctl kickstart -k` (SIGTERM → the engine persists, launchd starts it again, §7.1).
/// The web then re-reads the token with `engine_token` (a new one per start).
#[tauri::command]
pub async fn engine_restart<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    check_origin(&webview)?;
    blocking(|| launchd::Launchctl::kickstart_kill(&launchd::RealLaunchctl::default(), &paths::engine_label())).await?
}

/// Bundle extensions `open` launches/installs/runs instead of showing a folder (M2).
const BUNDLE_EXTS: &[&str] = &["app", "bundle", "pkg", "mpkg", "workflow", "action", "prefpane", "appex", "xpc", "plugin", "kext", "framework", "saver", "qlgenerator", "mdimporter"];

/// Only an existing absolute directory may be opened (never a file or a bundle: `open` would launch apps/scripts).
pub fn dir_arg(lang: Lang, path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() || path.contains('\0') {
        return Err(tr(lang, "cmd.needAbsPath", &[]));
    }
    if !p.is_dir() {
        return Err(tr(lang, "cmd.noDir", &[("path", path)]));
    }
    let real = std::fs::canonicalize(p).map_err(|e| e.to_string())?;
    let ext = real.extension().map(|e| e.to_string_lossy().to_lowercase());
    if ext.is_some_and(|e| BUNDLE_EXTS.contains(&e.as_str())) {
        return Err(tr(lang, "cmd.bundle", &[("path", path)]));
    }
    Ok(real)
}

fn open_with(lang: Lang, args: &[&std::ffi::OsStr]) -> Result<(), String> {
    let st = std::process::Command::new("/usr/bin/open").args(args).status().map_err(|e| e.to_string())?;
    if st.success() { Ok(()) } else { Err(tr(lang, "cmd.openExit", &[("code", &st.code().unwrap_or(-1).to_string())])) }
}

/// F12 "Mở thư mục": the project folder in Finder.
#[tauri::command]
pub async fn open_path<R: Runtime>(webview: Webview<R>, path: String) -> Result<(), String> {
    check_origin(&webview)?;
    let lang = i18n::current();
    let dir = dir_arg(lang, &path)?;
    blocking(move || open_with(lang, &[dir.as_os_str()])).await?
}

/// v2.2 §14.5 C30 a Markdown link: only http / https / mailto (absolute, no control chars) ever reach `open`.
pub fn url_arg(url: &str) -> Result<tauri::Url, String> {
    let u = tauri::Url::parse(url).map_err(|_| "bad_url".to_string())?;
    if matches!(u.scheme(), "http" | "https" | "mailto") && !url.chars().any(char::is_control) {
        Ok(u)
    } else {
        Err("bad_url".into())
    }
}

/// v2.2 §14.5 C30 a link from the conversation opens in the system browser (WKWebView drops `window.open`), app-origin
/// links too: the app window is never navigated by a link.
#[tauri::command]
pub async fn open_url<R: Runtime>(webview: Webview<R>, url: String) -> Result<(), String> {
    check_origin(&webview)?;
    let lang = i18n::current();
    let u = url_arg(&url)?;
    blocking(move || open_with(lang, &[std::ffi::OsStr::new(u.as_str())])).await?
}

/// v2.7 §10.3 the only files `open_doc` hands to the browser.
const DOC_EXTS: &[&str] = &["html", "htm"];

fn html_ext(p: &std::path::Path) -> bool {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).is_some_and(|e| DOC_EXTS.contains(&e.as_str()))
}

/// v2.7 §10.3 a spec document the web asks to open in the browser: an absolute `.html` / `.htm` file whose real path
/// (every symlink resolved) is a `.html` / `.htm` file inside the real path of one open project root. Anything else is
/// refused: `open` on a script, an app or a file outside the projects would run or leak it.
pub fn doc_arg(path: &str, roots: &[String]) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() || path.chars().any(char::is_control) {
        return Err("bad_path".into());
    }
    if !html_ext(p) {
        return Err("not_html".into());
    }
    let real = std::fs::canonicalize(p).map_err(|_| "not_found".to_string())?;
    if !real.is_file() || !html_ext(&real) {
        return Err("not_html".into());
    }
    let inside = roots.iter().filter_map(|r| std::fs::canonicalize(r).ok()).any(|r| real.starts_with(&r));
    if inside { Ok(real) } else { Err("outside_project".into()) }
}

/// hf1117-fb why the open roots could not be read: a socket / WS failure (OS text) → the stable `engine_unreachable` code the
/// web puts in words; the other engine-call failures are already words in the UI language.
fn roots_err(e: &client::ClientError, lang: Lang) -> String {
    match e {
        client::ClientError::Io(_) => "engine_unreachable".into(),
        e => e.text(lang),
    }
}

/// v2.7 §4.10 / §10.3 a spec's `.html` (mockup, prototype) opens in the Mac's default browser as `file://`, never in the app
/// window (R32). The open project roots come from the engine, not from the web.
#[tauri::command]
pub async fn open_doc<R: Runtime>(webview: Webview<R>, path: String) -> Result<(), String> {
    let port = check_origin(&webview)?;
    let lang = i18n::current();
    blocking(move || {
        let tok = token().ok_or_else(|| "no_token".to_string())?;
        let roots = client::project_roots(port, &tok).map_err(|e| roots_err(&e, lang))?;
        let file = doc_arg(&path, &roots)?;
        open_with(lang, &[file.as_os_str()])
    })
    .await?
}

/// F8 "Mở Terminal": Terminal.app at the lane's worktree.
#[tauri::command]
pub async fn open_terminal<R: Runtime>(webview: Webview<R>, path: String) -> Result<(), String> {
    check_origin(&webview)?;
    let lang = i18n::current();
    let dir = dir_arg(lang, &path)?;
    blocking(move || open_with(lang, &["-a".as_ref(), "Terminal".as_ref(), dir.as_os_str()])).await?
}

/// §8.3: the web forwards engine `notify` events (it already applied R10 "not looking at it").
#[tauri::command]
pub async fn notify<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    title: String,
    body: String,
    card_id: Option<u64>,
    project_id: Option<String>,
    lane: Option<String>,
) -> Result<(), String> {
    check_origin(&webview)?;
    let title: String = title.chars().take(120).collect();
    let body: String = body.chars().take(400).collect();
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())?;
    if let Ok(mut m) = app.state::<AppState>().notify.lock() {
        // v2.1 §4.15 §4 remember where the click leads (project, lane, card), not only the card
        let clip = |s: String| s.chars().take(200).collect::<String>();
        m.record(Instant::now(), crate::notify::NotifyTarget { card_id, project_id: project_id.map(clip), lane: lane.map(clip) });
    }
    Ok(())
}

type Updates<'a> = State<'a, Arc<update::Machine>>;

/// v2.6 §5.1 the current state (the web reads it once, then follows the `update_state` event).
#[tauri::command]
pub fn update_state<R: Runtime>(webview: Webview<R>, m: Updates<'_>) -> Result<update::UpdateState, String> {
    check_origin(&webview)?;
    Ok(m.state())
}

/// v2.6 §4.7 "Kiểm tra cập nhật" in Settings: a manual check (shows `checking` and its error, UP7b/c).
#[tauri::command]
pub async fn update_check<R: Runtime>(webview: Webview<R>, m: Updates<'_>) -> Result<(), String> {
    check_origin(&webview)?;
    let m = m.inner().clone();
    blocking(move || m.check(true)).await
}

/// v2.6 §4.2 / §4.4b "Cập nhật" / "Khởi động lại": download → hold → install → relaunch on its own thread; returns at once.
#[tauri::command]
pub fn update_start<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, m: Updates<'_>) -> Result<(), String> {
    check_origin(&webview)?;
    update::install::spawn_start(app, m.inner().clone());
    Ok(())
}

/// v2.6 §4.4 "Huỷ chờ" (R16).
#[tauri::command]
pub fn update_cancel<R: Runtime>(webview: Webview<R>, m: Updates<'_>) -> Result<(), String> {
    check_origin(&webview)?;
    m.cancel();
    Ok(())
}

/// v2.6 §4.2 "Để sau": this version's chip stays hidden (§5.2).
#[tauri::command]
pub async fn update_dismiss<R: Runtime>(webview: Webview<R>, m: Updates<'_>) -> Result<(), String> {
    check_origin(&webview)?;
    let m = m.inner().clone();
    blocking(move || m.dismiss()).await
}

#[cfg(test)]
mod tests {
    use super::{dir_arg, doc_arg, roots_err, url_arg};
    use ccs_core::client::ClientError;
    use crate::i18n::Lang;

    /// the quoted names between `start` and the next `end` in `src`
    fn names(src: &str, start: &str, end: &str) -> Vec<String> {
        let from = src.find(start).expect(start) + start.len();
        let body = &src[from..from + src[from..].find(end).expect(end)];
        let mut v: Vec<String> = body.split(',').map(|s| s.trim().trim_matches('"').trim_start_matches("commands::").to_string()).filter(|s| !s.is_empty()).collect();
        v.sort();
        v
    }

    #[test]
    fn s10_1_every_command_is_in_build_rs_the_capability_and_the_handler() {
        let built = names(include_str!("../build.rs"), ".commands(&[", "]");
        let handled = names(include_str!("lib.rs"), "generate_handler![", "]");
        let cap: serde_json::Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let mut allowed: Vec<String> = cap["permissions"].as_array().unwrap().iter().filter_map(|p| p.as_str()?.strip_prefix("allow-")).map(|p| p.replace('-', "_")).collect();
        allowed.sort();
        for c in ["update_state", "update_check", "update_start", "update_cancel", "update_dismiss"] {
            assert!(built.contains(&c.to_string()), "{c} missing from build.rs AppManifest::commands");
        }
        assert_eq!(built, handled, "build.rs vs generate_handler!");
        assert_eq!(built, allowed, "build.rs vs capabilities/main.json allow-*");
    }

    #[test]
    fn open_only_existing_absolute_dirs() {
        let tmp = std::env::temp_dir();
        assert!(dir_arg(Lang::Vi, tmp.to_str().unwrap()).is_ok());
        assert!(dir_arg(Lang::Vi, "relative/dir").is_err());
        assert!(dir_arg(Lang::Vi, "/definitely/not/here/ccs").is_err());
        let f = tmp.join("ccs-open-file.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(dir_arg(Lang::Vi, f.to_str().unwrap()).is_err(), "a file is never opened (could launch an app)");
        let _ = std::fs::remove_file(f);
    }

    #[test]
    fn c30_open_only_http_https_mailto_urls() {
        assert!(url_arg("https://github.com/x").is_ok());
        assert!(url_arg("http://127.0.0.1:47800/c/1").is_ok(), "an app-origin link opens outside too");
        assert!(url_arg("mailto:po@x.test").is_ok());
        for bad in ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "/relative", "relative", "", "-a Calculator", "ftp://x.test/a"] {
            assert!(url_arg(bad).is_err(), "{bad}");
        }
        assert!(url_arg("https://x.test/\nb").is_err(), "a control char is refused (the parser would drop it silently)");
    }

    #[test]
    fn hf1117_fb_open_doc_never_passes_os_text() {
        let io = ClientError::Io("Connection refused (os error 61)".into());
        assert_eq!(roots_err(&io, Lang::Vi), "engine_unreachable");
        assert_eq!(roots_err(&io, Lang::En), "engine_unreachable");
        assert_eq!(roots_err(&ClientError::Timeout, Lang::En), "timed out waiting for the engine");
    }

    #[test]
    fn m2_bundles_are_never_opened() {
        assert!(dir_arg(Lang::Vi, "/System/Applications/Calculator.app").is_err(), "open would launch the app");
        assert!(dir_arg(Lang::Vi, "/System/Applications/Calculator.app/").is_err());
        let tmp = std::env::temp_dir().join(format!("ccs-m2-{}", std::process::id()));
        for name in ["X.APP", "Y.bundle", "Z.pkg", "W.workflow"] {
            let d = tmp.join(name);
            std::fs::create_dir_all(&d).unwrap();
            assert!(dir_arg(Lang::Vi, d.to_str().unwrap()).is_err(), "{name}");
        }
        let link = tmp.join("plain-link");
        let _ = std::os::unix::fs::symlink("/System/Applications/Calculator.app", &link);
        assert!(dir_arg(Lang::Vi, link.to_str().unwrap()).is_err(), "a symlink to a bundle is resolved first");
        let plain = tmp.join("plain.dir.name");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(dir_arg(Lang::Vi, plain.to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn s6a_dir_arg_errors_in_both_languages() {
        assert_eq!(dir_arg(Lang::Vi, "rel").unwrap_err(), "Cần đường dẫn tuyệt đối");
        assert_eq!(dir_arg(Lang::En, "rel").unwrap_err(), "An absolute path is required");
        assert_eq!(dir_arg(Lang::En, "/definitely/not/here/ccs").unwrap_err(), "Folder not found: /definitely/not/here/ccs");
        assert_eq!(dir_arg(Lang::Vi, "/definitely/not/here/ccs").unwrap_err(), "Không thấy thư mục /definitely/not/here/ccs");
        let calc = "/System/Applications/Calculator.app";
        assert_eq!(dir_arg(Lang::En, calc).unwrap_err(), format!("{calc} is an app bundle, not a folder"));
    }

    /// a fresh dir under the temp dir: a project root with `docs/m.html`, plus a sibling outside it
    fn doc_tree(tag: &str) -> (std::path::PathBuf, Vec<String>) {
        let base = std::env::temp_dir().join(format!("ccs-doc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("proj");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(base.join("out")).unwrap();
        std::fs::write(root.join("docs/m.html"), "<p>x</p>").unwrap();
        std::fs::write(root.join("docs/M.HTM"), "<p>x</p>").unwrap();
        std::fs::write(root.join("docs/run.command"), "echo x").unwrap();
        std::fs::write(base.join("out/o.html"), "<p>x</p>").unwrap();
        (base, vec![root.to_str().unwrap().to_string()])
    }
    fn s(p: &std::path::Path) -> &str { p.to_str().unwrap() }

    #[test]
    fn s10_3_open_doc_html_inside_an_open_project() {
        let (base, roots) = doc_tree("ok");
        assert!(doc_arg(s(&base.join("proj/docs/m.html")), &roots).is_ok());
        assert!(doc_arg(s(&base.join("proj/docs/M.HTM")), &roots).is_ok(), "the extension is case-insensitive");
        assert!(doc_arg(s(&base.join("proj/docs/../docs/m.html")), &roots).is_ok(), "`..` that stays inside is fine");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn hf1117_open_doc_root_with_spaces_vietnamese_and_a_symlink() {
        let base = std::env::temp_dir().join(format!("ccs-doc-vi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("tài liệu dự án");
        let dir = root.join("docs/specs/assets");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("2026-11-17 bản mockup.html");
        std::fs::write(&file, "<p>x</p>").unwrap();
        let link = base.join("lối tắt");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let real = std::fs::canonicalize(&file).unwrap();
        assert_eq!(doc_arg(s(&file), &[s(&root).to_string()]).unwrap(), real, "spaces + Vietnamese in the root and the file");
        assert_eq!(doc_arg(s(&file), &[s(&link).to_string()]).unwrap(), real, "the open root is a symlink");
        let via = link.join("docs/specs/assets/2026-11-17 bản mockup.html");
        assert_eq!(doc_arg(s(&via), &[s(&root).to_string()]).unwrap(), real, "the path goes through the symlinked root");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn s10_3_open_doc_refuses_other_extensions() {
        let (base, roots) = doc_tree("ext");
        assert_eq!(doc_arg(s(&base.join("proj/docs/run.command")), &roots).unwrap_err(), "not_html");
        assert_eq!(doc_arg(s(&base.join("proj/docs")), &roots).unwrap_err(), "not_html");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn s10_3_open_doc_refuses_relative_missing_and_control_chars() {
        let (base, roots) = doc_tree("rel");
        assert_eq!(doc_arg("docs/m.html", &roots).unwrap_err(), "bad_path");
        assert_eq!(doc_arg(&format!("{}/x\n.html", s(&base.join("proj/docs"))), &roots).unwrap_err(), "bad_path");
        assert_eq!(doc_arg(s(&base.join("proj/docs/gone.html")), &roots).unwrap_err(), "not_found");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn s10_3_open_doc_refuses_outside_every_open_root() {
        let (base, roots) = doc_tree("out");
        assert_eq!(doc_arg(s(&base.join("out/o.html")), &roots).unwrap_err(), "outside_project");
        assert_eq!(doc_arg(s(&base.join("proj/../out/o.html")), &roots).unwrap_err(), "outside_project", "`..` out of the root");
        assert_eq!(doc_arg(s(&base.join("proj/docs/m.html")), &[]).unwrap_err(), "outside_project", "no open project");
        let sib = vec![format!("{}x", s(&base.join("proj")))]; // `projx` is not a parent of `proj/…`
        std::fs::create_dir_all(&sib[0]).unwrap();
        assert_eq!(doc_arg(s(&base.join("proj/docs/m.html")), &sib).unwrap_err(), "outside_project", "a prefix is not a parent");
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn s10_3_open_doc_refuses_a_symlink_out() {
        let (base, roots) = doc_tree("link");
        let out_link = base.join("proj/docs/leak.html");
        std::os::unix::fs::symlink(base.join("out/o.html"), &out_link).unwrap();
        assert_eq!(doc_arg(s(&out_link), &roots).unwrap_err(), "outside_project", "a symlink inside pointing out");
        let disguised = base.join("proj/docs/fake.html");
        std::os::unix::fs::symlink(base.join("proj/docs/run.command"), &disguised).unwrap();
        assert_eq!(doc_arg(s(&disguised), &roots).unwrap_err(), "not_html", "an .html name over a script");
        let _ = std::fs::remove_dir_all(base);
    }
}
