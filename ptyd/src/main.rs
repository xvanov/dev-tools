//! ptyd: termhub's terminal host in Rust (plan item 5.1).
//!
//! Owns this machine's PTYs and speaks the session half of sessiond's protocol
//! (HTTP + WebSocket on loopback), so anything that talks to sessiond about
//! terminals can talk to ptyd instead. termhub/test/ptydConformance.test.js runs
//! one black-box suite against both. The rest of sessiond (voice, idle tracking,
//! uploads, the archive) stays in Node and, with TERMHUB_PTYD=1, uses ptyd as its
//! PTY backend (termhub/lib/ptydClient.js), so terminals outlive sessiond too.
//!
//!     ptyd [--port N]      # 127.0.0.1:N, default $TERMHUB_PTYD_PORT or 7020; 0 = any

mod guard;
mod session;
mod spec;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};
use session::{body_u16, now_ms, CreateOpts, Session};
use std::sync::{Arc, Mutex};

pub const DEFAULT_PORT: u16 = 7020;
const MAX_BODY: usize = 1_000_000;

struct App {
    sessions: Mutex<Vec<Arc<Session>>>,
    port: u16,
    started_at: u64,
    machine: String,
}

type Shared = Arc<App>;

impl App {
    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().iter().find(|s| s.id == id).cloned()
    }
}

fn reply(status: u16, body: Value) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), Json(body)).into_response()
}

fn err(status: u16, msg: impl Into<String>) -> Response {
    reply(status, json!({"error": msg.into()}))
}

/// sessiond's readBody: empty -> {}, bad JSON -> an error naming why.
fn parse_body(bytes: &Bytes) -> Result<Map<String, Value>, String> {
    if bytes.len() > MAX_BODY {
        return Err("body too large".into());
    }
    if bytes.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Ok(Map::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

async fn guard_mw(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let refused = if path.starts_with("/ws/") {
        guard::check_upgrade(req.headers())
    } else {
        guard::check_request(req.method(), &path, req.headers())
    };
    match refused {
        Some(r) => err(r.status, r.error),
        None => next.run(req).await,
    }
}

async fn ping(State(app): State<Shared>) -> Response {
    let n = app.sessions.lock().unwrap().len();
    reply(
        200,
        json!({
            "ok": true,
            "sessions": n,
            "entry": "ptyd",
            "pid": std::process::id(),
            "port": app.port,
            "machine": app.machine,
            "commit": option_env!("PTYD_COMMIT"),
            "dirty": Value::Null,
            "startedAt": app.started_at,
            "version": env!("CARGO_PKG_VERSION"),
        }),
    )
}

async fn info(State(app): State<Shared>) -> Response {
    reply(
        200,
        json!({
            "machine": app.machine,
            "platform": platform(),
            "home": spec::home_dir().to_string_lossy(),
            "features": ["session-env", "session-norc", "session-links", "ptyd"],
            "clipboardImage": false,
        }),
    )
}

async fn list(State(app): State<Shared>) -> Response {
    let sessions: Vec<Value> = app.sessions.lock().unwrap().iter().map(|s| s.info()).collect();
    // ptyd keeps no archive: what survives a ptyd restart is sessiond's business.
    reply(
        200,
        json!({"machine": app.machine, "sessions": sessions, "restorable": []}),
    )
}

async fn create(State(app): State<Shared>, body: Bytes) -> Response {
    let body = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return err(400, e),
    };
    let env_spec = match spec::parse_env_spec(&body) {
        Ok(s) => s,
        Err(e) => return err(400, e),
    };
    let (no_rc, rc_given) = match spec::parse_no_rc(&body) {
        Ok(v) => v,
        Err(e) => return err(400, e),
    };
    // Extension: a caller (sessiond in ptyd mode) may choose the id, so the
    // terminal keeps one name on both tiers.
    let id = match body.get("id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if session::valid_id(s) => {
            if app.get(s).is_some() {
                return err(409, "a session with that id already exists");
            }
            Some(s.clone())
        }
        Some(_) => return err(400, "id must match [A-Za-z0-9_-]{1,64}"),
    };
    let str_of = |k: &str| match body.get(k) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    let applied = env_spec.is_some();
    let opts = CreateOpts {
        id,
        cwd: str_of("cwd"),
        command: str_of("command"),
        title: str_of("title"),
        shell: str_of("shell"),
        cols: body_u16(&body, "cols", 2.0, 1000.0),
        rows: body_u16(&body, "rows", 1.0, 500.0),
        env_spec,
        no_rc,
        links: spec::parse_links(body.get("links")),
    };
    let spawned = tokio::task::spawn_blocking(move || Session::spawn(opts)).await;
    let s = match spawned {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return err(500, e),
        Err(e) => return err(500, e.to_string()),
    };
    app.sessions.lock().unwrap().push(s.clone());
    let mut out = s.info();
    if applied {
        out["envApplied"] = json!(true);
    }
    if rc_given {
        out["rcSkipped"] = json!(s.rc_skipped);
    }
    reply(201, out)
}

async fn patch_session(State(app): State<Shared>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = app.get(&id) else {
        return err(404, "no such session");
    };
    let body = match parse_body(&body) {
        Ok(b) => b,
        Err(e) => return err(400, e),
    };
    if let Some(t) = body.get("title") {
        s.rename(t);
    }
    if let Some(l) = body.get("links") {
        let merged = spec::merge_links(s.links().as_ref(), l);
        s.set_links(merged);
    }
    if let Some(p) = body.get("paused") {
        s.set_paused(p);
    }
    reply(200, s.info())
}

async fn delete_session(State(app): State<Shared>, Path(id): Path<String>) -> Response {
    let found = {
        let mut all = app.sessions.lock().unwrap();
        let pos = all.iter().position(|s| s.id == id);
        pos.map(|i| all.remove(i))
    };
    if let Some(s) = found {
        let _ = tokio::task::spawn_blocking(move || s.kill()).await;
    }
    // Idempotent, like sessiond: "close it" of something already gone is fine.
    reply(200, json!({"ok": true}))
}

async fn input(State(app): State<Shared>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = app.get(&id) else {
        return err(404, "no such session");
    };
    let body = parse_body(&body).unwrap_or_default();
    let Some(data) = body.get("data").and_then(Value::as_str) else {
        return err(400, "data must be a string");
    };
    s.write(data);
    if body.get("submit") != Some(&Value::Bool(false)) {
        s.write("\r");
    }
    // Buffer.byteLength(data): UTF-8 bytes.
    reply(200, json!({"ok": true, "bytes": data.len()}))
}

/// Extension: print a line into the terminal and its replay, not into the shell
/// (sessiond's session.notice, which it calls for upload results and warnings).
async fn notice(State(app): State<Shared>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = app.get(&id) else {
        return err(404, "no such session");
    };
    let body = parse_body(&body).unwrap_or_default();
    let Some(text) = body.get("text").and_then(Value::as_str) else {
        return err(400, "text must be a string");
    };
    s.notice(text);
    reply(200, json!({"ok": true}))
}

async fn ws_term(State(app): State<Shared>, Path(id): Path<String>, ws: WebSocketUpgrade) -> Response {
    let Some(s) = app.get(&id) else {
        return err(404, "no such session");
    };
    ws.on_upgrade(move |socket| bind_terminal(socket, s))
}

async fn bind_terminal(mut socket: WebSocket, s: Arc<Session>) {
    let (cid, mut rx) = s.attach();
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(text) => {
                    if socket.send(Message::Text(text.into())).await.is_err() { break; }
                }
                None => break,
            },
            inc = socket.recv() => match inc {
                Some(Ok(Message::Text(t))) => {
                    let Ok(msg) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                    match msg.get("type").and_then(Value::as_str) {
                        Some("input") => {
                            if let Some(d) = msg.get("data").and_then(Value::as_str) { s.write(d); }
                        }
                        Some("resize") => s.resize(
                            msg.get("cols").and_then(Value::as_f64),
                            msg.get("rows").and_then(Value::as_f64),
                            Some(&cid),
                        ),
                        _ => {}
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    s.detach(&cid);
}

async fn not_found() -> Response {
    err(404, "not found")
}

fn router(app: Shared) -> Router {
    Router::new()
        .route("/api/ping", get(ping))
        .route("/api/info", get(info))
        .route("/api/sessions", get(list).post(create))
        .route("/api/sessions/{id}", patch(patch_session).delete(delete_session))
        .route("/api/sessions/{id}/input", post(input))
        .route("/api/sessions/{id}/notice", post(notice))
        .route("/ws/term/{id}", get(ws_term))
        .fallback(not_found)
        .method_not_allowed_fallback(not_found)
        .layer(middleware::from_fn(guard_mw))
        .with_state(app)
}

fn port_from_args() -> u16 {
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        let a = &args[i];
        if a == "--port" && i + 1 < args.len() {
            return args[i + 1].parse().unwrap_or(DEFAULT_PORT);
        }
        if let Some(v) = a.strip_prefix("--port=") {
            return v.parse().unwrap_or(DEFAULT_PORT);
        }
        if a == "--version" {
            println!(
                "ptyd {} ({})",
                env!("CARGO_PKG_VERSION"),
                option_env!("PTYD_COMMIT").unwrap_or("unknown")
            );
            std::process::exit(0);
        }
        i += 1;
    }
    std::env::var("TERMHUB_PTYD_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

#[tokio::main]
async fn main() {
    let want = port_from_args();
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", want)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[ptyd] 127.0.0.1:{want} is not available ({e}); another ptyd may own it. Not starting.");
            std::process::exit(3);
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(want);
    let machine = guard::machine_name();
    let app = Arc::new(App {
        sessions: Mutex::new(Vec::new()),
        port,
        started_at: now_ms(),
        machine: machine.clone(),
    });
    // Tests and supervisors read this line for the port when they asked for 0.
    println!(
        "[ptyd] {machine} listening on http://127.0.0.1:{port} (pid {})",
        std::process::id()
    );
    let _ = std::io::Write::flush(&mut std::io::stdout());
    let svc = router(app).into_make_service();
    if let Err(e) = axum::serve(listener, svc).await {
        eprintln!("[ptyd] server error: {e}");
        std::process::exit(1);
    }
}
