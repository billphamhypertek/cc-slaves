//! The menu-bar monitoring panel (v2.8 §4.11.2–§4.11.5, MB2–MB6; L12): a native `NSPopover` under the status item.
//! `layout` is pure — model / "Thoát hẳn" content → positioned elements in three bands (top, Quota, bottom), measured in
//! points on MB2/MB5 (1 px = 1 pt) — so heights and "only Quota scrolls" are unit-tested. `Popover` (macOS) draws a
//! layout with AppKit controls and system label colours; rows are view-only (no hover, no selection).
use crate::model::{Account, Bar, Head, Lanes, Mark, Panel, Quota, Remote, Tone};
use crate::quit::{Confirm, ProgressView, StepState};

pub const WIDTH: f64 = 340.0;
const PAD: f64 = 14.0;
const ROW: f64 = 22.0;
const LINE: f64 = 18.0;
/// Space kept under the panel when it is taller than the screen (§4.11.2 "visibleFrame − 8 pt").
pub const SCREEN_MARGIN: f64 = 8.0;
/// The popover's arrow sits above the content.
pub const ARROW: f64 = 13.0;
/// Quota never shrinks below this when it has to scroll.
const MIN_QUOTA: f64 = 80.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Font {
    Title,
    Body,
    BodyBold,
    Small,
    SmallBold,
}

/// Text / mark colour: label, secondary label, or a status tone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ink {
    Fg,
    Fg2,
    Tone(Tone),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    Open,
    Quit,
    QuitGo,
    Cancel,
    Continue,
    RemoteOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    /// The default button (Enter), filled with the system accent.
    Default,
    /// A plain bordered button.
    Plain,
    /// Bordered, red text ("Thoát hẳn" in the confirm).
    Danger,
    /// Text only, red, no bezel ("Thoát hẳn…" in the footer).
    Link,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    Text { s: String, font: Font, ink: Ink, right: bool, wrap: bool },
    Dot { ink: Ink, hollow: bool },
    Spin,
    Sep,
    /// `used` / `cap` in 0…1.
    Bar { used: f64, cap: Option<f64>, ink: Ink },
    Button { title: String, act: Act, look: Look },
}

#[derive(Debug, Clone, PartialEq)]
pub struct El {
    pub kind: Kind,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Text size, so wrapped lines and the inline detail sit where AppKit will draw them.
pub trait Measure {
    fn width(&self, s: &str, font: Font) -> f64;
    fn height(&self, s: &str, font: Font, w: f64) -> f64;
}

/// Three bands, each in its own y-down coordinates: only `quota` may scroll.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Layout {
    pub top: Vec<El>,
    pub top_h: f64,
    pub quota: Vec<El>,
    pub quota_h: f64,
    pub bottom: Vec<El>,
    pub bottom_h: f64,
}

impl Layout {
    pub fn height(&self) -> f64 {
        self.top_h + self.quota_h + self.bottom_h
    }
    /// The Quota band's visible height for a screen that leaves `room` points under the menu bar: all of it when the
    /// panel fits, else what is left after the fixed bands (head, lanes, remote, footer always visible).
    pub fn quota_view(&self, room: f64) -> f64 {
        let max = room - SCREEN_MARGIN - ARROW;
        if self.height() <= max {
            self.quota_h
        } else {
            (max - self.top_h - self.bottom_h).clamp(MIN_QUOTA.min(self.quota_h), self.quota_h)
        }
    }
}

/// What the panel shows: the monitor, the in-panel confirm, or the run's progress (§4.11.5).
pub enum Content<'a> {
    Monitor(&'a Panel),
    Confirm(&'a Confirm),
    Progress(&'a ProgressView),
}

struct Col<'a> {
    els: Vec<El>,
    y: f64,
    m: &'a dyn Measure,
}

impl Col<'_> {
    fn put(&mut self, kind: Kind, x: f64, y: f64, w: f64, h: f64) {
        self.els.push(El { kind, x, y, w, h });
    }
    fn text(&mut self, s: &str, (font, ink): (Font, Ink), x: f64, w: f64, right: bool, row: f64) {
        if !s.is_empty() {
            self.put(Kind::Text { s: s.into(), font, ink, right, wrap: false }, x, self.y, w, row);
        }
    }
    /// A wrapped paragraph across the panel; moves down by its height.
    fn para(&mut self, s: &str, font: Font, ink: Ink) {
        let w = WIDTH - 2.0 * PAD;
        let h = self.m.height(s, font, w).ceil();
        self.put(Kind::Text { s: s.into(), font, ink, right: false, wrap: true }, PAD, self.y, w, h);
        self.y += h;
    }
    fn dot(&mut self, ink: Ink, hollow: bool, row: f64) {
        self.put(Kind::Dot { ink, hollow }, PAD, self.y + (row - 7.0) / 2.0, 7.0, 7.0);
    }
    fn sep(&mut self) {
        self.put(Kind::Sep, 0.0, self.y, WIDTH, 1.0);
    }
    /// A section head: bold grey left, grey right.
    fn head(&mut self, left: &str, right: &str) {
        self.text(left, (Font::SmallBold, Ink::Fg2), PAD, 200.0, false, LINE);
        self.text(right, (Font::Small, Ink::Fg2), WIDTH - PAD - 150.0, 150.0, true, LINE);
        self.y += LINE;
    }
    fn button(&mut self, title: &str, act: Act, look: Look, right: bool) {
        let w = (self.m.width(title, Font::Body) + if look == Look::Link { 4.0 } else { 26.0 }).ceil();
        let x = if right { WIDTH - PAD - w } else { PAD - if look == Look::Link { 2.0 } else { 0.0 } };
        self.put(Kind::Button { title: title.into(), act, look }, x, self.y, w, ROW);
    }
}

fn ink(t: Tone) -> Ink {
    match t {
        Tone::Normal => Ink::Fg,
        t => Ink::Tone(t),
    }
}

/// Lays out `c`; `m` measures text the way AppKit draws it.
pub fn layout(c: &Content, m: &dyn Measure) -> Layout {
    let mut top = Col { els: vec![], y: 12.0, m };
    top.text("cc-slaves", (Font::Title, Ink::Fg), PAD, 200.0, false, LINE);
    top.y += LINE;
    let mut l = Layout::default();
    match c {
        Content::Monitor(p) => {
            top.y += 3.0;
            head(&mut top, &p.head);
            match &p.lanes {
                Some(Lanes::List { head, right, rows, empty, more, waiting }) => {
                    top.sep();
                    top.y += 8.0;
                    top.head(head, right.as_deref().unwrap_or(""));
                    top.y += 3.0;
                    for r in rows {
                        top.dot(Ink::Tone(if r.stale { Tone::Grey } else { Tone::Ok }), false, ROW);
                        top.text(&r.name, (Font::BodyBold, Ink::Fg), 30.0, 46.0, false, ROW);
                        top.text(&r.phase, (Font::Body, Ink::Fg), 78.0, 112.0, false, ROW);
                        top.text(&r.account, (Font::Body, Ink::Fg), 194.0, 76.0, false, ROW);
                        top.text(&r.took, (Font::Body, Ink::Fg), 270.0, WIDTH - PAD - 270.0, true, ROW);
                        top.y += ROW;
                    }
                    if let Some(e) = empty {
                        top.text(e, (Font::Body, Ink::Fg2), PAD, WIDTH - 2.0 * PAD, false, ROW);
                        top.y += ROW;
                    }
                    if let Some(mo) = more {
                        top.text(mo, (Font::Small, Ink::Fg2), PAD, WIDTH - 2.0 * PAD, false, LINE);
                        top.y += LINE;
                    }
                    if let Some(w) = waiting {
                        top.dot(Ink::Tone(Tone::Warn), false, ROW);
                        top.text(w, (Font::BodyBold, Ink::Tone(Tone::Warn)), 30.0, WIDTH - PAD - 30.0, false, ROW);
                        top.y += ROW;
                    }
                    top.y += 10.0;
                }
                Some(Lanes::Unknown { head, text }) => {
                    top.sep();
                    top.y += 8.0;
                    top.head(head, "");
                    top.y += 3.0;
                    top.para(text, Font::Body, Ink::Fg);
                    top.y += 10.0;
                }
                None => {}
            }
            if let Some(q) = &p.quota {
                // the separator above Quota stays put when Quota scrolls
                top.put(Kind::Sep, 0.0, top.y - 1.0, WIDTH, 1.0);
                let mut qc = Col { els: vec![], y: 0.0, m };
                quota(&mut qc, q);
                (l.quota, l.quota_h) = (qc.els, qc.y);
            }
            let mut bot = Col { els: vec![], y: 0.0, m };
            if let Some(r) = &p.remote {
                remote(&mut bot, r);
            }
            bot.sep();
            bot.y += 11.0;
            bot.button(&p.quit, Act::Quit, Look::Link, false);
            bot.button(&p.open, Act::Open, Look::Default, true);
            bot.y += ROW + 13.0;
            (l.bottom, l.bottom_h) = (bot.els, bot.y);
        }
        Content::Confirm(cf) => {
            top.y += 12.0;
            top.text(&cf.title, (Font::BodyBold, Ink::Fg), PAD, WIDTH - 2.0 * PAD, false, LINE);
            top.y += LINE + 7.0;
            top.para(&cf.body, Font::Body, Ink::Fg);
            top.y += 6.0;
            top.para(&cf.note, Font::Body, Ink::Fg2);
            top.y += 12.0;
            top.sep();
            top.y += 10.0;
            top.button(&cf.cancel, Act::Cancel, Look::Plain, false);
            top.button(&cf.go, Act::QuitGo, Look::Danger, true);
            top.y += ROW + 10.0;
        }
        Content::Progress(v) => {
            top.y += 12.0;
            top.text(&v.title, (Font::BodyBold, Ink::Fg), PAD, WIDTH - 2.0 * PAD, false, LINE);
            top.y += LINE + 5.0;
            for line in &v.lines {
                let (mark, bold) = match line.state {
                    StepState::Pending => (Some((Ink::Fg2, true)), false),
                    StepState::Running(_) => (None, true),
                    StepState::Done(_) => (Some((Ink::Tone(Tone::Ok), false)), false),
                    StepState::Skipped => (Some((Ink::Fg2, false)), false),
                    StepState::Forced => (Some((Ink::Tone(Tone::Bad), false)), false),
                };
                match (mark, line.state) {
                    (None, _) => top.put(Kind::Spin, PAD + 2.0, top.y + 5.0, 14.0, 14.0),
                    (Some((i, hollow)), StepState::Pending) => top.put(Kind::Dot { ink: i, hollow }, PAD + 4.0, top.y + 8.0, 9.0, 9.0),
                    (Some((i, _)), st) => {
                        let g = match st {
                            StepState::Done(_) => "✓",
                            StepState::Forced => "!",
                            _ => "–",
                        };
                        top.text(g, (Font::BodyBold, i), PAD + 2.0, 14.0, false, 24.0);
                    }
                }
                let font = if bold { Font::BodyBold } else { Font::Body };
                let lw = top.m.width(&line.label, font).ceil();
                top.text(&line.label, (font, Ink::Fg), PAD + 20.0, lw, false, 24.0);
                let dx = PAD + 20.0 + lw + 4.0;
                top.text(&line.detail, (Font::Small, Ink::Fg2), dx, WIDTH - PAD - dx, true, 24.0);
                top.y += 24.0;
            }
            top.y += 6.0;
            if let Some((body, auto, cont)) = &v.stuck {
                top.para(body, Font::Body, Ink::Fg2);
                top.y += 12.0;
                top.sep();
                top.y += 10.0;
                top.text(auto, (Font::Small, Ink::Fg2), PAD, 180.0, false, ROW);
                top.button(cont, Act::Continue, Look::Plain, true);
                top.y += ROW + 10.0;
            } else {
                top.y += 6.0;
            }
        }
    }
    (l.top, l.top_h) = (top.els, top.y);
    l
}

/// "● Engine đang chạy · từ 09:02" (+ the note under it, MB4).
fn head(c: &mut Col, h: &Head) {
    match h.mark {
        Mark::Dot(t) => c.dot(Ink::Tone(t), false, LINE),
        Mark::Ring => c.dot(Ink::Fg2, true, LINE),
        Mark::Spin => c.put(Kind::Spin, PAD - 2.0, c.y + 2.0, 12.0, 12.0),
    }
    let ink = if h.warn { Ink::Tone(Tone::Warn) } else { Ink::Fg };
    let x = PAD + 15.0;
    let tw = c.m.width(&h.text, Font::Body).ceil() + 2.0;
    c.text(&h.text, (Font::Body, ink), x, tw, false, LINE);
    if !h.detail.is_empty() {
        let dx = x + tw + 4.0;
        c.text(&format!("· {}", h.detail), (Font::Small, Ink::Fg2), dx, WIDTH - PAD - dx, false, LINE);
    }
    c.y += LINE;
    if let Some(n) = &h.note {
        c.y += 6.0;
        c.para(n, Font::Body, Ink::Fg2);
    }
    c.y += 10.0;
}

/// One account: email + plan, then its bars (Max 62 pt, Ultra 44 pt with the 8 pt gap, measured on MB2).
fn account(c: &mut Col, a: &Account) {
    c.text(&a.email, (Font::BodyBold, Ink::Fg), PAD, 240.0, false, LINE);
    c.text(&a.plan, (Font::Small, Ink::Fg2), WIDTH - PAD - 80.0, 80.0, true, LINE);
    c.y += LINE;
    for b in &a.bars {
        bar(c, b);
    }
}

fn bar(c: &mut Col, b: &Bar) {
    c.text(&b.label, (Font::Small, Ink::Fg2), PAD, 34.0, false, LINE);
    let pct = |p: u32| (f64::from(p) / 100.0).clamp(0.0, 1.0);
    let fill = if b.tone == Tone::Normal { Ink::Fg } else { ink(b.tone) };
    c.put(Kind::Bar { used: b.used.map_or(0.0, pct), cap: b.cap.map(pct), ink: fill }, 50.0, c.y + 6.0, 138.0, 6.0);
    let font = if b.tone == Tone::Normal { Font::Small } else { Font::SmallBold };
    c.text(&b.text, (font, ink(b.tone)), 192.0, WIDTH - PAD - 192.0, true, LINE);
    c.y += LINE;
}

fn quota(c: &mut Col, q: &Quota) {
    c.y += 8.0;
    c.head(&q.head, &q.right);
    c.y += 6.0;
    for (i, a) in q.accounts.iter().enumerate() {
        if i > 0 {
            c.y += 8.0;
        }
        account(c, a);
    }
    if let Some(m) = &q.more {
        c.text(m, (Font::Small, Ink::Fg2), PAD, WIDTH - 2.0 * PAD, false, LINE);
        c.y += LINE;
    }
    c.y += 14.0;
}

fn remote(c: &mut Col, r: &Remote) {
    c.sep();
    c.y += 10.0;
    c.dot(if r.on { Ink::Tone(Tone::Ok) } else { Ink::Fg2 }, !r.on, ROW);
    let x = PAD + 15.0;
    let tw = c.m.width(&r.text, Font::Body).ceil() + 2.0;
    c.text(&r.text, (Font::Body, Ink::Fg), x, tw, false, ROW);
    let mut end = WIDTH - PAD;
    if let Some(b) = &r.button {
        c.button(b, Act::RemoteOff, Look::Plain, true);
        end = c.els.last().map_or(end, |e| e.x) - 8.0;
    }
    let hx = x + tw + 6.0;
    if !r.host.is_empty() && end > hx {
        c.text(&r.host, (Font::Small, Ink::Fg2), hx, end - hx, false, ROW);
    }
    c.y += ROW + 11.0;
}

#[cfg(target_os = "macos")]
pub use appkit::{Hooks, Popover};

#[cfg(target_os = "macos")]
mod appkit;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Head, LaneRow};
    use crate::quit::{Line, StepState};

    /// 6.5 pt per char, 16 pt lines: close enough to SF 13 for band heights (one-line rows do not depend on it).
    struct Fake;
    impl Measure for Fake {
        fn width(&self, s: &str, _: Font) -> f64 {
            s.chars().count() as f64 * 6.5
        }
        fn height(&self, s: &str, f: Font, w: f64) -> f64 {
            (self.width(s, f) / w).ceil().max(1.0) * 16.0
        }
    }

    fn row(name: &str, stale: bool) -> LaneRow {
        LaneRow { name: name.into(), phase: "Code".into(), account: "acc11".into(), took: "12 phút".into(), stale }
    }
    fn bar(label: &str) -> Bar {
        Bar { label: label.into(), used: Some(62), cap: Some(80), tone: Tone::Normal, text: "62 % · 16:10".into() }
    }
    fn acc(max: bool) -> Account {
        let bars = if max { vec![bar("5g"), bar("tuần")] } else { vec![bar("tuần")] };
        Account { email: "acc@example.org".into(), plan: if max { "Max" } else { "Ultra" }.into(), bars }
    }
    fn running() -> Head {
        Head { mark: Mark::Dot(Tone::Ok), text: "Engine đang chạy".into(), detail: "từ 09:02".into(), warn: false, note: None }
    }
    fn panel(lanes: usize, more: bool, accs: Vec<Account>, more_acc: bool) -> Panel {
        Panel {
            head: running(),
            lanes: Some(Lanes::List {
                head: "Đang chạy · 3 lane".into(),
                right: Some("lượt hiện tại".into()),
                rows: (0..lanes).map(|i| row(&format!("D{i}"), false)).collect(),
                empty: None,
                more: more.then(|| "và 5 lane nữa — mở cc-slaves để xem".into()),
                waiting: Some("Chờ anh: 2 thẻ".into()),
            }),
            quota: Some(Quota { head: "Quota".into(), right: "cập nhật 14:32".into(), accounts: accs, more: more_acc.then(|| "và 4 account nữa".into()) }),
            remote: Some(Remote { on: false, text: "Truy cập từ xa: Tắt".into(), host: String::new(), button: None }),
            quit: "Thoát hẳn…".into(),
            open: "Mở cc-slaves".into(),
        }
    }
    fn buttons(els: &[El]) -> Vec<(Act, Look, f64)> {
        els.iter().filter_map(|e| if let Kind::Button { act, look, .. } = &e.kind { Some((*act, *look, e.x)) } else { None }).collect()
    }

    #[test]
    fn v28_mb2_bands_match_the_mockup_in_points() {
        let p = panel(3, false, vec![acc(true), acc(true), acc(false), acc(false)], false);
        let l = layout(&Content::Monitor(&p), &Fake);
        // MB2: separators at 188 (lanes → quota) and 438 (quota → remote) under the panel top, bottom at 527
        assert_eq!((l.top_h, l.quota_h, l.bottom_h), (188.0, 250.0, 89.0));
        assert_eq!(l.height(), 527.0);
    }

    #[test]
    fn v28_mb5_six_lanes_five_accounts_is_690_and_worst_case_726() {
        let mb5 = panel(6, true, vec![acc(false), acc(true), acc(true), acc(true), acc(false)], true);
        assert_eq!(layout(&Content::Monitor(&mb5), &Fake).height(), 691.0, "spec §4.11.2: 690 pt measured on MB5");
        let worst = panel(6, true, (0..5).map(|_| acc(true)).collect(), true);
        assert_eq!(layout(&Content::Monitor(&worst), &Fake).height(), 727.0, "spec: ≈ 726 pt");
    }

    #[test]
    fn v28_only_quota_scrolls_and_only_when_taller_than_the_screen() {
        let p = panel(6, true, (0..5).map(|_| acc(true)).collect(), true);
        let l = layout(&Content::Monitor(&p), &Fake);
        assert_eq!(l.quota_view(900.0), l.quota_h, "fits: no scrolling");
        assert_eq!(l.quota_view(l.height() + SCREEN_MARGIN + ARROW), l.quota_h, "exactly fits");
        let small = 600.0;
        assert_eq!(l.quota_view(small), small - SCREEN_MARGIN - ARROW - l.top_h - l.bottom_h, "top + bottom stay whole");
        assert_eq!(l.quota_view(200.0), MIN_QUOTA, "never below the minimum");
        assert!(!l.quota.iter().any(|e| e.kind == Kind::Sep), "no separator inside the scrolling band");
        assert!(l.top.iter().any(|e| e.kind == Kind::Sep && e.y == l.top_h - 1.0), "the one above Quota is fixed");
    }

    #[test]
    fn v28_footer_quit_left_link_open_right_default_rows_view_only() {
        let p = panel(3, false, vec![acc(true)], false);
        let l = layout(&Content::Monitor(&p), &Fake);
        assert!(buttons(&l.top).is_empty() && buttons(&l.quota).is_empty(), "rows are view-only");
        let b = buttons(&l.bottom);
        assert_eq!(b.iter().map(|(a, k, _)| (*a, *k)).collect::<Vec<_>>(), [(Act::Quit, Look::Link), (Act::Open, Look::Default)]);
        assert!(b[0].2 < b[1].2, "Thoát hẳn… left of Mở cc-slaves");
    }

    #[test]
    fn v28_remote_on_has_the_turn_off_button_and_host() {
        let mut p = panel(0, false, vec![], false);
        p.remote = Some(Remote { on: true, text: "Từ xa: Đang bật".into(), host: "slaves.example.test".into(), button: Some("Tắt truy cập".into()) });
        let l = layout(&Content::Monitor(&p), &Fake);
        assert_eq!(buttons(&l.bottom)[0].0, Act::RemoteOff);
        assert!(l.bottom.iter().any(|e| matches!(&e.kind, Kind::Text { s, .. } if s == "slaves.example.test")));
        assert!(l.bottom.iter().any(|e| matches!(e.kind, Kind::Dot { ink: Ink::Tone(Tone::Ok), hollow: false })));
    }

    #[test]
    fn v28_stale_lanes_draw_grey_dots() {
        let mut p = panel(2, false, vec![], false);
        if let Some(Lanes::List { rows, .. }) = &mut p.lanes {
            *rows = vec![row("D2", true), row("B3", true)];
        }
        let l = layout(&Content::Monitor(&p), &Fake);
        let dots: Vec<_> = l.top.iter().filter_map(|e| if let Kind::Dot { ink, .. } = e.kind { Some(ink) } else { None }).collect();
        assert_eq!(dots, [Ink::Tone(Tone::Ok), Ink::Tone(Tone::Grey), Ink::Tone(Tone::Grey), Ink::Tone(Tone::Warn)], "engine, 2 lanes, waiting");
    }

    #[test]
    fn v28_bar_tick_at_the_cap_and_full_tone() {
        let mut p = panel(0, false, vec![acc(false)], false);
        if let Some(q) = &mut p.quota {
            q.accounts[0].bars[0] = Bar { label: "tuần".into(), used: Some(100), cap: Some(95), tone: Tone::Bad, text: "Đầy · mở lại T5 10:00".into() };
        }
        let l = layout(&Content::Monitor(&p), &Fake);
        let b = l.quota.iter().find_map(|e| if let Kind::Bar { used, cap, ink } = e.kind { Some((used, cap, ink)) } else { None });
        assert_eq!(b, Some((1.0, Some(0.95), Ink::Tone(Tone::Bad))));
    }

    #[test]
    fn v28_confirm_cancel_left_quit_right_no_default_button() {
        let c = Confirm { title: "Thoát hẳn cc-slaves?".into(), body: "3 lane…".into(), note: "Engine sẽ tắt…".into(), cancel: "Huỷ".into(), go: "Thoát hẳn".into() };
        let l = layout(&Content::Confirm(&c), &Fake);
        let b = buttons(&l.top);
        assert_eq!(b.iter().map(|(a, k, _)| (*a, *k)).collect::<Vec<_>>(), [(Act::Cancel, Look::Plain), (Act::QuitGo, Look::Danger)]);
        assert!(b[0].2 < b[1].2);
        assert!(l.quota.is_empty() && l.bottom.is_empty());
    }

    #[test]
    fn v28_progress_three_lines_spinner_on_the_running_one_and_stuck_footer() {
        let line = |label: &str, state| Line { label: label.into(), state, detail: String::new() };
        let mut v = ProgressView {
            title: "Đang thoát hẳn…".into(),
            lines: vec![line("Dừng lane và tắt engine", StepState::Running(4)), line("b", StepState::Pending), line("c", StepState::Pending)],
            stuck: None,
        };
        let l = layout(&Content::Progress(&v), &Fake);
        assert_eq!(l.top.iter().filter(|e| e.kind == Kind::Spin).count(), 1);
        assert!(l.top.iter().any(|e| matches!(&e.kind, Kind::Text { s, font: Font::BodyBold, .. } if s == "Dừng lane và tắt engine")), "running line bold");
        assert!(buttons(&l.top).is_empty(), "nothing cancels the run");
        v.lines[1] = Line { label: "Đóng cửa sổ cc-slaves".into(), state: StepState::Skipped, detail: "bỏ qua · app đang đóng".into() };
        let l = layout(&Content::Progress(&v), &Fake);
        let label = l.top.iter().find(|e| matches!(&e.kind, Kind::Text { s, .. } if s == "Đóng cửa sổ cc-slaves")).unwrap();
        let detail = l.top.iter().find(|e| matches!(&e.kind, Kind::Text { s, .. } if s.starts_with("bỏ qua"))).unwrap();
        assert!(detail.x >= label.x + label.w && detail.x + detail.w <= WIDTH - PAD, "detail sits right of the label, inside the panel");
        assert!(detail.w >= Fake.width("bỏ qua · app đang đóng", Font::Small), "not cut");
        v.lines[0].state = StepState::Forced;
        v.stuck = Some(("launchd…".into(), "Tự thoát tiếp sau 8 s".into(), "Thoát tiếp (8)".into()));
        let l = layout(&Content::Progress(&v), &Fake);
        assert_eq!(buttons(&l.top).iter().map(|b| b.0).collect::<Vec<_>>(), [Act::Continue]);
        assert!(l.top.iter().any(|e| matches!(&e.kind, Kind::Text { s, ink: Ink::Tone(Tone::Bad), .. } if s == "!")));
    }

    #[test]
    fn v28_mb4_off_note_wraps_under_the_engine_line() {
        let p = Panel {
            head: Head { mark: Mark::Ring, text: "Engine đã tắt".into(), detail: String::new(), warn: false, note: Some("x".repeat(60)) },
            lanes: None,
            quota: None,
            remote: None,
            quit: "Thoát hẳn…".into(),
            open: "Mở cc-slaves".into(),
        };
        let l = layout(&Content::Monitor(&p), &Fake);
        // MB4 "Engine tắt": 2-line note, separator 104 pt under the top
        assert_eq!(l.top_h, 12.0 + 18.0 + 3.0 + 18.0 + 6.0 + 32.0 + 10.0);
        assert!(l.top.iter().any(|e| matches!(e.kind, Kind::Dot { hollow: true, .. })));
        assert_eq!(l.quota_h, 0.0);
    }
}
