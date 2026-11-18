//! S5 fallback (§3.3-22, §8.3): clicking a macOS notification gives the app no callback, so remember when the last one
//! was shown and where it leads; if the window gains focus within 2 minutes, ask the web to open that target.
//! v2.1 §4.15 §4: the target is `{ cardId?, projectId, lane? }` of the latest notification (it replaces the bare card
//! id): the web selects the project, the node (opens a collapsed tree), and the card when there is one. Known limit:
//! two banners in a row → clicking the older one still lands on the newer one's target.
use serde::Serialize;
use std::time::{Duration, Instant};

pub const FOCUS_WINDOW: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyTarget {
    pub card_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
}

#[derive(Debug, Default)]
pub struct NotifyMemory {
    last: Option<(Instant, NotifyTarget)>,
}

impl NotifyMemory {
    pub fn record(&mut self, at: Instant, target: NotifyTarget) {
        self.last = Some((at, target));
    }

    /// On focus: the latest target (card may be None = "newest card" / a lane-done notice) once, if ≤ 2 min old.
    pub fn take_on_focus(&mut self, now: Instant) -> Option<NotifyTarget> {
        let (at, target) = self.last.take()?;
        (now.saturating_duration_since(at) <= FOCUS_WINDOW).then_some(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: u64) -> NotifyTarget {
        NotifyTarget { card_id: Some(id), project_id: Some("p".into()), lane: None }
    }

    #[test]
    fn s8_3_focus_within_two_minutes_opens_latest_card_once() {
        let t0 = Instant::now();
        let mut m = NotifyMemory::default();
        m.record(t0, card(7));
        assert_eq!(m.take_on_focus(t0 + Duration::from_secs(119)), Some(card(7)));
        assert_eq!(m.take_on_focus(t0 + Duration::from_secs(119)), None, "only once");
    }

    #[test]
    fn s8_3_focus_after_two_minutes_does_nothing() {
        let t0 = Instant::now();
        let mut m = NotifyMemory::default();
        m.record(t0, NotifyTarget::default());
        assert_eq!(m.take_on_focus(t0 + Duration::from_secs(121)), None);
        assert_eq!(m.take_on_focus(t0), None);
    }

    #[test]
    fn s8_3_newer_notification_replaces_older() {
        let t0 = Instant::now();
        let mut m = NotifyMemory::default();
        m.record(t0, card(1));
        m.record(t0 + Duration::from_secs(100), card(2));
        assert_eq!(m.take_on_focus(t0 + Duration::from_secs(200)), Some(card(2)));
    }

    #[test]
    fn s4_15_lane_done_target_keeps_project_and_lane_without_card() {
        let t0 = Instant::now();
        let mut m = NotifyMemory::default();
        let t = NotifyTarget { card_id: None, project_id: Some("p1".into()), lane: Some("H2".into()) };
        m.record(t0, t.clone());
        let got = m.take_on_focus(t0 + Duration::from_secs(5)).expect("target");
        assert_eq!(got, t);
        let json = serde_json::to_value(&got).unwrap();
        assert_eq!(json, serde_json::json!({ "cardId": null, "projectId": "p1", "lane": "H2" }));
    }

    #[test]
    fn s4_15_card_target_serializes_card_id_and_project() {
        let json = serde_json::to_value(card(9)).unwrap();
        assert_eq!(json, serde_json::json!({ "cardId": 9, "projectId": "p" }));
    }
}
