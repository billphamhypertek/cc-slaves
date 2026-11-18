//! Localhost token (NC1) lives only in the Keychain item `cc-slaves-engine-token`; read it through `/usr/bin/security`.
//! Why the CLI and not the Keychain API: the engine creates the item with `/usr/bin/security add-generic-password`, so the
//! item's ACL trusts `/usr/bin/security`; reading through the same tool needs no prompt (measured S7, §3.3-21).
//! The token is returned in memory only; never logged, never written to disk.
use std::process::Command;

pub trait SecurityCli {
    /// Runs `/usr/bin/security <args>`; returns stdout on exit 0.
    fn run(&self, args: &[&str]) -> Option<String>;
}

pub struct RealSecurity;

impl SecurityCli for RealSecurity {
    fn run(&self, args: &[&str]) -> Option<String> {
        let out = Command::new("/usr/bin/security").args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

pub fn read_token(cli: &dyn SecurityCli, service: &str) -> Option<String> {
    let raw = cli.run(&["find-generic-password", "-s", service, "-w"])?;
    let t = raw.trim_end_matches(['\n', '\r']).to_string();
    (!t.is_empty()).then_some(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake(Option<&'static str>, RefCell<Vec<String>>);
    impl SecurityCli for Fake {
        fn run(&self, args: &[&str]) -> Option<String> {
            self.1.borrow_mut().push(args.join(" "));
            self.0.map(String::from)
        }
    }

    #[test]
    fn s7_1_token_read_from_keychain_service() {
        let f = Fake(Some("abc123\n"), RefCell::default());
        assert_eq!(read_token(&f, "cc-slaves-engine-token").as_deref(), Some("abc123"));
        assert_eq!(f.1.borrow()[0], "find-generic-password -s cc-slaves-engine-token -w");
    }

    #[test]
    fn missing_or_empty_token_is_none() {
        assert_eq!(read_token(&Fake(None, RefCell::default()), "x"), None);
        assert_eq!(read_token(&Fake(Some("\n"), RefCell::default()), "x"), None);
    }
}
