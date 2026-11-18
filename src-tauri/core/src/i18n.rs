//! v2 §6A (D19): the app shell's and the menu-bar helper's texts (menus, native dialogs, notifications, command errors,
//! F23 status lines) in `ui.lang`. The catalog is the shared `tauri` namespace (`shared/i18n/<lang>/tauri.json`,
//! parity-tested with the web/engine catalogs), compiled in, plus `errors` for the engine's keyed error frames.
//! The language is read from `config.json` (`CC_SLAVES_HOME`) at each use, so a switch in the UI applies at the next
//! dialog; the app menu bar follows via `tick` (lib.rs `watch_lang`), the menubar helper on each refresh tick.
use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Vi,
    En,
}

const VI_JSON: &str = include_str!("../../../shared/i18n/vi/tauri.json");
const EN_JSON: &str = include_str!("../../../shared/i18n/en/tauri.json");
const VI_ERRORS: &str = include_str!("../../../shared/i18n/vi/errors.json");
const EN_ERRORS: &str = include_str!("../../../shared/i18n/en/errors.json");

fn parse(src: &str) -> HashMap<String, String> {
    serde_json::from_str(src).expect("shared/i18n/<lang>/<ns>.json is a flat string map")
}

fn errors_catalog(lang: Lang) -> &'static HashMap<String, String> {
    static VI: OnceLock<HashMap<String, String>> = OnceLock::new();
    static EN: OnceLock<HashMap<String, String>> = OnceLock::new();
    match lang {
        Lang::Vi => VI.get_or_init(|| parse(VI_ERRORS)),
        Lang::En => EN.get_or_init(|| parse(EN_ERRORS)),
    }
}

fn fill(s: &str, params: &[(&str, &str)]) -> String {
    let mut out = s.to_string();
    for (name, value) in params {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

fn catalog(lang: Lang) -> &'static HashMap<String, String> {
    static VI: OnceLock<HashMap<String, String>> = OnceLock::new();
    static EN: OnceLock<HashMap<String, String>> = OnceLock::new();
    match lang {
        Lang::Vi => VI.get_or_init(|| parse(VI_JSON)),
        Lang::En => EN.get_or_init(|| parse(EN_JSON)),
    }
}

/// `key` is the path inside the `tauri` namespace (`"menu.quit"`). Missing key → the key itself (never the Vietnamese
/// text, §6A); a missing param stays as `{name}`.
pub fn tr(lang: Lang, key: &str, params: &[(&str, &str)]) -> String {
    match catalog(lang).get(key) {
        Some(s) => fill(s, params),
        None => key.to_string(),
    }
}

/// An engine error frame's §6A `key` (`"errors.x"`, full key with namespace) in `lang`; `None` when the key is not an
/// `errors.*` key this binary knows (the caller then shows the engine's `message`).
pub fn engine_error(lang: Lang, key: &str, params: &[(&str, &str)]) -> Option<String> {
    let path = key.strip_prefix("errors.")?;
    errors_catalog(lang).get(path).map(|s| fill(s, params))
}

/// `config.json` `ui.lang`: `en` → En, anything else (missing file, bad JSON, other value) → Vi (the default, §6A).
pub fn lang_of_config(path: &Path) -> Lang {
    let v: Option<serde_json::Value> = std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok());
    match v.as_ref().and_then(|v| v.get("ui")).and_then(|u| u.get("lang")).and_then(|l| l.as_str()) {
        Some("en") => Lang::En,
        _ => Lang::Vi,
    }
}

/// The PO's current language (re-read every call: cheap, and follows a switch at once).
pub fn current() -> Lang {
    lang_of_config(&crate::paths::slaves_home().join("config.json"))
}

/// Menu-bar language tracker for `watch_lang`: reports a switch until the rebuilt menu is `applied` (a failed rebuild
/// is retried on the next tick).
#[derive(Debug)]
pub struct LangWatch {
    shown: Lang,
}

impl LangWatch {
    pub fn new(shown: Lang) -> Self {
        Self { shown }
    }
    /// `Some(now)` when the menu must be rebuilt in `now`.
    pub fn changed(&self, now: Lang) -> Option<Lang> {
        (now != self.shown).then_some(now)
    }
    pub fn applied(&mut self, lang: Lang) {
        self.shown = lang;
    }
}

/// One `watch_lang` poll: when `now` differs from what is shown, call `rebuild(now)` and mark it applied on success.
/// Returns the rebuild's result, `None` when nothing changed (no rebuild). A failed rebuild is retried next tick.
pub fn tick<E>(w: &mut LangWatch, now: Lang, rebuild: impl FnOnce(Lang) -> Result<(), E>) -> Option<Result<(), E>> {
    let lang = w.changed(now)?;
    let r = rebuild(lang);
    if r.is_ok() {
        w.applied(lang);
    }
    Some(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s6a_tr_both_languages() {
        assert_eq!(tr(Lang::Vi, "menu.quit", &[]), "Thoát cc-slaves");
        assert_eq!(tr(Lang::En, "menu.quit", &[]), "Quit cc-slaves");
    }

    #[test]
    fn s6a_tr_params_every_occurrence() {
        assert_eq!(tr(Lang::Vi, "f20.titleRunning", &[("n", "3")]), "Còn 3 lane đang chạy");
        assert_eq!(tr(Lang::En, "f20.titleRunning", &[("n", "3")]), "3 lanes still running");
        assert_eq!(tr(Lang::En, "cmd.noDir", &[("path", "/x")]), "Folder not found: /x");
    }

    #[test]
    fn s6a_tr_missing_param_stays_placeholder() {
        assert_eq!(tr(Lang::En, "cmd.noDir", &[]), "Folder not found: {path}");
    }

    #[test]
    fn s6a_tr_missing_key_returns_key_never_vietnamese() {
        assert_eq!(tr(Lang::En, "nope.missing", &[]), "nope.missing");
        assert_eq!(tr(Lang::Vi, "nope.missing", &[]), "nope.missing");
    }

    #[test]
    fn s6a_catalogs_have_the_same_keys() {
        let mut vi: Vec<_> = catalog(Lang::Vi).keys().collect();
        let mut en: Vec<_> = catalog(Lang::En).keys().collect();
        vi.sort();
        en.sort();
        assert_eq!(vi, en);
        assert!(vi.len() > 40);
    }

    #[test]
    fn s6a_lang_from_config_json_default_vi() {
        let dir = std::env::temp_dir().join(format!("ccs-i18n-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.json");
        assert_eq!(lang_of_config(&f), Lang::Vi, "missing file");
        std::fs::write(&f, r#"{"ui":{"lang":"en"}}"#).unwrap();
        assert_eq!(lang_of_config(&f), Lang::En);
        std::fs::write(&f, r#"{"ui":{"lang":"fr"}}"#).unwrap();
        assert_eq!(lang_of_config(&f), Lang::Vi);
        std::fs::write(&f, "{bad").unwrap();
        assert_eq!(lang_of_config(&f), Lang::Vi);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn s6a_tick_rebuilds_once_then_quiet() {
        let mut w = LangWatch::new(Lang::Vi);
        let mut calls = vec![];
        let mut ok = |l: Lang| -> Result<(), ()> {
            calls.push(l);
            Ok(())
        };
        assert_eq!(tick(&mut w, Lang::Vi, &mut ok), None, "no switch, no rebuild");
        assert_eq!(tick(&mut w, Lang::En, &mut ok), Some(Ok(())));
        assert_eq!(tick(&mut w, Lang::En, &mut ok), None, "applied → quiet");
        assert_eq!(tick(&mut w, Lang::En, &mut ok), None);
        assert_eq!(calls, [Lang::En], "rebuilt exactly once");
    }

    #[test]
    fn s6a_tick_failed_rebuild_retries_next_tick() {
        let mut w = LangWatch::new(Lang::Vi);
        assert_eq!(tick(&mut w, Lang::En, |_| Err("boom")), Some(Err("boom")));
        let mut n = 0;
        assert_eq!(tick(&mut w, Lang::En, |_| -> Result<(), ()> { n += 1; Ok(()) }), Some(Ok(())));
        assert_eq!(tick(&mut w, Lang::En, |_| -> Result<(), ()> { n += 1; Ok(()) }), None);
        assert_eq!(n, 1);
    }

    #[test]
    fn s6a_engine_error_key_in_both_languages() {
        let vi = engine_error(Lang::Vi, "errors.unknownCommand", &[("cmd", "x")]).unwrap();
        let en = engine_error(Lang::En, "errors.unknownCommand", &[("cmd", "x")]).unwrap();
        assert!(vi.contains('x') && en.contains('x'));
        assert_ne!(vi, en);
        assert_eq!(engine_error(Lang::En, "errors.nope", &[]), None);
        assert_eq!(engine_error(Lang::En, "cards.unknownCommand", &[]), None, "only errors.* keys");
    }

    #[test]
    fn s6a_menu_rebuilds_on_switch_until_applied() {
        let mut w = LangWatch::new(Lang::Vi);
        assert_eq!(w.changed(Lang::Vi), None, "no switch, no rebuild");
        assert_eq!(w.changed(Lang::En), Some(Lang::En));
        assert_eq!(w.changed(Lang::En), Some(Lang::En), "rebuild failed → retried next tick");
        w.applied(Lang::En);
        assert_eq!(w.changed(Lang::En), None);
        assert_eq!(w.changed(Lang::Vi), Some(Lang::Vi), "switch back");
    }
}
