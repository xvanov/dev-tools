//! The PA's live feed (GET /api/events, Server-Sent Events) turned into OS
//! notifications. Payloads are ids and states only (sql/034): this says *that*
//! something needs you, and the window is where you read what.

use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// One SSE frame.
#[derive(Debug, Default, PartialEq)]
pub struct Frame {
    pub id: Option<String>,
    pub data: String,
}

/// Line-by-line SSE parser (the subset /api/events sends: id, data, comments).
#[derive(Default)]
pub struct SseParser {
    id: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    /// Feed one line (without its newline); a blank line completes a frame.
    pub fn line(&mut self, line: &str) -> Option<Frame> {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            if self.data.is_empty() && self.id.is_none() {
                return None;
            }
            let f = Frame {
                id: self.id.take(),
                data: self.data.join("\n"),
            };
            self.data.clear();
            return Some(f);
        }
        if line.starts_with(':') {
            return None; // comment / keepalive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "id" => self.id = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
        None
    }
}

#[derive(Debug, PartialEq)]
pub struct Note {
    pub key: String,
    pub title: String,
    pub body: String,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn id_of(v: &Value) -> String {
    match v.get("id") {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => "?".into(),
    }
}

/// Pure. An event `{id, topic, at, payload: {table, op, id, status, ...}}` as
/// the notification it deserves, or None. Only what needs the human: an
/// approval, a secret, a draft to review, a run that stopped for you or ended.
pub fn notification_for(event: &Value) -> Option<Note> {
    let p = event.get("payload")?;
    let (table, op, status) = (s(p, "table"), s(p, "op"), s(p, "status"));
    let id = id_of(p);
    let (title, body) = match (table, op, status) {
        ("proposal", "insert", "pending") => {
            let kind = s(p, "kind");
            let what = if kind.is_empty() {
                "a proposal".to_string()
            } else {
                format!("a {kind} proposal")
            };
            (
                "Waiting for your approval".to_string(),
                format!("Jarvis has {what} (#{id})."),
            )
        }
        ("secret_request", "insert", "pending") => (
            "A run needs a secret".to_string(),
            format!("Secret request #{id} is waiting for you."),
        ),
        ("draft", "insert", "pending") => ("Draft ready to review".to_string(), format!("Draft #{id} is waiting.")),
        ("run", "update", "waiting") => (
            "A run is waiting on you".to_string(),
            format!("Run #{id} stopped for input."),
        ),
        ("run", "update", "landed") => ("Run landed".to_string(), format!("Run #{id} landed.")),
        ("run", "update", "failed") => ("Run failed".to_string(), format!("Run #{id} failed.")),
        ("notification", "insert", _) => ("Jarvis".to_string(), "You have a new notification.".to_string()),
        _ => return None,
    };
    Some(Note {
        key: format!("{table}:{id}:{status}"),
        title,
        body,
    })
}

/// Remembers what was already shown, so a replay after a reconnect or a row
/// updated twice to the same state does not notify twice. Bounded.
pub struct Seen {
    set: HashSet<String>,
    order: VecDeque<String>,
    cap: usize,
}

impl Seen {
    pub fn new(cap: usize) -> Self {
        Seen {
            set: HashSet::new(),
            order: VecDeque::new(),
            cap,
        }
    }

    /// True the first time `key` is offered.
    pub fn first(&mut self, key: &str) -> bool {
        if self.set.contains(key) {
            return false;
        }
        self.set.insert(key.to_string());
        self.order.push_back(key.to_string());
        while self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

/// Follow `url` until `generation` moves past `mine` (a stack switch or quit).
/// Reconnects with Last-Event-ID and a growing backoff. Blocking: run it on a
/// thread of its own.
pub fn follow(url: String, generation: Arc<AtomicU64>, mine: u64, mut notify: impl FnMut(Note)) {
    let live = || generation.load(Ordering::SeqCst) == mine;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        // The server pings every 20 s; a minute of silence is a dead socket.
        .timeout_read(Duration::from_secs(60))
        .build();
    let mut last_id: Option<String> = None;
    let mut seen = Seen::new(2000);
    let mut backoff = 2u64;
    while live() {
        let mut req = agent.get(&url).set("Accept", "text/event-stream");
        if let Some(id) = &last_id {
            req = req.set("Last-Event-ID", id);
        }
        // The first connect replays nothing (no Last-Event-ID): old news is not news.
        if let Ok(resp) = req.call() {
            backoff = 2;
            let mut parser = SseParser::default();
            for line in BufReader::new(resp.into_reader()).lines() {
                if !live() {
                    return;
                }
                let Ok(line) = line else { break };
                if let Some(frame) = parser.line(&line) {
                    if let Some(id) = frame.id {
                        last_id = Some(id);
                    }
                    if let Ok(ev) = serde_json::from_str::<Value>(&frame.data) {
                        if let Some(note) = notification_for(&ev) {
                            if seen.first(&note.key) {
                                notify(note);
                            }
                        }
                    }
                }
            }
        }
        // Wait in small steps so a switch is noticed quickly.
        for _ in 0..(backoff * 4) {
            if !live() {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        backoff = (backoff * 2).min(30);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_frames() {
        let mut p = SseParser::default();
        assert_eq!(p.line(": ping"), None);
        assert_eq!(p.line("id: g12"), None);
        assert_eq!(p.line("data: {\"a\":1}"), None);
        assert_eq!(
            p.line(""),
            Some(Frame {
                id: Some("g12".into()),
                data: "{\"a\":1}".into()
            })
        );
        assert_eq!(p.line(""), None);
        p.line("data: x");
        p.line("data: y\r");
        assert_eq!(p.line("\r").unwrap().data, "x\ny");
    }

    #[test]
    fn notifications() {
        let ev = |payload: Value| json!({"id": "g1", "topic": "board", "payload": payload});
        let n = notification_for(&ev(
            json!({"table": "proposal", "op": "insert", "id": 7, "status": "pending", "kind": "land"}),
        ))
        .unwrap();
        assert_eq!(n.title, "Waiting for your approval");
        assert_eq!(n.body, "Jarvis has a land proposal (#7).");
        assert_eq!(n.key, "proposal:7:pending");
        assert!(notification_for(&ev(
            json!({"table": "proposal", "op": "update", "id": 7, "status": "accepted"})
        ))
        .is_none());
        assert_eq!(
            notification_for(&ev(
                json!({"table": "run", "op": "update", "id": 3, "status": "waiting"})
            ))
            .unwrap()
            .title,
            "A run is waiting on you"
        );
        assert!(notification_for(&ev(
            json!({"table": "run", "op": "update", "id": 3, "status": "running"})
        ))
        .is_none());
        assert!(notification_for(&json!({"topic": "resync"})).is_none());
    }

    #[test]
    fn seen_once_and_bounded() {
        let mut s = Seen::new(2);
        assert!(s.first("a"));
        assert!(!s.first("a"));
        assert!(s.first("b") && s.first("c"));
        assert!(s.first("a"), "evicted keys may notify again");
    }
}
