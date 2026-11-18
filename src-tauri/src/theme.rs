//! v2.8 §5.3 the window opens in the theme the PO picked last, with its `--bg` behind the page before the page loads (no
//! flash). The web owns the choice (`localStorage` `ccs.theme`, §5.1) and applies it with `setTheme`, which sets the app-wide
//! `NSApp.appearance` (tao `set_ns_theme`: `nil` = follow macOS). The shell copies that appearance into `<slaves home>/theme`
//! when the window loses focus, hides or the app exits, and reads it back when it builds the window. The file holds one of
//! `light` / `dark` / `system`; a missing file or anything else reads as `light`, the default (§7.3, PO 17/11 21:55).
use ccs_core::paths;
use std::path::PathBuf;
use tauri::window::Color;
use tauri::Theme;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Light,
    Dark,
    System,
}

pub fn parse(s: &str) -> Mode {
    match s.trim() {
        "dark" => Mode::Dark,
        "system" => Mode::System,
        _ => Mode::Light,
    }
}

fn word(m: Mode) -> &'static str {
    match m {
        Mode::Light => "light",
        Mode::Dark => "dark",
        Mode::System => "system",
    }
}

/// `--bg` of each block in `web/src/styles.css` (`:root` dark #05080f, `:root[data-theme=light]` #dfe6ef).
const DARK_BG: Color = Color(5, 8, 15, 255);
const LIGHT_BG: Color = Color(223, 230, 239, 255);

/// The builder's `.theme()` and `.background_color()`: a forced mode forces the window; system follows macOS as it is now.
pub fn opening(m: Mode, system_dark: bool) -> (Option<Theme>, Color) {
    match m {
        Mode::Light => (Some(Theme::Light), LIGHT_BG),
        Mode::Dark => (Some(Theme::Dark), DARK_BG),
        Mode::System => (None, if system_dark { DARK_BG } else { LIGHT_BG }),
    }
}

fn file() -> PathBuf {
    paths::slaves_home().join("theme")
}

pub fn read() -> Mode {
    std::fs::read_to_string(file()).map(|s| parse(&s)).unwrap_or(Mode::Light)
}

fn write(m: Mode) {
    if read() != m {
        if let Err(e) = std::fs::write(file(), word(m)) {
            eprintln!("[cc-slaves] theme file: {e}");
        }
    }
}

/// macOS appearance now (`AppleInterfaceStyle` = "Dark"; absent = light). Safe off the main thread.
#[cfg(target_os = "macos")]
pub fn system_dark() -> bool {
    use objc2_foundation::{ns_string, NSUserDefaults};
    NSUserDefaults::standardUserDefaults().stringForKey(ns_string!("AppleInterfaceStyle")).is_some_and(|s| s.to_string() == "Dark")
}

/// Copy the app's current appearance into the file. Main thread only (AppKit); elsewhere it does nothing.
#[cfg(target_os = "macos")]
pub fn save_current() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let Some(mtm) = MainThreadMarker::new() else { return };
    let mode = match NSApplication::sharedApplication(mtm).appearance() {
        None => Mode::System,
        Some(a) if a.name().to_string().contains("Dark") => Mode::Dark,
        Some(_) => Mode::Light,
    };
    write(mode);
}

/// Once the page has painted: hand the page's own background back to WebKit. wry pins `underPageBackgroundColor` to the
/// opening colour, and macOS draws the title bar from it (§14 smoke: after `setTheme` the bar kept the opening theme);
/// unset, WebKit takes it from the page, so it follows `data-theme`. (Resetting the window colour alone did not help.)
#[cfg(target_os = "macos")]
pub fn follow_page<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) {
    let _ = w.with_webview(|pv| {
        // SAFETY: on macOS `inner()` is the live WKWebView of this window; the closure runs on the main thread.
        if let Some(wk) = unsafe { (pv.inner() as *mut objc2::runtime::AnyObject).as_ref() } {
            let none: Option<&objc2::runtime::AnyObject> = None;
            let _: () = unsafe { objc2::msg_send![wk, setUnderPageBackgroundColor: none] };
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn follow_page<R: tauri::Runtime>(_w: &tauri::WebviewWindow<R>) {}

#[cfg(not(target_os = "macos"))]
pub fn system_dark() -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn save_current() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_takes_three_words_and_nothing_else() {
        assert_eq!(parse("light"), Mode::Light);
        assert_eq!(parse("dark\n"), Mode::Dark);
        assert_eq!(parse("system"), Mode::System);
        for junk in ["", "Dark", "auto", "System", "dark; rm -rf /"] {
            assert_eq!(parse(junk), Mode::Light, "{junk:?}");
        }
        for m in [Mode::Light, Mode::Dark, Mode::System] {
            assert_eq!(parse(word(m)), m);
        }
    }

    #[test]
    fn opening_forces_the_picked_mode_and_follows_macos_on_system() {
        assert_eq!(opening(Mode::Light, true), (Some(Theme::Light), LIGHT_BG));
        assert_eq!(opening(Mode::Dark, false), (Some(Theme::Dark), DARK_BG));
        assert_eq!(opening(Mode::System, true), (None, DARK_BG));
        assert_eq!(opening(Mode::System, false), (None, LIGHT_BG));
    }
}
