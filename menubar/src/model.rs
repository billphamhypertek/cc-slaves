//! Pure model (v2.8 §4.11): the icon state (§4.11.1), the monitoring panel's content (§4.11.2–§4.11.3) and what
//! "Thoát hẳn" needs (§4.11.5), from what the poll observed. No AppKit here: `panel.rs` lays it out and draws it.
use ccs_core::i18n::{tr, Lang};
use ccs_core::status::{phase_label, AccountQuota, QuotaWindow, Summary, Window};

/// A silent /healthz this soon after the engine took its lock reads as "starting", later as "not responding".
const STARTING_SECS: u64 = 20;
/// The panel is a glance (L16): at most this many lane rows / accounts, then "và k … nữa".
pub const MAX_LANES: usize = 6;
pub const MAX_ACCOUNTS: usize = 5;
/// "≥ ngưỡng − 5 %" turns a bar amber.
const WARN_MARGIN: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconState {
    /// No engine (booted out / not installed): logo at α 0.65.
    Off,
    /// Engine pid alive, /healthz not answering yet, ≤ 20 s since it started: hollow ring.
    Starting,
    /// Engine answers but the lane list is unreadable (no token / snapshot failed): hollow ring, no count (MB5).
    Unknown,
    /// Engine pid alive, /healthz silent for > 20 s: dot with "!".
    Unresponsive,
    /// Engine up, no lane running: plain logo.
    Idle,
    /// Lanes running: plain logo + the count as the title.
    Busy,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub engine_alive: bool,
    pub healthz_ok: bool,
    /// Age of engine.lock (taken at boot): a silent engine this young is "starting"; shown as "· 6 s".
    pub lock_age_s: Option<u64>,
    /// `startedAt` from /healthz (epoch ms): the head's "từ 09:02" even when the lane list is unreadable (MB5).
    pub started_ms: Option<i64>,
    /// Live read when /healthz answers (None = lanes unknown). While the engine is silent: the last good read, if any.
    pub summary: Option<Summary>,
    /// When `summary` was read (epoch ms).
    pub summary_ms: Option<i64>,
    pub now_ms: i64,
    /// Local time offset from UTC in seconds (`tm_gmtoff`), for "16:10" / "T2 08:00" / "dd/mm HH:MM".
    pub tz_off_s: i64,
}

/// Colour roles; `panel.rs` maps them to AppKit system colours (§4.11.2: labelColor, secondaryLabelColor, systemGreen …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Normal,
    Ok,
    Warn,
    Bad,
    Grey,
}

/// The mark in front of the engine line: a dot, a hollow ring (off) or a spinner (starting).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Dot(Tone),
    Ring,
    Spin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub mark: Mark,
    pub text: String,
    /// "từ 09:02" / "6 s" / "48 s · dữ liệu từ 14:31"; empty when nothing is known.
    pub detail: String,
    /// "Engine không phản hồi" is drawn in the warn colour.
    pub warn: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneRow {
    pub name: String,
    pub phase: String,
    /// The account's part before "@".
    pub account: String,
    /// Time in the current turn ("12 phút"); empty when unknown.
    pub took: String,
    /// The engine stopped answering: old data, grey dot (MB4).
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lanes {
    List { head: String, right: Option<String>, rows: Vec<LaneRow>, empty: Option<String>, more: Option<String>, waiting: Option<String> },
    /// No token / snapshot failed (MB5 right).
    Unknown { head: String, text: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bar {
    pub label: String,
    pub used: Option<u32>,
    /// The account's stop threshold (`caps`), drawn as a tick.
    pub cap: Option<u32>,
    pub tone: Tone,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub email: String,
    pub plan: String,
    /// Max: "5g" + "tuần"; Ultra: "tuần" only (D103).
    pub bars: Vec<Bar>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quota {
    pub head: String,
    pub right: String,
    pub accounts: Vec<Account>,
    pub more: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub on: bool,
    pub text: String,
    pub host: String,
    /// "Tắt truy cập" (only when on, from a live read).
    pub button: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Panel {
    pub head: Head,
    pub lanes: Option<Lanes>,
    pub quota: Option<Quota>,
    pub remote: Option<Remote>,
    /// Footer: "Thoát hẳn…" (left, red text) · "Mở cc-slaves" (right, default button).
    pub quit: String,
    pub open: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MenuModel {
    pub icon: IconState,
    /// Remote access on → top-right dot on the icon; "Thoát hẳn" says remote access goes off too.
    pub remote_ring: bool,
    /// Lane count next to the icon ("2"), empty when none.
    pub title: String,
    /// Names of the running lanes (read from a live engine only) — the "Thoát hẳn" confirm lists them.
    pub running: Vec<String>,
    /// Engine up (or silent) but the lane list could not be read: "Thoát hẳn" still asks (§4.11.5).
    pub lanes_unknown: bool,
    pub panel: Panel,
}

fn local(ms: i64, off: i64) -> (i64, i64) {
    let s = ms.div_euclid(1000) + off;
    (s.div_euclid(86_400), s.rem_euclid(86_400))
}

/// (month, day) of a day count since 1970-01-01 (H. Hinnant's civil_from_days).
fn month_day(days: i64) -> (i64, i64) {
    let z = days + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (m, doy - (153 * mp + 2) / 5 + 1)
}

/// One time style (§4.11.2): today "16:10"; within the next 7 days weekday + time "T2 08:00"; else "dd/mm HH:MM".
pub fn when(at_ms: i64, now_ms: i64, tz_off_s: i64, lang: Lang) -> String {
    let ((d, s), (today, _)) = (local(at_ms, tz_off_s), local(now_ms, tz_off_s));
    let hm = format!("{:02}:{:02}", s / 3600, s % 3600 / 60);
    if d == today {
        return hm;
    }
    if d > today && d - today < 7 {
        let names = tr(lang, "menubar.weekdays", &[]);
        // 1970-01-01 was a Thursday (index 4, Sunday = 0)
        let wd = names.split(',').nth((d + 4).rem_euclid(7) as usize).unwrap_or("?").to_string();
        return format!("{wd} {hm}");
    }
    let (m, day) = month_day(d);
    format!("{day:02}/{m:02} {hm}")
}

/// "45 s" / "12 phút" / "2 g 05".
pub fn dur(secs: u64, lang: Lang) -> String {
    match secs {
        0..=59 => tr(lang, "menubar.durS", &[("n", &secs.to_string())]),
        60..=3599 => tr(lang, "menubar.durM", &[("n", &(secs / 60).to_string())]),
        _ => tr(lang, "menubar.durH", &[("h", &(secs / 3600).to_string()), ("m", &format!("{:02}", secs % 3600 / 60))]),
    }
}

fn icon_state(o: &Observation) -> IconState {
    match (o.engine_alive, o.healthz_ok, &o.summary) {
        (_, true, Some(s)) if !s.running.is_empty() => IconState::Busy,
        (_, true, Some(_)) => IconState::Idle,
        (_, true, None) => IconState::Unknown,
        (true, false, _) if o.lock_age_s.is_some_and(|a| a <= STARTING_SECS) => IconState::Starting,
        (true, false, _) => IconState::Unresponsive,
        _ => IconState::Off,
    }
}

pub fn model(o: &Observation, lang: Lang) -> MenuModel {
    let icon = icon_state(o);
    let live = o.summary.as_ref().filter(|_| o.healthz_ok);
    let running: Vec<String> = live.map(|s| s.running.iter().map(|l| l.name.clone()).collect()).unwrap_or_default();
    let remote_on = live.is_some_and(|s| s.remote_enabled);
    MenuModel {
        icon,
        remote_ring: remote_on,
        title: if running.is_empty() { String::new() } else { running.len().to_string() },
        lanes_unknown: icon != IconState::Off && live.is_none(),
        running,
        panel: panel(o, icon, lang),
    }
}

struct Ctx<'a> {
    o: &'a Observation,
    lang: Lang,
}

impl Ctx<'_> {
    fn t(&self, k: &str, p: &[(&str, &str)]) -> String {
        tr(self.lang, k, p)
    }
    fn when(&self, ms: i64) -> String {
        when(ms, self.o.now_ms, self.o.tz_off_s, self.lang)
    }
    fn ago_s(&self, ms: i64) -> u64 {
        u64::try_from((self.o.now_ms - ms) / 1000).unwrap_or(0)
    }
}

fn panel(o: &Observation, icon: IconState, lang: Lang) -> Panel {
    let c = Ctx { o, lang };
    let since = o.started_ms.or_else(|| o.summary.as_ref().and_then(|s| s.started_at_ms)).map(|ms| c.t("menubar.since", &[("t", &c.when(ms))])).unwrap_or_default();
    let head = |mark, key: &str, detail: String, note: Option<&str>| Head {
        mark,
        text: c.t(key, &[]),
        detail,
        warn: icon == IconState::Unresponsive,
        note: note.map(|k| c.t(k, &[])),
    };
    let remote_off = || Remote { on: false, text: c.t("menubar.remoteOff", &[]), host: String::new(), button: None };
    let mut p = Panel {
        head: head(Mark::Dot(Tone::Ok), "menubar.engineRunning", since, None),
        lanes: None,
        quota: None,
        remote: None,
        quit: c.t("menubar.quit", &[]),
        open: c.t("menubar.open", &[]),
    };
    match icon {
        IconState::Off => p.head = head(Mark::Ring, "menubar.engineOff", String::new(), Some("menubar.offNote")),
        IconState::Starting => {
            let age = o.lock_age_s.map(|a| dur(a, lang)).unwrap_or_default();
            p.head = head(Mark::Spin, "menubar.engineStarting", age, Some("menubar.startingNote"));
        }
        IconState::Unresponsive => {
            let stale = o.summary.as_ref().zip(o.summary_ms);
            let detail = stale.map(|(_, ms)| [dur(c.ago_s(ms), lang), c.t("menubar.dataFrom", &[("t", &c.when(ms))])].join(" · "));
            p.head = head(Mark::Dot(Tone::Warn), "menubar.engineUnresponsive", detail.unwrap_or_default(), Some("menubar.unresponsiveNote"));
            if let Some((s, ms)) = stale {
                p.lanes = Some(lanes(&c, s, true));
                p.quota = quota(&c, s, c.t("menubar.since", &[("t", &c.when(ms))]));
                p.remote = Some(remote_off());
            }
        }
        IconState::Unknown => {
            p.lanes = Some(Lanes::Unknown { head: c.t("menubar.lanesUnknownHead", &[]), text: c.t("menubar.lanesUnknown", &[]) });
            p.remote = Some(remote_off());
        }
        IconState::Idle | IconState::Busy => {
            let s = o.summary.as_ref().expect("Idle / Busy come from a live summary");
            p.lanes = Some(lanes(&c, s, false));
            let fetched = s.accounts.iter().filter_map(|a| a.fetched_ms).max();
            p.quota = quota(&c, s, fetched.map(|ms| c.t("menubar.updated", &[("t", &c.when(ms))])).unwrap_or_default());
            p.remote = Some(if s.remote_enabled {
                let host = s.remote_host.clone().unwrap_or_default();
                Remote { on: true, text: c.t("menubar.remoteOn", &[]), host, button: Some(c.t("menubar.remoteTurnOff", &[])) }
            } else {
                remote_off()
            });
        }
    }
    p
}

/// Longest-running first (oldest turn start; unknown last), at most `MAX_LANES` rows + "và k lane nữa".
fn lanes(c: &Ctx, s: &Summary, stale: bool) -> Lanes {
    let mut sorted: Vec<_> = s.running.iter().collect();
    sorted.sort_by_key(|l| l.turn_started_ms.unwrap_or(i64::MAX));
    let rows = sorted
        .iter()
        .take(MAX_LANES)
        .map(|l| LaneRow {
            name: l.name.clone(),
            phase: l.phase.as_deref().map(|p| phase_label(c.lang, p)).unwrap_or_default(),
            account: l.account.as_deref().map(|a| a.split('@').next().unwrap_or(a).to_string()).unwrap_or_default(),
            took: l.turn_started_ms.map(|ms| dur(c.ago_s(ms), c.lang)).unwrap_or_default(),
            stale,
        })
        .collect::<Vec<_>>();
    let n = s.running.len();
    Lanes::List {
        head: c.t("menubar.lanesHead", &[("n", &n.to_string())]),
        right: (n > 0).then(|| c.t("menubar.turnHead", &[])),
        rows,
        empty: (n == 0).then(|| c.t("menubar.noLanes", &[])),
        more: (n > MAX_LANES).then(|| c.t("menubar.moreLanes", &[("n", &(n - MAX_LANES).to_string())])),
        waiting: (s.open_cards > 0).then(|| c.t("menubar.waiting", &[("n", &s.open_cards.to_string())])),
    }
}

fn bar(c: &Ctx, label: &str, w: &Window, full: bool) -> Bar {
    let at = w.resets_ms.map(|ms| c.when(ms));
    let (tone, text) = match (full, w.used) {
        (true, _) => (Tone::Bad, at.map(|t| c.t("menubar.fullAt", &[("t", &t)])).unwrap_or_else(|| c.t("menubar.full", &[]))),
        (false, None) => (Tone::Normal, "—".to_string()),
        (false, Some(u)) => {
            let tone = if w.cap.is_some_and(|cap| u + WARN_MARGIN >= cap) { Tone::Warn } else { Tone::Normal };
            let n = u.to_string();
            (tone, at.map(|t| c.t("menubar.pctAt", &[("n", &n), ("t", &t)])).unwrap_or_else(|| c.t("menubar.pct", &[("n", &n)])))
        }
    };
    Bar { label: c.t(label, &[]), used: if full { Some(100) } else { w.used }, cap: w.cap, tone, text }
}

/// Fullest first: a full account, then the highest % of any of its windows (no numbers last).
fn fullness(a: &AccountQuota) -> i64 {
    if a.full.is_some() {
        return 1000;
    }
    a.five.iter().chain([&a.week]).filter_map(|w| w.used).max().map_or(-1, i64::from)
}

fn quota(c: &Ctx, s: &Summary, right: String) -> Option<Quota> {
    if s.accounts.is_empty() {
        return None;
    }
    let mut sorted: Vec<&AccountQuota> = s.accounts.iter().collect();
    sorted.sort_by_key(|a| std::cmp::Reverse(fullness(a)));
    let accounts = sorted
        .iter()
        .take(MAX_ACCOUNTS)
        .map(|a| {
            let mut bars = vec![];
            if let Some(f) = &a.five {
                bars.push(bar(c, "menubar.five", f, a.full == Some(QuotaWindow::Five)));
            }
            bars.push(bar(c, "menubar.week", &a.week, a.full == Some(QuotaWindow::Week)));
            Account { email: a.email.clone(), plan: a.plan.clone().unwrap_or_default(), bars }
        })
        .collect();
    let n = s.accounts.len();
    Some(Quota {
        head: c.t("menubar.quota", &[]),
        right,
        accounts,
        more: (n > MAX_ACCOUNTS).then(|| c.t("menubar.moreAccounts", &[("n", &(n - MAX_ACCOUNTS).to_string())])),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccs_core::status::RunningLane;

    /// 2026-11-17 14:32 in Vietnam (UTC+7), a Tuesday.
    const NOW: i64 = 1_794_900_720_000;
    const VN: i64 = 7 * 3600;
    const MIN: i64 = 60_000;

    fn at(day: i64, h: i64, m: i64) -> i64 {
        // local midnight of 17/11 + day offset
        NOW - (14 * 60 + 32) * MIN + day * 86_400_000 + (h * 60 + m) * MIN
    }
    fn obs(alive: bool, ok: bool, s: Option<Summary>) -> Observation {
        Observation { engine_alive: alive, healthz_ok: ok, lock_age_s: Some(600), started_ms: None, summary_ms: s.as_ref().map(|_| NOW), summary: s, now_ms: NOW, tz_off_s: VN }
    }
    fn lane(name: &str, acc: &str, mins_ago: i64) -> RunningLane {
        RunningLane { name: name.into(), phase: Some("code".into()), account: Some(format!("{acc}@example.org")), turn_started_ms: Some(NOW - mins_ago * MIN) }
    }
    fn win(used: u32, cap: u32, resets: i64) -> Window {
        Window { used: Some(used), cap: Some(cap), resets_ms: Some(resets) }
    }
    fn max(email: &str, five: u32, week: u32) -> AccountQuota {
        AccountQuota { email: email.into(), plan: Some("Max".into()), week: win(week, 95, at(6, 8, 0)), five: Some(win(five, 80, at(0, 16, 10))), full: None, fetched_ms: Some(at(0, 14, 32)) }
    }
    fn ultra(email: &str, week: u32) -> AccountQuota {
        AccountQuota { email: email.into(), plan: Some("Ultra".into()), week: win(week, 95, at(1, 10, 0)), five: None, full: None, fetched_ms: Some(at(0, 14, 30)) }
    }
    fn busy() -> Summary {
        Summary {
            started_at_ms: Some(at(0, 9, 2)),
            running: vec![lane("D2", "acc11", 12), lane("B3", "acc03", 3), lane("D4", "acc05", 41)],
            open_cards: 2,
            accounts: vec![max("acc11@example.org", 62, 31), ultra("acc05@example.org", 54)],
            ..Default::default()
        }
    }
    type ListParts<'a> = (&'a str, Option<&'a String>, &'a Vec<LaneRow>, Option<&'a String>, Option<&'a String>, Option<&'a String>);
    fn list(p: &Panel) -> ListParts<'_> {
        match p.lanes.as_ref().unwrap() {
            Lanes::List { head, right, rows, empty, more, waiting } => (head, right.as_ref(), rows, empty.as_ref(), more.as_ref(), waiting.as_ref()),
            Lanes::Unknown { .. } => panic!("unknown"),
        }
    }

    #[test]
    fn v28_mb2_busy_panel_head_lanes_quota_remote_footer() {
        let m = model(&obs(true, true, Some(busy())), Lang::Vi);
        assert_eq!((m.icon, m.title.as_str(), m.remote_ring, m.lanes_unknown), (IconState::Busy, "3", false, false));
        let p = &m.panel;
        assert_eq!((p.head.mark, p.head.text.as_str(), p.head.detail.as_str(), p.head.warn, &p.head.note), (Mark::Dot(Tone::Ok), "Engine đang chạy", "từ 09:02", false, &None));
        let (head, right, rows, empty, more, waiting) = list(p);
        assert_eq!((head, right.map(String::as_str), empty, more), ("Đang chạy · 3 lane", Some("lượt hiện tại"), None, None));
        assert_eq!(waiting.map(String::as_str), Some("Chờ anh: 2 thẻ"));
        let names: Vec<_> = rows.iter().map(|r| (r.name.as_str(), r.phase.as_str(), r.account.as_str(), r.took.as_str(), r.stale)).collect();
        assert_eq!(names, [("D4", "Code", "acc05", "41 phút", false), ("D2", "Code", "acc11", "12 phút", false), ("B3", "Code", "acc03", "3 phút", false)]);
        let q = p.quota.as_ref().unwrap();
        assert_eq!((q.head.as_str(), q.right.as_str(), &q.more), ("Quota", "cập nhật 14:32", &None));
        let r = p.remote.as_ref().unwrap();
        assert_eq!((r.on, r.text.as_str(), &r.button), (false, "Truy cập từ xa: Tắt", &None));
        assert_eq!((p.quit.as_str(), p.open.as_str()), ("Thoát hẳn…", "Mở cc-slaves"));
    }

    #[test]
    fn v28_max_has_5g_and_week_ultra_has_nothing_about_5_hours() {
        let p = model(&obs(true, true, Some(busy())), Lang::Vi).panel;
        let q = p.quota.unwrap();
        let mx = &q.accounts[0];
        assert_eq!((mx.email.as_str(), mx.plan.as_str()), ("acc11@example.org", "Max"));
        let bars: Vec<_> = mx.bars.iter().map(|b| (b.label.as_str(), b.text.as_str(), b.cap)).collect();
        assert_eq!(bars, [("5g", "62 % · 16:10", Some(80)), ("tuần", "31 % · T2 08:00", Some(95))]);
        let ul = &q.accounts[1];
        assert_eq!(ul.plan, "Ultra");
        assert_eq!(ul.bars.len(), 1);
        let all = format!("{ul:?}");
        assert!(!all.contains("5g") && !all.contains("5 giờ"), "{all}");
        let en = model(&obs(true, true, Some(busy())), Lang::En).panel.quota.unwrap();
        assert!(!format!("{:?}", en.accounts[1]).contains("5h"));
        assert_eq!(en.accounts[0].bars[0].label, "5h");
    }

    #[test]
    fn v28_bar_amber_at_cap_minus_5_red_when_full() {
        let mut s = busy();
        s.accounts = vec![max("a@x", 75, 31), max("b@x", 74, 31), ultra("pm@x", 97)];
        s.accounts[2].full = Some(QuotaWindow::Week);
        let q = model(&obs(true, true, Some(s)), Lang::Vi).panel.quota.unwrap();
        let tones: Vec<_> = q.accounts.iter().map(|a| (a.email.as_str(), a.bars[0].tone, a.bars[0].text.as_str())).collect();
        assert_eq!(tones, [("pm@x", Tone::Bad, "Đầy · mở lại T4 10:00"), ("a@x", Tone::Warn, "75 % · 16:10"), ("b@x", Tone::Normal, "74 % · 16:10")]);
        assert_eq!(q.accounts[0].bars[0].used, Some(100), "a full bar is drawn full");
    }

    #[test]
    fn v28_caps_6_lanes_5_accounts_sorted_with_and_more() {
        let mut s = busy();
        s.running = (1..=11).map(|i| lane(&format!("L{i}"), "acc", i)).collect();
        s.accounts = (1..=9).map(|i| max(&format!("a{i}@x"), i * 10, 5)).collect();
        let p = model(&obs(true, true, Some(s)), Lang::Vi).panel;
        let (head, _, rows, _, more, _) = list(&p);
        assert_eq!(head, "Đang chạy · 11 lane");
        assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["L11", "L10", "L9", "L8", "L7", "L6"]);
        assert_eq!(more.map(String::as_str), Some("và 5 lane nữa — mở cc-slaves để xem"));
        let q = p.quota.unwrap();
        assert_eq!(q.accounts.iter().map(|a| a.email.as_str()).collect::<Vec<_>>(), ["a9@x", "a8@x", "a7@x", "a6@x", "a5@x"]);
        assert_eq!(q.more.as_deref(), Some("và 4 account nữa"));
        let mut six = busy();
        six.running = (1..=6).map(|i| lane(&format!("L{i}"), "acc", i)).collect();
        let six = model(&obs(true, true, Some(six)), Lang::Vi).panel;
        assert_eq!((list(&six).2.len(), list(&six).4), (6, None), "exactly 6: no 'và k'");
    }

    #[test]
    fn v28_account_sort_uses_the_highest_window_and_full_first() {
        let mut s = busy();
        s.accounts = vec![max("low@x", 10, 20), max("week@x", 5, 70), ultra("u@x", 50), max("five@x", 90, 1), max("full@x", 1, 1)];
        s.accounts[4].full = Some(QuotaWindow::Five);
        let q = model(&obs(true, true, Some(s)), Lang::Vi).panel.quota.unwrap();
        assert_eq!(q.accounts.iter().map(|a| a.email.as_str()).collect::<Vec<_>>(), ["full@x", "five@x", "week@x", "u@x", "low@x"]);
    }

    #[test]
    fn v28_time_styles_today_week_later_and_durations() {
        let w = |ms| when(ms, NOW, VN, Lang::Vi);
        assert_eq!(w(at(0, 16, 10)), "16:10");
        assert_eq!(w(at(0, 0, 5)), "00:05");
        assert_eq!(w(at(1, 10, 0)), "T4 10:00");
        assert_eq!(w(at(5, 8, 0)), "CN 08:00");
        assert_eq!(w(at(6, 8, 0)), "T2 08:00");
        assert_eq!(w(at(7, 8, 0)), "24/11 08:00", "7 days ahead is no longer 'within the week'");
        assert_eq!(w(at(-1, 23, 0)), "16/11 23:00", "yesterday");
        assert_eq!(w(at(45, 9, 30)), "01/01 09:30", "across the year");
        assert_eq!(when(at(1, 10, 0), NOW, VN, Lang::En), "Wed 10:00");
        assert_eq!(when(at(0, 16, 10), NOW, 0, Lang::Vi), "09:10", "the offset is applied");
        assert_eq!([dur(0, Lang::Vi), dur(59, Lang::Vi), dur(60, Lang::Vi), dur(3599, Lang::Vi), dur(3600 + 5 * 60, Lang::Vi)], ["0 s", "59 s", "1 phút", "59 phút", "1 g 05"]);
        assert_eq!(dur(125 * 60, Lang::En), "2 h 05");
    }

    #[test]
    fn v28_mb3_idle_with_remote_on() {
        let s = Summary { remote_enabled: true, remote_host: Some("slaves.example.test".into()), accounts: busy().accounts, ..Default::default() };
        let m = model(&obs(true, true, Some(s)), Lang::Vi);
        assert_eq!((m.icon, m.title.as_str(), m.remote_ring), (IconState::Idle, "", true));
        let (head, right, rows, empty, _, waiting) = list(&m.panel);
        assert_eq!((head, right, rows.len(), empty.map(String::as_str), waiting), ("Đang chạy · 0 lane", None, 0, Some("Không có lane nào chạy."), None));
        let r = m.panel.remote.unwrap();
        assert_eq!((r.on, r.text.as_str(), r.host.as_str(), r.button.as_deref()), (true, "Từ xa: Đang bật", "slaves.example.test", Some("Tắt truy cập")));
        assert_eq!(m.panel.head.detail, "", "no start time known");
    }

    #[test]
    fn v28_mb4_off_and_starting_show_only_head_note_and_footer() {
        let off = model(&obs(false, false, None), Lang::Vi);
        assert_eq!(off.icon, IconState::Off);
        let h = &off.panel.head;
        assert_eq!((h.mark, h.text.as_str(), h.note.as_deref()), (Mark::Ring, "Engine đã tắt", Some("Không có lane nào chạy. Mở cc-slaves để bật engine.")));
        assert!(off.panel.lanes.is_none() && off.panel.quota.is_none() && off.panel.remote.is_none());
        assert!(off.running.is_empty() && !off.lanes_unknown, "engine off: quit does not ask");
        let st = model(&Observation { lock_age_s: Some(6), ..obs(true, false, None) }, Lang::Vi);
        assert_eq!(st.icon, IconState::Starting);
        let h = &st.panel.head;
        assert_eq!((h.mark, h.text.as_str(), h.detail.as_str(), h.warn), (Mark::Spin, "Engine đang khởi động…", "6 s", false));
        assert_eq!(h.note.as_deref(), Some("Lane và quota hiện khi engine trả lời."));
        assert!(st.panel.lanes.is_none() && st.panel.quota.is_none());
        assert!(st.lanes_unknown, "a silent engine may still run lanes: quit asks");
        assert_eq!(model(&Observation { lock_age_s: Some(21), ..obs(true, false, None) }, Lang::Vi).icon, IconState::Unresponsive);
        assert_eq!(model(&Observation { lock_age_s: Some(6), ..obs(false, false, None) }, Lang::Vi).icon, IconState::Off);
    }

    #[test]
    fn v28_mb4_unresponsive_keeps_old_list_with_grey_dots_and_data_time() {
        let o = Observation { summary_ms: Some(NOW - 48_000 - MIN), now_ms: NOW, ..obs(true, false, Some(busy())) };
        let m = model(&o, Lang::Vi);
        assert_eq!(m.icon, IconState::Unresponsive);
        assert!(!m.remote_ring && m.running.is_empty() && m.lanes_unknown, "a stale list is not trusted for the quit confirm");
        let h = &m.panel.head;
        assert_eq!((h.mark, h.text.as_str(), h.detail.as_str(), h.warn), (Mark::Dot(Tone::Warn), "Engine không phản hồi", "1 phút · dữ liệu từ 14:30", true));
        assert!(list(&m.panel).2.iter().all(|r| r.stale));
        assert_eq!(m.panel.quota.unwrap().right, "từ 14:30");
        assert!(!m.panel.remote.unwrap().on);
        let bare = model(&obs(true, false, None), Lang::Vi).panel;
        assert!(bare.lanes.is_none() && bare.quota.is_none() && bare.head.detail.is_empty(), "nothing old to show");
    }

    #[test]
    fn v28_mb5_unreadable_lanes_hollow_ring_no_count_no_quota() {
        let m = model(&obs(true, true, None), Lang::Vi);
        assert_eq!((m.icon, m.title.as_str(), m.lanes_unknown), (IconState::Unknown, "", true));
        assert_eq!(
            m.panel.lanes,
            Some(Lanes::Unknown { head: "Lane".into(), text: "Không đọc được danh sách lane — mở cc-slaves để xem.".into() })
        );
        assert!(m.panel.quota.is_none());
        assert_eq!(m.panel.remote.unwrap().text, "Truy cập từ xa: Tắt");
        assert_eq!(m.panel.head.detail, "", "no start time known");
        let h = model(&Observation { started_ms: Some(at(0, 9, 2)), ..obs(true, true, None) }, Lang::Vi).panel.head;
        assert_eq!((h.text.as_str(), h.detail.as_str()), ("Engine đang chạy", "từ 09:02"), "start time from /healthz (MB5 right)");
    }

    #[test]
    fn v28_no_accounts_no_quota_block_and_unknown_turn_start_sorts_last() {
        let mut s = busy();
        s.accounts.clear();
        s.running.push(RunningLane { name: "X".into(), phase: None, account: None, turn_started_ms: None });
        let p = model(&obs(true, true, Some(s)), Lang::Vi).panel;
        assert!(p.quota.is_none());
        let last = list(&p).2.last().unwrap();
        assert_eq!((last.name.as_str(), last.phase.as_str(), last.account.as_str(), last.took.as_str()), ("X", "", "", ""));
    }

    #[test]
    fn s6a_language_switch_changes_the_model() {
        let o = obs(true, true, Some(Summary::default()));
        assert_ne!(model(&o, Lang::Vi), model(&o, Lang::En), "the refresh tick only redraws on a model change");
        assert_eq!(model(&o, Lang::En).panel.head.text, "Engine running");
    }
}
