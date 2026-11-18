//! Tiny engine client over loopback: `/healthz` (plain HTTP/1.1, no HTTP crate) and one-shot WS calls (snapshot,
//! command → ack) speaking shared/protocol.ts. Origin = the app origin (§7.2), token via `?token=`.
use crate::i18n::{self, tr, Lang};
use crate::status::{self, Summary};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::Message;

pub fn app_origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub status: u16,
    pub body: Option<Value>,
}

/// Parses a raw HTTP/1.x response: status code + JSON body (if the body is JSON with Content-Length / close framing).
pub fn parse_http_response(raw: &[u8]) -> Option<Health> {
    let text = String::from_utf8_lossy(raw);
    let mut head_body = text.splitn(2, "\r\n\r\n");
    let head = head_body.next()?;
    let body = head_body.next().unwrap_or("");
    let status: u16 = head.lines().next()?.split_whitespace().nth(1)?.parse().ok()?;
    Some(Health { status, body: serde_json::from_str(body.trim()).ok() })
}

pub fn healthz(port: u16, timeout: Duration) -> Option<Health> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let req = format!("GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.take(64 * 1024).read_to_end(&mut buf);
    parse_http_response(&buf)
}

pub fn engine_up(port: u16) -> bool {
    healthz(port, Duration::from_millis(800)).is_some_and(|h| h.status == 200)
}

/// Why an engine call failed. `text(lang)` is what a dialog shows (§6A); `Display` is the Vietnamese text for logs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    Timeout,
    Closed,
    Unresponsive,
    NoToken,
    BadSnapshot,
    Http(u16),
    /// Socket / WS / JSON failure: the OS or library text, shown as is.
    Io(String),
    /// The engine's `error` frame: `key` + `params` (§6A) when present, `message` = its Vietnamese fallback.
    Engine { key: Option<String>, params: Vec<(String, String)>, message: Option<String> },
}

impl ClientError {
    pub fn text(&self, lang: Lang) -> String {
        match self {
            Self::Timeout => tr(lang, "client.timeout", &[]),
            Self::Closed => tr(lang, "client.closed", &[]),
            Self::Unresponsive => tr(lang, "client.unresponsive", &[]),
            Self::NoToken => tr(lang, "client.noToken", &[]),
            Self::BadSnapshot => tr(lang, "client.badSnapshot", &[]),
            Self::Http(code) => tr(lang, "client.http", &[("status", &code.to_string())]),
            Self::Io(e) => e.clone(),
            Self::Engine { key, params, message } => {
                let p: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                key.as_deref()
                    .and_then(|k| i18n::engine_error(lang, k, &p))
                    .or_else(|| message.clone())
                    .unwrap_or_else(|| tr(lang, "client.error", &[]))
            }
        }
    }

    /// From an engine `{"type":"error",…}` frame (shared/protocol.ts).
    pub fn from_frame(v: &Value) -> Self {
        let params = v
            .get("params")
            .and_then(Value::as_object)
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect())
            .unwrap_or_default();
        Self::Engine {
            key: v.get("key").and_then(Value::as_str).map(String::from),
            params,
            message: v.get("message").and_then(Value::as_str).map(String::from),
        }
    }
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text(Lang::Vi))
    }
}

impl std::error::Error for ClientError {}

fn io(e: impl std::fmt::Display) -> ClientError {
    ClientError::Io(e.to_string())
}

type Ws = tungstenite::WebSocket<TcpStream>;

fn ws_connect(port: u16, token: &str, timeout: Duration) -> Result<Ws, ClientError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let stream = TcpStream::connect_timeout(&addr, timeout).map_err(io)?;
    stream.set_read_timeout(Some(timeout)).map_err(io)?;
    stream.set_write_timeout(Some(timeout)).map_err(io)?;
    let enc: String = token.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let mut req = format!("ws://127.0.0.1:{port}/ws?token={enc}").into_client_request().map_err(io)?;
    req.headers_mut().insert("Origin", app_origin(port).parse().map_err(|_| io("origin"))?);
    let (ws, _) = tungstenite::client(req, stream).map_err(|e| io(format!("ws: {e}")))?;
    Ok(ws)
}

fn next_json(ws: &mut Ws, deadline: Instant) -> Result<Value, ClientError> {
    loop {
        if Instant::now() > deadline {
            return Err(ClientError::Timeout);
        }
        match ws.read().map_err(io)? {
            Message::Text(t) => return serde_json::from_str(t.as_str()).map_err(io),
            Message::Close(_) => return Err(ClientError::Closed),
            _ => continue,
        }
    }
}

/// Connects, takes the first `snapshot`, closes.
pub fn snapshot(port: u16, token: &str) -> Result<Summary, ClientError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ws = ws_connect(port, token, Duration::from_secs(3))?;
    let r = loop {
        let v = next_json(&mut ws, deadline)?;
        if v.get("type").and_then(Value::as_str) == Some("snapshot") {
            break status::from_snapshot(&v).ok_or(ClientError::BadSnapshot);
        }
    };
    let _ = ws.close(None);
    r
}

/// v2.7 §10.3 the root folders of the open projects in a `snapshot` frame (`projects[].path`, absolute only).
pub fn roots_of(snapshot: &Value) -> Vec<String> {
    let ps = snapshot.get("snapshot").and_then(|s| s.get("projects")).or_else(|| snapshot.get("projects"));
    ps.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|p| p.get("path").and_then(Value::as_str)).filter(|p| p.starts_with('/')).map(String::from).collect())
        .unwrap_or_default()
}

/// v2.7 §10.3 `open_doc`: the open project roots, from the first `snapshot` of a fresh connection made for this call (the web
/// never names them), so a project added after the app started is in it (hf1117-docs).
pub fn project_roots(port: u16, token: &str) -> Result<Vec<String>, ClientError> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut ws = ws_connect(port, token, Duration::from_secs(3))?;
    let r = loop {
        let v = next_json(&mut ws, deadline)?;
        if v.get("type").and_then(Value::as_str) == Some("snapshot") {
            break roots_of(&v);
        }
    };
    let _ = ws.close(None);
    Ok(r)
}

/// Healthz first (if it carries lanes), else WS snapshot. `None` token → health-only (no lane info).
pub fn status(port: u16, token: Option<&str>) -> Result<Summary, ClientError> {
    let h = healthz(port, Duration::from_millis(800)).ok_or(ClientError::Unresponsive)?;
    if h.status != 200 {
        return Err(ClientError::Http(h.status));
    }
    if let Some(s) = h.body.as_ref().and_then(status::from_healthz) {
        return Ok(s);
    }
    match token {
        Some(t) => snapshot(port, t),
        None => Err(ClientError::NoToken),
    }
}

pub fn command_frame(id: &str, command: &Value) -> Value {
    json!({"type":"command","id":id,"command":command})
}

/// Sends one `command` and waits for its `ack` (Ok(result)) or `error` (Err(ClientError::Engine)).
pub fn command(port: u16, token: &str, command: Value, timeout: Duration) -> Result<Value, ClientError> {
    let deadline = Instant::now() + timeout;
    let mut ws = ws_connect(port, token, Duration::from_secs(3))?;
    let id = format!("app-{}", std::process::id());
    ws.send(Message::text(command_frame(&id, &command).to_string())).map_err(io)?;
    let r = loop {
        let v = next_json(&mut ws, deadline)?;
        if v.get("id").and_then(Value::as_str) != Some(id.as_str()) {
            continue;
        }
        match v.get("type").and_then(Value::as_str) {
            Some("ack") => break Ok(v.get("result").cloned().unwrap_or(Value::Null)),
            Some("error") => break Err(ClientError::from_frame(&v)),
            _ => continue,
        }
    };
    let _ = ws.close(None);
    r
}

/// v2.6 §5.4-4 one session mid-turn while the app waits (`shared/update.ts` `UpdateBusy`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBusy {
    pub project_id: String,
    pub kind: String,
    pub name: String,
    pub turn_started_at: u64,
}

/// v2.6 §5.4-4 `engine.update` (`shared/update.ts` `UpdateInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct UpdateInfo {
    pub since: Option<u64>,
    pub busy: Vec<UpdateBusy>,
    pub held: u32,
}

/// What the holding WS hears: `engine.update` moved (`{type:'engine'}`), or `update_ready` (§5.4-5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldEvent {
    Info(UpdateInfo),
    Ready,
}

/// §5.4-9 the `update_commit` ack payload: `{ok:true}` or `{ok:false, busy}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitResult {
    Ok,
    Busy(Vec<UpdateBusy>),
}

fn hold_event(v: &Value) -> Option<HoldEvent> {
    // `event` frames only: the opening snapshot predates the hold, and taking it broadcasts `{type:'engine'}`
    let body = v.get("event")?;
    match body.get("type").and_then(Value::as_str)? {
        "engine" => serde_json::from_value(body.get("engine")?.get("update")?.clone()).ok().map(HoldEvent::Info),
        "update_ready" => Some(HoldEvent::Ready),
        _ => None,
    }
}

/// v2.6 §5.4 the app's own long-lived WS to the engine (unlike `command`, which closes after its ack): it sends
/// `update_hold {on: true}` and stays open while the app waits; the engine drops the hold when it closes (§5.4-6).
pub struct Hold {
    ws: Ws,
    seq: u32,
    pending: VecDeque<HoldEvent>,
}

impl Hold {
    pub fn open(port: u16, token: &str) -> Result<Hold, ClientError> {
        let mut h = Hold { ws: ws_connect(port, token, Duration::from_secs(3))?, seq: 0, pending: VecDeque::new() };
        h.call(json!({"cmd":"update_hold","on":true}))?;
        Ok(h)
    }

    /// One frame within `wait`: `Ok(None)` = nothing yet; `Err` = the engine went away (§5.4-6).
    fn read(&mut self, wait: Duration) -> Result<Option<Value>, ClientError> {
        self.ws.get_mut().set_read_timeout(Some(wait.max(Duration::from_millis(1)))).map_err(io)?;
        match self.ws.read() {
            Ok(Message::Text(t)) => serde_json::from_str(t.as_str()).map(Some).map_err(io),
            Ok(Message::Close(_)) => Err(ClientError::Closed),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(None),
            Err(e) => Err(io(e)),
        }
    }

    /// Sends one command and waits for its ack result; events read meanwhile are kept for `next_event`.
    fn call(&mut self, command: Value) -> Result<Value, ClientError> {
        self.seq += 1;
        let id = format!("app-hold-{}", self.seq);
        self.ws.send(Message::text(command_frame(&id, &command).to_string())).map_err(io)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let left = deadline.checked_duration_since(Instant::now()).ok_or(ClientError::Timeout)?;
            let Some(v) = self.read(left)? else { continue };
            if v.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                match v.get("type").and_then(Value::as_str) {
                    Some("ack") => return Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                    Some("error") => return Err(ClientError::from_frame(&v)),
                    _ => {}
                }
            } else if let Some(e) = hold_event(&v) {
                self.pending.push_back(e);
            }
        }
    }

    pub fn next_event(&mut self, wait: Duration) -> Result<Option<HoldEvent>, ClientError> {
        if let Some(e) = self.pending.pop_front() {
            return Ok(Some(e));
        }
        let deadline = Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.read(left)? {
                Some(v) => {
                    if let Some(e) = hold_event(&v) {
                        return Ok(Some(e));
                    }
                }
                None if left.is_zero() || Instant::now() >= deadline => return Ok(None),
                None => {}
            }
        }
    }

    /// §5.4-9: `ok` true → go on to stop the engine; false → a turn started, wait for `update_ready` again.
    pub fn commit(&mut self) -> Result<CommitResult, ClientError> {
        let r = self.call(json!({"cmd":"update_commit"}))?;
        if r.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(CommitResult::Ok);
        }
        let busy = r.get("busy").cloned().map(serde_json::from_value).transpose().map_err(io)?.unwrap_or_default();
        Ok(CommitResult::Busy(busy))
    }

    /// `update_hold {on: false}` (Huỷ chờ); the engine flushes what it held.
    pub fn release(&mut self) -> Result<(), ClientError> {
        self.call(json!({"cmd":"update_hold","on":false}))?;
        let _ = self.ws.close(None);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn s10_3_roots_of_a_snapshot_frame() {
        let f = json!({"type":"snapshot","snapshot":{"projects":[{"id":"a","path":"/Users/x/a"},{"id":"b","path":"rel/b"},{"id":"c"}]}});
        assert_eq!(roots_of(&f), vec!["/Users/x/a".to_string()]);
        assert!(roots_of(&json!({"type":"snapshot"})).is_empty());
    }

    #[test]
    fn parses_status_and_json_body() {
        let h = parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}").unwrap();
        assert_eq!(h.status, 200);
        assert_eq!(h.body, Some(json!({"ok":true})));
        let h = parse_http_response(b"HTTP/1.1 503 Service Unavailable\r\n\r\nstarting").unwrap();
        assert_eq!((h.status, h.body), (503, None));
        assert_eq!(parse_http_response(b"garbage"), None);
    }

    #[test]
    fn healthz_against_local_listener_and_closed_port() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut b = [0u8; 512];
            let n = c.read(&mut b).unwrap();
            let req = String::from_utf8_lossy(&b[..n]).to_string();
            c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}").unwrap();
            req
        });
        assert!(engine_up(port));
        assert!(t.join().unwrap().starts_with("GET /healthz HTTP/1.1\r\n"));
        // Port now closed.
        assert!(!engine_up(port));
    }

    #[test]
    #[allow(clippy::result_large_err)] // tungstenite's handshake callback signature
    fn ws_command_sends_origin_and_token_and_waits_for_its_ack() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (c, _) = l.accept().unwrap();
            let mut seen = (String::new(), String::new());
            let cb = |req: &tungstenite::handshake::server::Request, resp| {
                seen.0 = req.uri().to_string();
                seen.1 = req.headers().get("origin").unwrap().to_str().unwrap().to_string();
                Ok(resp)
            };
            let mut ws = tungstenite::accept_hdr(c, cb).unwrap();
            ws.send(Message::text(r#"{"type":"snapshot","snapshot":{}}"#)).unwrap();
            let m = ws.read().unwrap();
            let v: Value = serde_json::from_str(m.to_text().unwrap()).unwrap();
            let id = v["id"].as_str().unwrap().to_string();
            ws.send(Message::text(json!({"type":"ack","id":"other"}).to_string())).unwrap();
            ws.send(Message::text(json!({"type":"ack","id":id,"result":{"n":2}}).to_string())).unwrap();
            let _ = ws.read();
            (seen, v["command"].clone())
        });
        let r = command(port, "t/k+n", json!({"cmd":"stop_all"}), Duration::from_secs(5)).unwrap();
        assert_eq!(r, json!({"n":2}));
        let ((uri, origin), cmd) = t.join().unwrap();
        assert_eq!(uri, "/ws?token=t%2Fk%2Bn");
        assert_eq!(origin, format!("http://127.0.0.1:{port}"));
        assert_eq!(cmd, json!({"cmd":"stop_all"}));
    }

    fn error_once(frame: Value) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (c, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(c).unwrap();
            let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            let mut f = frame;
            f["id"] = v["id"].clone();
            ws.send(Message::text(f.to_string())).unwrap();
            let _ = ws.read();
        });
        port
    }

    #[test]
    fn s6a_engine_error_key_rendered_in_ui_lang() {
        let port = error_once(json!({"type":"error","code":"unknown_command","message":"vi text","key":"errors.unknownCommand","params":{"cmd":"zap"}}));
        let e = command(port, "t", json!({"cmd":"zap"}), Duration::from_secs(5)).unwrap_err();
        let en = e.text(Lang::En);
        assert!(en.contains("zap"), "{en}");
        assert_ne!(en, "vi text");
        assert_eq!(en, i18n::engine_error(Lang::En, "errors.unknownCommand", &[("cmd", "zap")]).unwrap());
        assert_eq!(e.text(Lang::Vi), i18n::engine_error(Lang::Vi, "errors.unknownCommand", &[("cmd", "zap")]).unwrap());
    }

    #[test]
    fn s6a_engine_error_numeric_param_and_unknown_key_falls_back_to_message() {
        let f = json!({"type":"error","message":"Còn 2 lane","key":"errors.nope","params":{"n":2}});
        let e = ClientError::from_frame(&f);
        assert_eq!(e, ClientError::Engine { key: Some("errors.nope".into()), params: vec![("n".into(), "2".into())], message: Some("Còn 2 lane".into()) });
        assert_eq!(e.text(Lang::En), "Còn 2 lane");
        assert_eq!(ClientError::from_frame(&json!({"type":"error"})).text(Lang::En), "engine error");
    }

    #[test]
    fn s6a_client_errors_in_both_languages() {
        assert_eq!(ClientError::Timeout.text(Lang::En), "timed out waiting for the engine");
        assert_eq!(ClientError::Timeout.text(Lang::Vi), "hết thời gian chờ engine");
        assert_eq!(ClientError::Closed.text(Lang::En), "the engine closed the connection");
        assert_eq!(ClientError::Unresponsive.text(Lang::En), "the engine is not responding");
        assert_eq!(ClientError::NoToken.text(Lang::En), "could not read the engine token");
        assert_eq!(ClientError::BadSnapshot.text(Lang::En), "malformed snapshot");
        assert_eq!(ClientError::Http(503).text(Lang::En), "the engine returned HTTP 503");
        assert_eq!(ClientError::NoToken.to_string(), "không đọc được token engine", "logs stay Vietnamese");
    }

    #[test]
    fn s6a_status_closed_port_is_unresponsive() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        assert_eq!(status(port, None), Err(ClientError::Unresponsive));
    }

    #[test]
    fn ws_command_error_returns_vietnamese_message() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (c, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(c).unwrap();
            let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            ws.send(Message::text(json!({"type":"error","id":v["id"],"code":"busy","message":"Còn lane chạy"}).to_string())).unwrap();
            let _ = ws.read();
        });
        let e = command(port, "t", json!({"cmd":"engine_shutdown"}), Duration::from_secs(5)).unwrap_err();
        assert_eq!(e.text(Lang::En), "Còn lane chạy", "no key → the engine's message as sent");
    }

    // v2.6 §5.4 the long-lived holding WS. `serve` runs a fake engine: it acks `update_hold`, then runs `then`.
    fn serve<T: Send + 'static>(then: impl FnOnce(&mut tungstenite::WebSocket<std::net::TcpStream>) -> T + Send + 'static) -> (u16, std::thread::JoinHandle<(Value, T)>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let t = std::thread::spawn(move || {
            let (c, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(c).unwrap();
            ws.send(Message::text(r#"{"type":"snapshot","snapshot":{"engine":{"update":{"hold":false,"since":null,"busy":[],"held":0}}}}"#)).unwrap();
            let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            ws.send(Message::text(json!({"type":"ack","id":v["id"],"result":null}).to_string())).unwrap();
            let r = then(&mut ws);
            (v["command"].clone(), r)
        });
        (port, t)
    }

    fn info_frame(busy: Value, held: u32) -> String {
        json!({"type":"event","event":{"type":"engine","engine":{"version":"0.3.0","update":{"hold":true,"since":5,"busy":busy,"held":held}}}}).to_string()
    }

    fn busy1() -> Value {
        json!([{"projectId":"p","kind":"lane","name":"api","turnStartedAt":7}])
    }

    #[test]
    fn s5_4_hold_open_sends_update_hold_on_and_hears_engine_update_then_ready() {
        let (port, t) = serve(|ws| {
            ws.send(Message::text(info_frame(busy1(), 2))).unwrap();
            ws.send(Message::text(json!({"type":"event","event":{"type":"lane","x":1}}).to_string())).unwrap();
            ws.send(Message::text(json!({"type":"event","event":{"type":"update_ready","backup":"/b/state.db"}}).to_string())).unwrap();
            ws.send(Message::text(json!({"type":"event","event":{"type":"update_ready"}}).to_string())).unwrap();
            let _ = ws.read();
        });
        let mut h = Hold::open(port, "t").unwrap();
        let busy = vec![UpdateBusy { project_id: "p".into(), kind: "lane".into(), name: "api".into(), turn_started_at: 7 }];
        assert_eq!(h.next_event(Duration::from_secs(2)).unwrap(), Some(HoldEvent::Info(UpdateInfo { since: Some(5), busy, held: 2 })));
        assert_eq!(h.next_event(Duration::from_secs(2)).unwrap(), Some(HoldEvent::Ready));
        assert_eq!(h.next_event(Duration::from_secs(2)).unwrap(), Some(HoldEvent::Ready), "a missing backup still releases the wait");
        drop(h);
        assert_eq!(t.join().unwrap().0, json!({"cmd":"update_hold","on":true}));
    }

    #[test]
    fn s5_4_hold_next_event_times_out_quietly_then_reports_a_closed_engine() {
        let (port, t) = serve(|ws| {
            std::thread::sleep(Duration::from_millis(400));
            let _ = ws.close(None);
            let _ = ws.flush();
        });
        let mut h = Hold::open(port, "t").unwrap();
        assert_eq!(h.next_event(Duration::from_millis(100)).unwrap(), None, "nothing yet is not an error");
        let mut r = Ok(None);
        for _ in 0..40 {
            r = h.next_event(Duration::from_millis(100));
            if r.is_err() {
                break;
            }
        }
        assert!(r.is_err(), "§5.4-6 a closed WS is reported: {r:?}");
        let _ = t.join();
    }

    #[test]
    fn s5_4_9_commit_reads_the_ack_payload_and_keeps_events_that_came_first() {
        let (port, t) = serve(|ws| {
            let mut cmds = vec![];
            for ok in [false, true] {
                let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
                ws.send(Message::text(info_frame(busy1(), 0))).unwrap();
                let result = if ok { json!({"ok":true}) } else { json!({"ok":false,"busy":busy1()}) };
                ws.send(Message::text(json!({"type":"ack","id":v["id"],"result":result}).to_string())).unwrap();
                cmds.push(v["command"].clone());
            }
            let _ = ws.read();
            cmds
        });
        let mut h = Hold::open(port, "t").unwrap();
        let busy = vec![UpdateBusy { project_id: "p".into(), kind: "lane".into(), name: "api".into(), turn_started_at: 7 }];
        assert_eq!(h.commit().unwrap(), CommitResult::Busy(busy));
        assert!(matches!(h.next_event(Duration::from_secs(1)).unwrap(), Some(HoldEvent::Info(_))), "event before the ack is kept");
        assert_eq!(h.commit().unwrap(), CommitResult::Ok);
        drop(h);
        assert_eq!(t.join().unwrap().1, vec![json!({"cmd":"update_commit"}), json!({"cmd":"update_commit"})]);
    }

    #[test]
    fn s5_4_9_commit_from_a_non_holder_is_an_engine_error() {
        let (port, _t) = serve(|ws| {
            let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            ws.send(Message::text(json!({"type":"error","id":v["id"],"code":"not_holding","key":"errors.badMessage"}).to_string())).unwrap();
            let _ = ws.read();
        });
        let mut h = Hold::open(port, "t").unwrap();
        assert!(matches!(h.commit(), Err(ClientError::Engine { .. })));
    }

    #[test]
    fn s5_4_release_sends_update_hold_off() {
        let (port, t) = serve(|ws| {
            let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            ws.send(Message::text(json!({"type":"ack","id":v["id"],"result":null}).to_string())).unwrap();
            v["command"].clone()
        });
        let mut h = Hold::open(port, "t").unwrap();
        h.release().unwrap();
        assert_eq!(t.join().unwrap().1, json!({"cmd":"update_hold","on":false}));
    }

    #[test]
    fn s5_4_hold_refused_is_an_error() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (c, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(c).unwrap();
            let v: Value = serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            ws.send(Message::text(json!({"type":"error","id":v["id"],"code":"forbidden_remote"}).to_string())).unwrap();
            let _ = ws.read();
        });
        assert!(matches!(Hold::open(port, "t"), Err(ClientError::Engine { .. })));
    }
}
