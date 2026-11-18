//! Origin rules: the window may show only the engine UI (http://127.0.0.1:<port>) or the bundled boot page; app commands
//! answer only that origin (defence in depth on top of the capability's `remote.urls`).
use tauri::Url;

pub fn is_app_origin(url: &Url, port: u16) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    Allow,
    /// Open in the default browser instead (http/https links in the UI).
    External,
    Block,
}

pub fn navigation(url: &Url, port: u16) -> Nav {
    if is_app_origin(url, port) || url.scheme() == "tauri" || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")) {
        Nav::Allow
    } else if url.scheme() == "https" || url.scheme() == "http" {
        Nav::External
    } else {
        Nav::Block
    }
}

/// Init script: the token exists only in memory of pages of the app origin (never written to disk).
pub fn token_script(token: Option<&str>, port: u16) -> String {
    let tok = serde_json::to_string(&token).unwrap_or_else(|_| "null".into());
    format!(
        "(function(){{if(location.origin!=={origin:?})return;Object.defineProperty(window,'__CC_TOKEN__',{{value:{tok},writable:false,configurable:false}});}})();",
        origin = format!("http://127.0.0.1:{port}")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn s7_2_only_exact_app_origin_counts() {
        assert!(is_app_origin(&u("http://127.0.0.1:47800/"), 47800));
        assert!(is_app_origin(&u("http://127.0.0.1:47800/c/12"), 47800));
        assert!(!is_app_origin(&u("http://127.0.0.1:47801/"), 47800), "tunnel port is not the app");
        assert!(!is_app_origin(&u("http://localhost:47800/"), 47800));
        assert!(!is_app_origin(&u("https://127.0.0.1:47800/"), 47800));
        assert!(!is_app_origin(&u("http://127.0.0.1:3000/"), 47800), "a lane's dev server");
    }

    #[test]
    fn navigation_keeps_window_on_app_and_sends_links_out() {
        assert_eq!(navigation(&u("http://127.0.0.1:47800/x"), 47800), Nav::Allow);
        assert_eq!(navigation(&u("tauri://localhost/index.html"), 47800), Nav::Allow);
        assert_eq!(navigation(&u("https://github.com/x"), 47800), Nav::External);
        assert_eq!(navigation(&u("http://127.0.0.1:3000/"), 47800), Nav::External);
        assert_eq!(navigation(&u("file:///etc/passwd"), 47800), Nav::Block);
        assert_eq!(navigation(&u("javascript:alert(1)"), 47800), Nav::Block);
    }

    #[test]
    fn s7_2_token_script_guards_origin_and_escapes() {
        let s = token_script(Some("ab\"c</script>"), 47800);
        assert!(s.contains("if(location.origin!==\"http://127.0.0.1:47800\")return;"));
        assert!(s.contains(r#"value:"ab\"c</script>""#));
        assert!(token_script(None, 47800).contains("value:null"));
    }
}
