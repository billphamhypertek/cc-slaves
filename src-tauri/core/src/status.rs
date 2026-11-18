//! What the menu bar and the ⌘Q dialog need to know about the engine, built from `/healthz` (if it carries lanes) or
//! from the WS `snapshot` (shared/protocol.ts `Snapshot`).
use crate::i18n::{tr, Lang};
use serde_json::Value;

/// Lane states that count as "đang chạy" (F20, NC4 "chỉ khi không còn lane chạy"): a live session doing or owing work.
/// `idle` (turn finished, waiting for an order) and the terminal states do not.
pub const RUNNING_STATES: &[&str] = &["starting", "running", "waiting_po", "switching", "waiting_quota", "draining"];

pub fn is_running_state(s: &str) -> bool {
    RUNNING_STATES.contains(&s)
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunningLane {
    pub name: String,
    pub phase: Option<String>,
    /// The account email the lane runs on (snapshot only; `/healthz` does not carry it).
    pub account: Option<String>,
    /// Epoch ms the current turn started (snapshot only).
    pub turn_started_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaWindow {
    Five,
    Week,
}

/// One quota window of an account (v2.8 §4.11.2): used %, the account's stop threshold (`caps`) and the reset time.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Window {
    pub used: Option<u32>,
    pub cap: Option<u32>,
    pub resets_ms: Option<i64>,
}

/// An account's quota as the menu-bar panel shows it (snapshot `accounts[]`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccountQuota {
    pub email: String,
    pub plan: Option<String>,
    pub week: Window,
    /// `None` = no 5-hour window (Ultra, D103).
    pub five: Option<Window>,
    /// The window that made the account full, if it is.
    pub full: Option<QuotaWindow>,
    pub fetched_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Summary {
    pub version: Option<String>,
    pub started_at_ms: Option<i64>,
    pub running: Vec<RunningLane>,
    pub open_cards: usize,
    pub remote_enabled: bool,
    pub remote_host: Option<String>,
    /// Snapshot only (empty from `/healthz`).
    pub accounts: Vec<AccountQuota>,
}

fn running_lanes(lanes: &[Value]) -> Vec<RunningLane> {
    lanes
        .iter()
        .filter(|l| l.get("state").and_then(Value::as_str).is_some_and(is_running_state))
        .map(|l| RunningLane {
            name: l.get("name").and_then(Value::as_str).unwrap_or("?").to_string(),
            phase: l.get("phase").and_then(Value::as_str).map(String::from),
            account: l.get("account").and_then(Value::as_str).map(String::from),
            turn_started_ms: l.get("turnStartedAt").and_then(Value::as_i64),
        })
        .collect()
}

fn pct(v: Option<&Value>) -> Option<u32> {
    v.and_then(Value::as_f64).filter(|p| p.is_finite() && *p >= 0.0).map(|p| p.round() as u32)
}

fn account(a: &Value) -> Option<AccountQuota> {
    let num = |k: &str| a.get(k).and_then(Value::as_i64);
    // a hard cap leaves the account at cap − 1 (engine `weekLeaveAt`, web `leaveOf`)
    let hard = a.get("hard").and_then(Value::as_bool).unwrap_or(false);
    let week_cap = pct(a.get("week")).map(|c| if hard { c.saturating_sub(1) } else { c });
    let week = Window { used: pct(a.get("weekPct")), cap: week_cap, resets_ms: num("weekResetsAt") };
    let five_window = a.get("fiveWindow").and_then(Value::as_bool).unwrap_or(true);
    let five = five_window.then(|| Window { used: pct(a.get("fivePct")), cap: pct(a.get("five")), resets_ms: num("fiveResetsAt") });
    let why = a.get("fullWhy").and_then(|w| w.get("window")).and_then(Value::as_str);
    // past the reset of the window that filled it, the engine keeps `full` but the account is no longer full (v2.7.1 §4.4)
    let past_reset = a.get("pastReset").is_some_and(|p| !p.is_null());
    let full = match (a.get("full").and_then(Value::as_bool).unwrap_or(false) && !past_reset, why) {
        (false, _) => None,
        (true, Some("five")) if five.is_some() => Some(QuotaWindow::Five),
        (true, Some(_)) => Some(QuotaWindow::Week),
        // no reason sent: the window that is at 100 %, else the week
        (true, None) if five.as_ref().is_some_and(|f| f.used.is_some_and(|u| u >= 100)) => Some(QuotaWindow::Five),
        (true, None) => Some(QuotaWindow::Week),
    };
    Some(AccountQuota {
        email: a.get("email")?.as_str()?.to_string(),
        plan: a.get("plan").and_then(Value::as_str).map(String::from),
        week,
        five,
        full,
        fetched_ms: num("fetchedAt"),
    })
}

fn remote(v: Option<&Value>) -> (bool, Option<String>) {
    let enabled = v.and_then(|r| r.get("enabled")).and_then(Value::as_bool).unwrap_or(false);
    let host = v.and_then(|r| r.get("hostname")).and_then(Value::as_str).map(String::from);
    (enabled, host)
}

/// From a `{"type":"snapshot","snapshot":{…}}` message (or the inner snapshot object).
pub fn from_snapshot(msg: &Value) -> Option<Summary> {
    let snap = msg.get("snapshot").unwrap_or(msg);
    let engine = snap.get("engine")?;
    let lanes = snap.get("lanes")?.as_array()?;
    let open_cards = snap
        .get("cards")
        .and_then(Value::as_array)
        // the §5.2 new-entry question lives only in Cấu hình chung, never in Chờ PO: not counted (same rule as the web badge)
        .map(|c| {
            c.iter()
                .filter(|c| c.get("status").and_then(Value::as_str) == Some("open") && c.get("kind").and_then(Value::as_str) != Some("shared_cfg_new"))
                .count()
        })
        .unwrap_or(0);
    let (remote_enabled, remote_host) = remote(engine.get("remote"));
    Some(Summary {
        version: engine.get("version").and_then(Value::as_str).map(String::from),
        started_at_ms: engine.get("startedAt").and_then(Value::as_i64),
        running: running_lanes(lanes),
        open_cards,
        remote_enabled,
        remote_host,
        accounts: snap.get("accounts").and_then(Value::as_array).map(|a| a.iter().filter_map(account).collect()).unwrap_or_default(),
    })
}

/// `/healthz` body, only when it carries a `lanes` array (otherwise the caller falls back to the WS snapshot).
pub fn from_healthz(v: &Value) -> Option<Summary> {
    let lanes = v.get("lanes")?.as_array()?;
    let (remote_enabled, remote_host) = remote(v.get("remote"));
    Some(Summary {
        version: v.get("version").and_then(Value::as_str).map(String::from),
        started_at_ms: v.get("startedAt").and_then(Value::as_i64),
        running: running_lanes(lanes),
        open_cards: v.get("openCards").and_then(Value::as_u64).unwrap_or(0) as usize,
        remote_enabled,
        remote_host,
        accounts: vec![],
    })
}

const PHASES: &[&str] = &["queue", "spec", "code", "review", "gate", "merge", "done"];

/// A known phase in `lang` (`status.phase.*`); an unknown one is shown as sent.
pub fn phase_label(lang: Lang, p: &str) -> String {
    if PHASES.contains(&p) {
        tr(lang, &format!("status.phase.{p}"), &[])
    } else {
        p.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snap() -> Value {
        json!({"type":"snapshot","snapshot":{
            "engine":{"version":"0.1.0","startedAt":1000,"remote":{"enabled":true,"hostname":"slaves.x.vn"}},
            "lanes":[
                {"name":"D2","state":"running","phase":"code"},
                {"name":"D15","state":"waiting_po","phase":"review"},
                {"name":"D3","state":"idle","phase":"code"},
                {"name":"D4","state":"done","phase":"done"},
                {"name":"D5","state":"broken","phase":null},
                {"name":"D6","state":"draining","phase":null}
            ],
            "cards":[{"status":"open"},{"status":"answered"},{"status":"open"},{"status":"open","kind":"shared_cfg_new"}]
        }})
    }

    #[test]
    fn f20_running_counts_live_states_not_idle_or_terminal() {
        let s = from_snapshot(&snap()).unwrap();
        let names: Vec<_> = s.running.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["D2", "D15", "D6"]);
        assert_eq!(s.open_cards, 2);
        assert!(s.remote_enabled);
        assert_eq!(s.remote_host.as_deref(), Some("slaves.x.vn"));
        assert_eq!(s.version.as_deref(), Some("0.1.0"));
    }

    fn acc(extra: Value) -> Value {
        let mut a = json!({"email":"a@x-vn.test","plan":"Max","week":90,"five":80,"weekPct":31.4,"fivePct":62.6,
            "weekResetsAt":2000,"fiveResetsAt":1000,"fetchedAt":900,"full":false,"fullWhy":null,"fiveWindow":true});
        for (k, v) in extra.as_object().unwrap() {
            a[k] = v.clone();
        }
        a
    }

    fn accounts_of(list: Vec<Value>) -> Vec<AccountQuota> {
        let mut m = snap();
        m["snapshot"]["accounts"] = Value::Array(list);
        from_snapshot(&m).unwrap().accounts
    }

    #[test]
    fn v28_snapshot_lanes_carry_account_and_turn_start() {
        let mut m = snap();
        m["snapshot"]["lanes"][0]["account"] = json!("acc11@x-vn.test");
        m["snapshot"]["lanes"][0]["turnStartedAt"] = json!(1234);
        let s = from_snapshot(&m).unwrap();
        assert_eq!(s.running[0].account.as_deref(), Some("acc11@x-vn.test"));
        assert_eq!(s.running[0].turn_started_ms, Some(1234));
        assert_eq!(s.running[1].account, None);
        assert!(s.accounts.is_empty(), "no accounts array → none");
    }

    #[test]
    fn v28_account_max_has_both_windows_rounded_with_caps() {
        let a = &accounts_of(vec![acc(json!({}))])[0];
        assert_eq!(a.email, "a@x-vn.test");
        assert_eq!(a.plan.as_deref(), Some("Max"));
        assert_eq!(a.week, Window { used: Some(31), cap: Some(90), resets_ms: Some(2000) });
        assert_eq!(a.five, Some(Window { used: Some(63), cap: Some(80), resets_ms: Some(1000) }));
        assert_eq!((a.full, a.fetched_ms), (None, Some(900)));
        let mut old = acc(json!({}));
        old.as_object_mut().unwrap().remove("fiveWindow");
        assert!(accounts_of(vec![old])[0].five.is_some(), "an engine without fiveWindow means Max");
    }

    #[test]
    fn v28_account_ultra_has_no_five_hour_window() {
        let a = &accounts_of(vec![acc(json!({"fiveWindow":false,"five":null,"fivePct":null}))])[0];
        assert_eq!(a.five, None);
        assert_eq!(a.week.used, Some(31));
    }

    #[test]
    fn v28_account_full_window_from_full_why_or_the_100_pct_one() {
        let five = acc(json!({"full":true,"fullWhy":{"window":"five"}}));
        let week = acc(json!({"full":true,"fullWhy":{"window":"week"}}));
        let none_five = acc(json!({"full":true,"fivePct":100}));
        let none = acc(json!({"full":true}));
        let ultra_five = acc(json!({"full":true,"fullWhy":{"window":"five"},"fiveWindow":false}));
        let got: Vec<_> = accounts_of(vec![five, week, none_five, none, ultra_five]).iter().map(|a| a.full).collect();
        let (f, w) = (Some(QuotaWindow::Five), Some(QuotaWindow::Week));
        assert_eq!(got, [f, w, f, w, w]);
    }

    #[test]
    fn fx_past_reset_is_not_full() {
        let past = acc(json!({"full":true,"fullWhy":null,"pastReset":{"window":"week","at":1,"recheckAt":2}}));
        let still = acc(json!({"full":true,"fullWhy":null,"pastReset":null}));
        let got: Vec<_> = accounts_of(vec![past, still]).iter().map(|a| a.full).collect();
        assert_eq!(got, [None, Some(QuotaWindow::Week)]);
    }

    #[test]
    fn fx_hard_cap_ticks_where_the_engine_leaves() {
        let got = accounts_of(vec![acc(json!({"hard":true})), acc(json!({"hard":false})), acc(json!({}))]);
        let caps: Vec<_> = got.iter().map(|a| a.week.cap).collect();
        assert_eq!(caps, [Some(89), Some(90), Some(90)]);
        assert_eq!(got[0].five.as_ref().unwrap().cap, Some(80), "the 5 h cap has no hard leave");
    }

    #[test]
    fn v28_account_without_email_or_with_bad_pct_is_safe() {
        let got = accounts_of(vec![json!({"plan":"Max"}), acc(json!({"weekPct":"x","fivePct":-3}))]);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].week.used, got[0].five.as_ref().unwrap().used), (None, None));
    }

    #[test]
    fn s6a_phase_labels_both_languages_unknown_as_sent() {
        assert_eq!(phase_label(Lang::Vi, "queue"), "Hàng chờ");
        assert_eq!(phase_label(Lang::En, "queue"), "Queue");
        assert_eq!(phase_label(Lang::En, "done"), "Done");
        assert_eq!(phase_label(Lang::Vi, "done"), "Xong");
        assert_eq!(phase_label(Lang::En, "weird"), "weird");
    }

    #[test]
    fn healthz_without_lanes_means_fall_back() {
        assert_eq!(from_healthz(&json!({"ok":true})), None);
        let h = from_healthz(&json!({"version":"0.1.0","lanes":[{"name":"A","state":"running"}],"openCards":1})).unwrap();
        assert_eq!(h.running.len(), 1);
        assert_eq!(h.open_cards, 1);
        assert!(!h.remote_enabled);
    }

    #[test]
    fn snapshot_missing_parts_is_none() {
        assert_eq!(from_snapshot(&json!({"type":"snapshot","snapshot":{}})), None);
    }
}
