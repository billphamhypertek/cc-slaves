//! Native macOS dialogs (§7.2 "Thao tác cực nhạy cảm cần xác nhận native", F19, F20). NSAlert, not web: a page script
//! cannot click these. Texts are pure functions so they are unit-tested; `show` is the only AppKit call.
//! Texts come from the `tauri` catalog in the PO's `ui.lang` (v2 §6A).
use crate::i18n::{tr, Lang};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    pub label: String,
    pub enabled: bool,
    /// Esc triggers this button.
    pub cancel: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    pub title: String,
    pub text: String,
    /// First button = default (Return).
    pub buttons: Vec<Button>,
    /// Some(placeholder) → a one-line text field below the text.
    pub input: Option<String>,
    pub critical: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertResult {
    pub button: usize,
    pub input: Option<String>,
}

fn b(label: &str) -> Button {
    Button { label: label.into(), enabled: true, cancel: false }
}
fn cancel(label: &str) -> Button {
    Button { label: label.into(), enabled: true, cancel: true }
}

// ---------- F20 ⌘Q ----------
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitChoice {
    Background,
    DrainAll,
    ShutdownEngine,
    Cancel,
}

/// §6.20: four buttons; "Tắt hẳn engine" only when no lane runs; remote line when remote access is on.
pub fn f20_alert(lang: Lang, running: usize, remote_on: bool) -> Alert {
    let mut text = tr(lang, "f20.text", &[]);
    if remote_on {
        text.push_str("\n\n");
        text.push_str(&tr(lang, "f20.remote", &[]));
    }
    text.push_str("\n\n");
    text.push_str(&tr(lang, "f20.help", &[]));
    let title = if running > 0 { tr(lang, "f20.titleRunning", &[("n", &running.to_string())]) } else { tr(lang, "f20.title", &[]) };
    Alert {
        title,
        text,
        buttons: vec![
            b(&tr(lang, "f20.background", &[])),
            b(&tr(lang, "f20.drain", &[])),
            Button { label: tr(lang, "f20.shutdown", &[]), enabled: running == 0, cancel: false },
            cancel(&tr(lang, "dialog.cancel", &[])),
        ],
        input: None,
        critical: false,
    }
}

pub fn f20_choice(button: usize) -> QuitChoice {
    match button {
        0 => QuitChoice::Background,
        1 => QuitChoice::DrainAll,
        2 => QuitChoice::ShutdownEngine,
        _ => QuitChoice::Cancel,
    }
}

// ---------- §7.2 confirmations ----------
/// §6.18 step 5 text.
pub fn remote_enable_alert(lang: Lang, hostname: &str) -> Alert {
    Alert {
        title: tr(lang, "remote.title", &[]),
        text: tr(lang, "remote.text", &[("hostname", hostname)]),
        buttons: vec![b(&tr(lang, "remote.confirm", &[])), cancel(&tr(lang, "dialog.cancel", &[]))],
        input: None,
        critical: true,
    }
}

/// §6.19 text; `error` re-shows the box after a malformed code.
pub fn pairing_alert(lang: Lang, device: &str, replaced: bool, error: Option<&str>) -> Alert {
    let mut text = tr(lang, "pair.text", &[]);
    if replaced {
        text.push_str("\n\n");
        text.push_str(&tr(lang, "pair.replaced", &[]));
    }
    if let Some(e) = error {
        text.push_str(&format!("\n\n{e}"));
    }
    Alert {
        title: tr(lang, "pair.title", &[("device", device)]),
        text,
        buttons: vec![b(&tr(lang, "pair.confirm", &[])), cancel(&tr(lang, "dialog.cancel", &[]))],
        input: Some(tr(lang, "pair.placeholder", &[])),
        critical: false,
    }
}

/// Spaces/dashes allowed while typing ("123 456"); result must be exactly 6 ASCII digits.
pub fn normalize_pair_code(s: &str) -> Option<String> {
    let d: String = s.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    (d.len() == 6 && d.chars().all(|c| c.is_ascii_digit())).then_some(d)
}

pub fn uninstall_alert(lang: Lang) -> Alert {
    Alert {
        title: tr(lang, "uninstall.title", &[]),
        text: tr(lang, "uninstall.text", &[]),
        buttons: vec![b(&tr(lang, "uninstall.confirm", &[])), cancel(&tr(lang, "dialog.cancel", &[]))],
        input: None,
        critical: true,
    }
}

pub fn info_alert(lang: Lang, title: &str, text: &str) -> Alert {
    Alert { title: title.into(), text: text.into(), buttons: vec![b(&tr(lang, "dialog.ok", &[]))], input: None, critical: false }
}

/// v2.6 §5.5-5 the new bundle is in place but `open -n` failed: say so, then the app quits.
pub fn reopen_alert(lang: Lang, version: &str) -> Alert {
    let v = [("version", version)];
    info_alert(lang, &tr(lang, "update.reopenTitle", &v), &tr(lang, "update.reopenText", &[]))
}

/// "Thêm project" / skill folder: the native "Choose folder" panel, run in the app (already frontmost) — the engine's
/// osascript panel had to `activate` a background process first, which measured 2.1 s before anything showed.
pub fn pick_folder_blocking<R: tauri::Runtime>(app: &tauri::AppHandle<R>, message: String) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(platform::pick_folder(&message));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

/// Shows the alert modally on the main thread and blocks the calling (non-main) thread for the answer.
pub fn show_blocking<R: tauri::Runtime>(app: &tauri::AppHandle<R>, alert: Alert) -> Result<AlertResult, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(platform::show(&alert));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Alert, AlertResult};
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSAlert, NSAlertStyle, NSApplication, NSTextField};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    pub fn show(a: &Alert) -> AlertResult {
        let mtm = MainThreadMarker::new().expect("dialogs run on the main thread");
        let app = NSApplication::sharedApplication(mtm);
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&a.title));
        alert.setInformativeText(&NSString::from_str(&a.text));
        alert.setAlertStyle(if a.critical { NSAlertStyle::Critical } else { NSAlertStyle::Warning });
        for btn in &a.buttons {
            let nb = alert.addButtonWithTitle(&NSString::from_str(&btn.label));
            nb.setEnabled(btn.enabled);
            if btn.cancel {
                nb.setKeyEquivalent(&NSString::from_str("\u{1b}"));
            }
        }
        let field = a.input.as_ref().map(|ph| {
            let f = NSTextField::initWithFrame(
                NSTextField::alloc(mtm),
                NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(240.0, 24.0)),
            );
            f.setPlaceholderString(Some(&NSString::from_str(ph)));
            alert.setAccessoryView(Some(&f));
            f
        });
        if let Some(f) = &field {
            alert.window().setInitialFirstResponder(Some(f));
        }
        let resp = alert.runModal();
        // NSAlertFirstButtonReturn = 1000, then +1 per button.
        let button = (resp - 1000).max(0) as usize;
        AlertResult { button, input: field.map(|f| f.stringValue().to_string()) }
    }

    pub fn pick_folder(message: &str) -> Option<String> {
        use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
        let mtm = MainThreadMarker::new().expect("dialogs run on the main thread");
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setAllowsMultipleSelection(false);
        panel.setCanCreateDirectories(true);
        panel.setMessage(Some(&NSString::from_str(message)));
        if panel.runModal() != NSModalResponseOK {
            return None;
        }
        panel.URL().and_then(|u| u.path()).map(|p| super::trim_dir(&p.to_string()))
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{Alert, AlertResult};
    pub fn show(a: &Alert) -> AlertResult {
        AlertResult { button: a.buttons.len().saturating_sub(1), input: None }
    }
    pub fn pick_folder(_message: &str) -> Option<String> {
        None
    }
}

/// A folder path without its trailing "/" (the root "/" stays), like the engine's `folder_pick`.
pub fn trim_dir(p: &str) -> String {
    if p.len() > 1 { p.trim_end_matches('/').to_string() } else { p.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_dir_drops_the_trailing_slash_but_keeps_root() {
        assert_eq!(trim_dir("/Users/a/repo/"), "/Users/a/repo");
        assert_eq!(trim_dir("/Users/a/repo"), "/Users/a/repo");
        assert_eq!(trim_dir("/"), "/");
    }

    #[test]
    fn f20_four_buttons_default_first_shutdown_disabled_while_lanes_run() {
        let a = f20_alert(Lang::Vi, 2, false);
        assert_eq!(a.title, "Còn 2 lane đang chạy");
        let labels: Vec<_> = a.buttons.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, ["Thoát, để chạy nền", "Dừng an toàn tất cả rồi thoát", "Tắt hẳn engine", "Huỷ"]);
        assert!(!a.buttons[2].enabled);
        assert!(a.buttons[3].cancel);
        assert!(!a.text.contains("internet"));
        assert!(f20_alert(Lang::Vi, 0, false).buttons[2].enabled);
    }

    #[test]
    fn f20_remote_on_adds_internet_line() {
        assert!(f20_alert(Lang::Vi, 1, true).text.contains("Máy vẫn truy cập được từ internet."));
    }

    #[test]
    fn f20_button_index_maps_to_choice() {
        assert_eq!(f20_choice(0), QuitChoice::Background);
        assert_eq!(f20_choice(1), QuitChoice::DrainAll);
        assert_eq!(f20_choice(2), QuitChoice::ShutdownEngine);
        assert_eq!(f20_choice(3), QuitChoice::Cancel);
        assert_eq!(f20_choice(99), QuitChoice::Cancel);
    }

    #[test]
    fn s6_18_remote_enable_text() {
        let a = remote_enable_alert(Lang::Vi, "slaves.example.vn");
        assert!(a.text.starts_with(
            "Ai qua được Cloudflare Access và đã ghép thiết bị thì điều khiển được các session Claude Code trên máy này."
        ));
        assert!(a.text.contains("slaves.example.vn"));
        assert_eq!(a.buttons[1].label, "Huỷ");
    }

    #[test]
    fn s6_19_pairing_text_and_replaced_notice() {
        let a = pairing_alert(Lang::Vi, "iPhone Safari", true, None);
        assert_eq!(a.title, "Thiết bị “iPhone Safari” xin ghép — nhập mã hiện trên điện thoại");
        assert!(a.text.contains("Yêu cầu trước đã bị thay."));
        assert!(a.input.is_some());
        assert!(!pairing_alert(Lang::Vi, "x", false, None).text.contains("bị thay"));
    }

    #[test]
    fn s6_19_pair_code_exactly_six_digits() {
        assert_eq!(normalize_pair_code("123456").as_deref(), Some("123456"));
        assert_eq!(normalize_pair_code(" 123 456 ").as_deref(), Some("123456"));
        assert_eq!(normalize_pair_code("123-456").as_deref(), Some("123456"));
        assert_eq!(normalize_pair_code("12345"), None);
        assert_eq!(normalize_pair_code("1234567"), None);
        assert_eq!(normalize_pair_code("12345a"), None);
        assert_eq!(normalize_pair_code("１２３４５６"), None, "full-width digits rejected");
    }

    #[test]
    fn s5_5_5_reopen_dialog_names_the_installed_version() {
        let vi = reopen_alert(Lang::Vi, "0.3.1");
        assert_eq!(format!("{} {}", vi.title, vi.text), "Đã cài cc-slaves 0.3.1. Mở lại cc-slaves để dùng.");
        assert_eq!(vi.buttons.iter().map(|b| b.label.as_str()).collect::<Vec<_>>(), ["OK"]);
        let en = reopen_alert(Lang::En, "0.3.1");
        assert_eq!(format!("{} {}", en.title, en.text), "cc-slaves 0.3.1 is installed. Open cc-slaves again to use it.");
    }

    #[test]
    fn s6a_f20_in_english() {
        let a = f20_alert(Lang::En, 2, true);
        assert_eq!(a.title, "2 lanes still running");
        let labels: Vec<_> = a.buttons.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, ["Quit, keep running", "Safe-stop all, then quit", "Shut down engine", "Cancel"]);
        assert!(a.text.contains("This Mac stays reachable from the internet."));
        assert!(a.text.contains("• Shut down engine"));
        assert_eq!(f20_alert(Lang::En, 0, false).title, "Quit cc-slaves?");
    }

    #[test]
    fn s6a_every_dialog_has_no_vietnamese_in_english() {
        let vi_chars = |s: &str| s.chars().any(|c| "ăâđêôơưạảãầấậẩẫằắặẳẵẹẻẽềếệểễịỉĩọỏõồốộổỗờớợởỡụủũừứựửữỳýỵỷỹàáèéìíòóùú".contains(c));
        let all = [
            f20_alert(Lang::En, 1, true),
            remote_enable_alert(Lang::En, "h.example"),
            pairing_alert(Lang::En, "d", true, None),
            uninstall_alert(Lang::En),
            info_alert(Lang::En, "t", "x"),
            reopen_alert(Lang::En, "0.3.1"),
        ];
        for a in &all {
            let texts = [a.title.as_str(), a.text.as_str()].into_iter().chain(a.buttons.iter().map(|b| b.label.as_str())).chain(a.input.as_deref());
            for t in texts {
                assert!(!vi_chars(t), "Vietnamese left in en: {t}");
                assert!(!t.contains('{'), "unfilled param in en: {t}");
            }
        }
        assert!(remote_enable_alert(Lang::En, "h.example").text.ends_with("Hostname: h.example"));
        assert_eq!(pairing_alert(Lang::En, "d", false, None).input.as_deref(), Some("6 digits"));
        assert_eq!(uninstall_alert(Lang::Vi).buttons[0].label, "Gỡ engine");
    }
}
