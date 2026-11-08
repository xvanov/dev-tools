//! One PTY and everything sessiond keeps beside it (lib/session.js): metadata,
//! scrollback, the attached clients and who owns the size.
//!
//! Threads: a blocking reader (PTY -> scrollback + clients), a blocking writer
//! (input -> PTY, so a full pipe never stalls the async runtime) and a waiter
//! (child exit). Everything shared sits behind one mutex, and `attach` takes the
//! replay snapshot and registers the client under that same lock, so a client
//! sees every byte exactly once: in the replay or as live output, never both.

use crate::spec::{self, EnvSpec, Links};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

/// Environment variables naming the agent session ptyd itself was started from;
/// never inherited by a terminal (lib/session.js PARENT_AGENT_ENV).
const PARENT_AGENT_ENV: [&str; 6] = [
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

const BUSY_MS: u64 = 1500;
const COMMAND_SETTLE_MS: u64 = 120;
const COMMAND_FALLBACK_MS: u64 = 1500;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Same shape as sessiond's ids: `s<time base36><counter base36>`.
pub fn gen_id() -> String {
    let c = COUNTER.fetch_add(1, Ordering::SeqCst) + 1;
    format!("s{}{}", base36(now_ms()), base36(c))
}

pub fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Incremental UTF-8: holds back a sequence split across reads, replaces bad bytes.
#[derive(Default)]
struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        let mut start = 0;
        loop {
            match std::str::from_utf8(&self.pending[start..]) {
                Ok(s) => {
                    out.push_str(s);
                    start = self.pending.len();
                    break;
                }
                Err(e) => {
                    let ok = start + e.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[start..ok]).unwrap());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            start = ok + n;
                        }
                        None => {
                            start = ok; // incomplete tail: keep for the next read
                            break;
                        }
                    }
                }
            }
        }
        self.pending.drain(..start);
        out
    }
}

struct Client {
    id: String,
    tx: UnboundedSender<String>,
}

struct State {
    title: String,
    links: Option<Links>,
    cols: u16,
    rows: u16,
    alive: bool,
    exit_code: Option<i64>,
    exited: bool,
    killed: bool,
    last_activity: u64,
    last_input_at: u64,
    paused: bool,
    size_owner: Option<String>,
    ring: VecDeque<String>,
    ring_bytes: usize,
    clients: Vec<Client>,
    client_seq: u64,
    pending_command: Option<String>,
    decoder: Utf8Stream,
    answered_dsr: bool,
}

pub struct Session {
    pub id: String,
    pub cwd: String,
    pub command: Option<String>,
    pub kind: &'static str,
    pub shell: String,
    pub created: u64,
    pub no_rc: bool,
    pub rc_skipped: bool,
    pub pid: Option<u32>,
    max_bytes: usize,
    state: Mutex<State>,
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    rt: tokio::runtime::Handle,
}

pub struct CreateOpts {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub title: Option<String>,
    pub shell: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub env_spec: Option<EnvSpec>,
    pub no_rc: bool,
    pub links: Option<Links>,
}

fn clamp_dim(v: Option<f64>, lo: f64, hi: f64, fallback: u16) -> u16 {
    match v {
        Some(f) if f.is_finite() && f.floor() != 0.0 => f.floor().clamp(lo, hi) as u16,
        _ => fallback,
    }
}

fn scrollback_bytes() -> usize {
    std::env::var("TERMHUB_SCROLLBACK_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n: &usize| *n > 0)
        .unwrap_or(2 * 1024 * 1024)
}

fn base_name(p: &str) -> String {
    p.rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(p)
        .to_string()
}

impl Session {
    pub fn spawn(opts: CreateOpts) -> Result<Arc<Session>, String> {
        let id = opts.id.unwrap_or_else(gen_id);
        let shell = opts
            .shell
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(spec::default_shell);
        let (cwd, cwd_notice) = spec::resolve_cwd(opts.cwd.as_deref());
        let command = opts.command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
        let kind = spec::classify_command(command.as_deref());
        let cols = opts.cols.unwrap_or(80);
        let rows = opts.rows.unwrap_or(24);
        let title = opts
            .title
            .map(|t| t.to_string())
            .filter(|t| !t.is_empty())
            .or_else(|| command.clone())
            .unwrap_or_else(|| base_name(&shell));

        // Environment: ours, minus the parent agent's identity, plus the terminal's
        // own markers, then the caller's spec, then whatever makes rc files load.
        let mut env: Vec<(String, String)> = std::env::vars().collect();
        spec::set_var(&mut env, "TERM", "xterm-256color");
        spec::set_var(&mut env, "COLORTERM", "truecolor");
        spec::set_var(&mut env, "TERMHUB_SESSION_ID", &id);
        for k in PARENT_AGENT_ENV {
            spec::remove_var(&mut env, k);
        }
        spec::apply_env_spec(&mut env, opts.env_spec.as_ref());
        let launch = spec::shell_args(&shell, opts.no_rc);
        for name in &launch.unset_env {
            spec::remove_var(&mut env, name);
        }

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty failed: {e}"))?;
        let mut cmd = CommandBuilder::new(&shell);
        cmd.args(&launch.args);
        cmd.cwd(&cwd);
        cmd.env_clear();
        for (k, v) in &env {
            cmd.env(k, v);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn {shell} failed: {e}"))?;
        // The slave end belongs to the child now; holding it would keep the
        // reader from ever seeing EOF on Linux.
        drop(pair.slave);
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("pty reader: {e}"))?;
        let mut writer = pair.master.take_writer().map_err(|e| format!("pty writer: {e}"))?;

        let now = now_ms();
        let session = Arc::new(Session {
            id,
            cwd,
            command: command.clone(),
            kind,
            shell,
            created: now,
            no_rc: opts.no_rc,
            rc_skipped: launch.rc_skipped,
            pid,
            max_bytes: scrollback_bytes(),
            state: Mutex::new(State {
                title,
                links: opts.links,
                cols,
                rows,
                alive: true,
                exit_code: None,
                exited: false,
                killed: false,
                last_activity: now,
                last_input_at: 0,
                paused: false,
                size_owner: None,
                ring: VecDeque::new(),
                ring_bytes: 0,
                clients: Vec::new(),
                client_seq: 0,
                pending_command: command,
                decoder: Utf8Stream::default(),
                answered_dsr: false,
            }),
            input: Mutex::new(None),
            master: Mutex::new(Some(pair.master)),
            killer: Mutex::new(Some(killer)),
            rt: tokio::runtime::Handle::current(),
        });

        // Writer thread.
        let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>();
        *session.input.lock().unwrap() = Some(in_tx);
        std::thread::Builder::new()
            .name("ptyd-writer".into())
            .spawn(move || {
                for chunk in in_rx {
                    if writer.write_all(&chunk).and_then(|_| writer.flush()).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        if let Some(n) = cwd_notice {
            session.notice(&format!("\x1b[33m[termhub] {n}\x1b[0m\r\n"));
        }

        // Reader thread.
        let (eof_tx, eof_rx) = mpsc::channel::<()>();
        let s = session.clone();
        std::thread::Builder::new()
            .name("ptyd-reader".into())
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => s.on_output(&buf[..n]),
                    }
                }
                let _ = eof_tx.send(());
            })
            .map_err(|e| e.to_string())?;

        // Waiter thread.
        let s = session.clone();
        std::thread::Builder::new()
            .name("ptyd-waiter".into())
            .spawn(move || {
                let status = child.wait();
                // Let the reader drain what the process printed last, so `exit`
                // follows the final output rather than racing it.
                let _ = eof_rx.recv_timeout(Duration::from_millis(300));
                let code = status.ok().map(|st| st.exit_code() as i64);
                s.handle_exit(code);
                // Closing the pseudoconsole is what ends the reader on Windows.
                s.master.lock().unwrap().take();
                s.input.lock().unwrap().take();
            })
            .map_err(|e| e.to_string())?;

        // The initial command runs *inside* the shell once it has drawn a prompt
        // (or after a fallback delay if it never prints anything).
        if session.state.lock().unwrap().pending_command.is_some() {
            let s = session.clone();
            session.rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis(COMMAND_FALLBACK_MS)).await;
                s.maybe_run_command();
            });
        }
        Ok(session)
    }

    fn maybe_run_command(self: &Arc<Self>) {
        let cmd = {
            let mut st = self.state.lock().unwrap();
            if !st.alive {
                return;
            }
            match st.pending_command.take() {
                Some(c) => c,
                None => return,
            }
        };
        let s = self.clone();
        self.rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(COMMAND_SETTLE_MS)).await;
            if s.state.lock().unwrap().alive {
                s.send_input(format!("{cmd}\r").into_bytes());
            }
        });
    }

    fn on_output(self: &Arc<Self>, bytes: &[u8]) {
        let run_cmd;
        {
            let mut st = self.state.lock().unwrap();
            let mut text = st.decoder.push(bytes);
            // ConPTY (opened with PSEUDOCONSOLE_INHERIT_CURSOR by portable-pty)
            // starts by asking where the cursor is and draws nothing until it is
            // told. A browser would answer, but a session nobody is watching yet
            // (one the personal assistant starts) would sit blank forever, so the
            // first query is answered here: top-left, a fresh screen.
            if cfg!(windows) && !st.answered_dsr {
                if let Some(at) = text.find("\x1b[6n") {
                    st.answered_dsr = true;
                    text.replace_range(at..at + 4, "");
                    self.send_input(b"\x1b[1;1R".to_vec());
                }
            }
            if text.is_empty() {
                return;
            }
            st.last_activity = now_ms();
            // Only text the shell printed counts as "it has started": ConPTY's
            // own opening mode switches arrive before the shell exists, and a
            // command typed then lands in a half-started PSReadLine.
            run_cmd = st.pending_command.is_some() && has_visible_text(&text);
            self.buffer_locked(&mut st, &text);
            broadcast_locked(&mut st, &json!({"type": "output", "data": text}));
        }
        if run_cmd {
            self.maybe_run_command();
        }
    }

    fn buffer_locked(&self, st: &mut State, text: &str) {
        st.ring_bytes += text.len();
        st.ring.push_back(text.to_string());
        while st.ring_bytes > self.max_bytes && st.ring.len() > 1 {
            if let Some(old) = st.ring.pop_front() {
                st.ring_bytes -= old.len();
            }
        }
    }

    fn handle_exit(&self, code: Option<i64>) {
        let mut st = self.state.lock().unwrap();
        if st.exited {
            return;
        }
        st.exited = true;
        st.alive = false;
        // A killed session reports no code, as sessiond's tree kill does.
        st.exit_code = if st.killed { None } else { code };
        let msg = json!({"type": "exit", "code": st.exit_code});
        broadcast_locked(&mut st, &msg);
    }

    fn send_input(&self, bytes: Vec<u8>) {
        if let Some(tx) = self.input.lock().unwrap().as_ref() {
            let _ = tx.send(bytes);
        }
    }

    /// Input from a client (websocket or POST /input).
    pub fn write(&self, data: &str) {
        {
            let mut st = self.state.lock().unwrap();
            if !st.alive {
                return;
            }
            st.last_input_at = now_ms();
        }
        self.send_input(data.as_bytes().to_vec());
    }

    /// Print a line into the terminal (and its replay) without sending it to the shell.
    pub fn notice(&self, text: &str) {
        let msg = if text.ends_with("\r\n") {
            text.to_string()
        } else {
            format!("{text}\r\n")
        };
        let mut st = self.state.lock().unwrap();
        self.buffer_locked(&mut st, &msg);
        broadcast_locked(&mut st, &json!({"type": "output", "data": msg}));
    }

    /// Attach a client: it is sent the replay first, then live output.
    pub fn attach(&self) -> (String, UnboundedReceiver<String>) {
        let (tx, rx) = unbounded_channel();
        let mut st = self.state.lock().unwrap();
        st.client_seq += 1;
        let cid = format!("c{}", st.client_seq);
        let data: String = st.ring.iter().map(String::as_str).collect();
        let replay = json!({
            "type": "replay", "data": data, "cols": st.cols, "rows": st.rows,
            "you": cid, "owner": st.size_owner, "screen": "raw",
        });
        let _ = tx.send(replay.to_string());
        if !st.alive {
            let _ = tx.send(json!({"type": "exit", "code": st.exit_code}).to_string());
        }
        st.clients.push(Client { id: cid.clone(), tx });
        (cid, rx)
    }

    pub fn detach(&self, cid: &str) {
        let mut st = self.state.lock().unwrap();
        st.clients.retain(|c| c.id != cid);
        if st.size_owner.as_deref() == Some(cid) {
            st.size_owner = None;
            let msg = json!({"type": "size", "cols": st.cols, "rows": st.rows, "owner": Value::Null});
            broadcast_locked(&mut st, &msg);
        }
    }

    /// A resize from client `by` is a claim on the size; every client is told.
    pub fn resize(&self, cols: Option<f64>, rows: Option<f64>, by: Option<&str>) {
        let mut st = self.state.lock().unwrap();
        let cols = clamp_dim(cols, 2.0, 1000.0, st.cols);
        let rows = clamp_dim(rows, 1.0, 500.0, st.rows);
        let changed = cols != st.cols || rows != st.rows;
        st.cols = cols;
        st.rows = rows;
        if let Some(by) = by {
            st.size_owner = Some(by.to_string());
        }
        // A same-size resize still moves ownership but never reaches the PTY: a
        // no-op ConPTY resize can make a TUI repaint for nothing.
        if changed && st.alive {
            if let Some(m) = self.master.lock().unwrap().as_ref() {
                let _ = m.resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }
        let msg = json!({"type": "size", "cols": cols, "rows": rows, "owner": st.size_owner});
        broadcast_locked(&mut st, &msg);
    }

    pub fn rename(&self, title: &Value) {
        if let Some(t) = title.as_str().map(str::trim).filter(|t| !t.is_empty()) {
            self.state.lock().unwrap().title = t.to_string();
        } else if let Value::Number(n) = title {
            self.state.lock().unwrap().title = n.to_string();
        }
    }

    pub fn links(&self) -> Option<Links> {
        self.state.lock().unwrap().links.clone()
    }

    pub fn set_links(&self, links: Option<Links>) {
        self.state.lock().unwrap().links = links;
    }

    pub fn set_paused(&self, v: &Value) {
        let truthy = match v {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(false),
            Value::String(s) => !s.is_empty(),
            _ => true,
        };
        self.state.lock().unwrap().paused = truthy;
    }

    pub fn is_alive(&self) -> bool {
        self.state.lock().unwrap().alive
    }

    /// End the session: the whole process tree, then the PTY. Blocking (up to a
    /// few seconds on Windows); call from a blocking context.
    pub fn kill(&self) {
        {
            let mut st = self.state.lock().unwrap();
            if !st.alive {
                return;
            }
            st.killed = true;
        }
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        if let Some(k) = self.killer.lock().unwrap().as_mut() {
            let _ = k.kill();
        }
        // Don't leave the caller guessing whether the exit has been seen.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while self.is_alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if self.is_alive() {
            self.handle_exit(None);
            self.master.lock().unwrap().take();
        }
    }

    pub fn info(&self) -> Value {
        let st = self.state.lock().unwrap();
        let busy = st.alive && now_ms().saturating_sub(st.last_activity) < BUSY_MS;
        json!({
            "id": self.id,
            "title": st.title,
            "links": st.links,
            "cwd": self.cwd,
            "command": self.command,
            "kind": self.kind,
            "shell": self.shell,
            "cols": st.cols,
            "rows": st.rows,
            "created": self.created,
            "alive": st.alive,
            "exitCode": st.exit_code,
            "busy": busy,
            "voiceArmed": false,
            "paused": st.paused,
            "canSpeak": false,
            "model": Value::Null,
            "modelLabel": Value::Null,
            // ptyd extensions (sessiond leaves these out): what a supervisor that
            // re-adopts the terminal after its own restart needs.
            "pid": self.pid,
            "lastActivity": st.last_activity,
            "lastInputAt": st.last_input_at,
            "noRc": self.no_rc,
        })
    }
}

/// True when `text` holds a printable character outside escape sequences.
fn has_visible_text(text: &str) -> bool {
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                // CSI: parameters/intermediates up to a final byte @..~
                Some('[') => {
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ST (ESC \)
                Some(']') => {
                    while let Some(d) = chars.next() {
                        if d == '\x07' {
                            break;
                        }
                        if d == '\x1b' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if !c.is_control() {
            return true;
        }
    }
    false
}

fn broadcast_locked(st: &mut State, msg: &Value) {
    let text = msg.to_string();
    st.clients.retain(|c| c.tx.send(text.clone()).is_ok());
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    // The shell leads its own session and process group (setsid on the PTY), so
    // the group is everything it started in the foreground.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGHUP);
    }
}

/// Body helpers shared with the HTTP layer.
pub fn body_u16(body: &Map<String, Value>, key: &str, lo: f64, hi: f64) -> Option<u16> {
    let f = body.get(key)?.as_f64()?;
    if !f.is_finite() || f.floor() == 0.0 {
        return None;
    }
    Some(f.floor().clamp(lo, hi) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_reads() {
        let mut d = Utf8Stream::default();
        let bytes = "h\u{e9}llo \u{2014}".as_bytes();
        let (a, b) = bytes.split_at(2); // splits the é
        let mut s = d.push(a);
        s.push_str(&d.push(b));
        assert_eq!(s, "h\u{e9}llo \u{2014}");
        assert_eq!(d.push(&[0xff, b'x']), "\u{FFFD}x");
    }

    #[test]
    fn visible_text() {
        assert!(!has_visible_text("\x1b[?9001h\x1b[?1004h"));
        assert!(!has_visible_text("\x1b[m\x1b]0;C:\\x\\powershell.EXE\x07\x1b[?25h\r\n"));
        assert!(has_visible_text("\x1b[mPS C:\\> "));
        assert!(has_visible_text("$ "));
    }

    #[test]
    fn ids() {
        let a = gen_id();
        let b = gen_id();
        assert_ne!(a, b);
        assert!(a.starts_with('s') && valid_id(&a));
        assert!(!valid_id("../x"));
        assert_eq!(base36(35), "z");
    }
}
