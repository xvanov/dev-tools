//! The pure parts of a session request, ported from termhub's lib/ (sessionEnv.js,
//! shell.js, sessionLinks.js, session.js). Same rules, same error strings: the
//! conformance suite (termhub/test/ptydConformance.test.js) holds both to them.

use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ---- env spec (lib/sessionEnv.js) -------------------------------------------

const MAX_VARS: usize = 64;
const MAX_VALUE: usize = 4096;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EnvSpec {
    pub env: BTreeMap<String, String>,
    pub unset: Vec<String>,
}

fn is_var_name(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// `env` / `unsetEnv` of a create body. Ok(None) when neither was given.
pub fn parse_env_spec(body: &Map<String, Value>) -> Result<Option<EnvSpec>, String> {
    let env = body.get("env").filter(|v| !v.is_null());
    let unset = body.get("unsetEnv").filter(|v| !v.is_null());
    if env.is_none() && unset.is_none() {
        return Ok(None);
    }
    let mut spec = EnvSpec::default();
    if let Some(env) = env {
        let obj = env.as_object().ok_or("env must be an object of strings")?;
        if obj.len() > MAX_VARS {
            return Err(format!("env: at most {MAX_VARS} variables"));
        }
        for (k, v) in obj {
            if !is_var_name(k) {
                return Err(format!("env: bad variable name \"{}\"", clip(k, 64)));
            }
            match v.as_str() {
                Some(s) if s.encode_utf16().count() <= MAX_VALUE && !s.contains('\0') => {
                    spec.env.insert(k.clone(), s.to_string());
                }
                _ => return Err(format!("env: {k} must be a string")),
            }
        }
    }
    if let Some(unset) = unset {
        let arr = match unset.as_array() {
            Some(a) if a.len() <= MAX_VARS => a,
            _ => return Err(format!("unsetEnv must be an array of at most {MAX_VARS} names")),
        };
        for k in arr {
            match k.as_str() {
                Some(s) if is_var_name(s) => spec.unset.push(s.to_string()),
                _ => {
                    let shown = match k {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    return Err(format!("unsetEnv: bad variable name \"{}\"", clip(&shown, 64)));
                }
            }
        }
    }
    Ok(Some(spec))
}

/// Remove `name` from `env`, case-insensitively on Windows.
pub fn remove_var(env: &mut Vec<(String, String)>, name: &str) {
    let fold = cfg!(windows);
    env.retain(|(k, _)| !(k == name || (fold && k.eq_ignore_ascii_case(name))));
}

pub fn set_var(env: &mut Vec<(String, String)>, name: &str, value: &str) {
    remove_var(env, name);
    env.push((name.to_string(), value.to_string()));
}

/// `base` with `spec` applied: removals first, then sets.
pub fn apply_env_spec(env: &mut Vec<(String, String)>, spec: Option<&EnvSpec>) {
    let Some(spec) = spec else { return };
    for name in spec.unset.iter().chain(spec.env.keys()) {
        remove_var(env, name);
    }
    for (k, v) in &spec.env {
        env.push((k.clone(), v.clone()));
    }
}

/// `noRc`: absent/null -> (false, given=false); non-boolean -> error.
pub fn parse_no_rc(body: &Map<String, Value>) -> Result<(bool, bool), String> {
    match body.get("noRc") {
        None | Some(Value::Null) => Ok((false, false)),
        Some(Value::Bool(b)) => Ok((*b, true)),
        Some(_) => Err("noRc must be a boolean".into()),
    }
}

// ---- shell (lib/shell.js) ----------------------------------------------------

pub struct ShellLaunch {
    pub args: Vec<String>,
    pub unset_env: Vec<String>,
    pub rc_skipped: bool,
}

pub fn shell_args(shell: &str, no_rc: bool) -> ShellLaunch {
    let none = ShellLaunch {
        args: vec![],
        unset_env: vec![],
        rc_skipped: false,
    };
    if !no_rc {
        return none;
    }
    let norm = shell.replace('\\', "/");
    let base = norm.rsplit('/').next().unwrap_or("").to_lowercase();
    let name = base.strip_suffix(".exe").unwrap_or(&base);
    let (args, unset): (&[&str], &[&str]) = match name {
        "bash" => (&["--norc", "--noprofile"], &["BASH_ENV", "ENV"]),
        "zsh" => (&["-f"], &[]),
        "fish" => (&["--no-config"], &[]),
        "pwsh" | "powershell" => (&["-NoProfile"], &[]),
        "sh" | "dash" => (&[], &["ENV"]),
        "cmd" => (&["/D"], &[]),
        _ => return none,
    };
    ShellLaunch {
        args: args.iter().map(|s| s.to_string()).collect(),
        unset_env: unset.iter().map(|s| s.to_string()).collect(),
        rc_skipped: true,
    }
}

fn find_on_path(names: &[&str]) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for name in names {
        for dir in std::env::split_paths(&path) {
            for ext in &exts {
                let candidate = dir.join(format!("{name}{ext}"));
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

pub fn default_shell() -> String {
    if let Ok(s) = std::env::var("TERMHUB_SHELL") {
        if !s.is_empty() {
            return s;
        }
    }
    if cfg!(windows) {
        return find_on_path(&["pwsh"])
            .or_else(|| find_on_path(&["powershell"]))
            .or_else(|| std::env::var("COMSPEC").ok())
            .unwrap_or_else(|| "powershell.exe".into());
    }
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| find_on_path(&["bash"]))
        .unwrap_or_else(|| "/bin/bash".into())
}

// ---- cwd (lib/session.js resolveCwd) -----------------------------------------

pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn absolutize(p: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(p)
    };
    // Lexical normalisation, like path.resolve: drop `.`, fold `..`.
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// (cwd, notice). A missing or non-directory cwd falls back to home with a notice.
pub fn resolve_cwd(input: Option<&str>) -> (String, Option<String>) {
    let home = home_dir();
    let home_s = home.to_string_lossy().into_owned();
    let dir = input.map(str::trim).unwrap_or("");
    if dir.is_empty() {
        return (home_s, None);
    }
    let path = if dir == "~" {
        home.clone()
    } else if let Some(rest) = dir.strip_prefix("~/").or_else(|| dir.strip_prefix("~\\")) {
        home.join(rest)
    } else {
        PathBuf::from(dir)
    };
    let abs = absolutize(&path);
    let abs_s = abs.to_string_lossy().into_owned();
    match std::fs::metadata(&abs) {
        Ok(m) if m.is_dir() => (abs_s, None),
        Ok(_) => (
            home_s.clone(),
            Some(format!("'{abs_s}' is not a directory \u{2014} starting in {home_s}")),
        ),
        Err(_) => (
            home_s.clone(),
            Some(format!("directory '{abs_s}' not found \u{2014} starting in {home_s}")),
        ),
    }
}

// ---- command classification (lib/session.js classifyCommand) ------------------

fn first_token(command: &str) -> String {
    let s = command.trim();
    let mut chars = s.chars();
    match chars.next() {
        Some(q @ ('"' | '\'')) => {
            let rest: String = chars.collect();
            match rest.find(q) {
                Some(end) => rest[..end].to_string(),
                None => rest,
            }
        }
        _ => s.split_whitespace().next().unwrap_or("").to_string(),
    }
}

fn base_name(tok: &str) -> String {
    tok.rsplit(['/', '\\']).next().unwrap_or(tok).to_lowercase()
}

fn strip_ext<'a>(base: &'a str, exts: &[&str]) -> &'a str {
    for e in exts {
        if let Some(s) = base.strip_suffix(e) {
            return s;
        }
    }
    base
}

pub fn classify_command(command: Option<&str>) -> &'static str {
    let Some(cmd) = command else { return "shell" };
    let tok = first_token(cmd);
    let base = base_name(&tok);
    match strip_ext(&base, &[".exe", ".cmd"]) {
        "claude" => return "claude",
        "opencode" => return "opencode",
        _ => {}
    }
    let b = strip_ext(&base, &[".exe", ".cmd", ".ps1"]);
    if b == "cursor-agent" || b == "agent" {
        return "cursor";
    }
    "shell"
}

// ---- links (lib/sessionLinks.js) ---------------------------------------------

pub const LINK_KEYS: [&str; 7] = ["card", "run", "job", "step", "story", "external", "pr"];

fn is_id(s: &str) -> bool {
    let n = s.chars().count();
    (1..=128).contains(&n)
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '@' | '-'))
}

fn is_url(s: &str) -> bool {
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://"));
    match rest {
        Some(r) => {
            let n = r.chars().count();
            (1..=400).contains(&n)
                && !r
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
        }
        None => false,
    }
}

fn clean_link(key: &str, v: &Value) -> Option<String> {
    let s = match v {
        Value::Number(n) => {
            let f = n.as_f64()?;
            if !f.is_finite() {
                return None;
            }
            // String(n) in JS: integers print without a fraction.
            if f.fract() == 0.0 && f.abs() < 1e21 {
                format!("{}", f as i64)
            } else {
                n.to_string()
            }
        }
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let s = s.trim().to_string();
    if key == "pr" && is_url(&s) {
        return Some(s);
    }
    if is_id(&s) {
        Some(s)
    } else {
        None
    }
}

pub type Links = Map<String, Value>;

pub fn parse_links(raw: Option<&Value>) -> Option<Links> {
    let obj = raw?.as_object()?;
    let mut out = Map::new();
    for k in LINK_KEYS {
        if let Some(v) = obj.get(k) {
            if let Some(c) = clean_link(k, v) {
                out.insert(k.to_string(), Value::String(c));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn merge_links(prev: Option<&Links>, raw: &Value) -> Option<Links> {
    let mut out = prev.cloned().unwrap_or_default();
    if let Some(obj) = raw.as_object() {
        for k in LINK_KEYS {
            match obj.get(k) {
                None => {}
                Some(Value::Null) => {
                    out.remove(k);
                }
                Some(v) => {
                    if let Some(c) = clean_link(k, v) {
                        out.insert(k.to_string(), Value::String(c));
                    }
                }
            }
        }
    }
    // Keep LINK_KEYS order, like the JS object built key by key.
    let mut ordered = Map::new();
    for k in LINK_KEYS {
        if let Some(v) = out.remove(k) {
            ordered.insert(k.to_string(), v);
        }
    }
    if ordered.is_empty() {
        None
    } else {
        Some(ordered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn env_spec_rules() {
        assert_eq!(parse_env_spec(&obj(json!({}))).unwrap(), None);
        let s = parse_env_spec(&obj(json!({"env": {"A": "1"}, "unsetEnv": ["B"]})))
            .unwrap()
            .unwrap();
        assert_eq!(s.env.get("A").unwrap(), "1");
        assert_eq!(s.unset, vec!["B"]);
        assert_eq!(
            parse_env_spec(&obj(json!({"env": [1]}))).unwrap_err(),
            "env must be an object of strings"
        );
        assert_eq!(
            parse_env_spec(&obj(json!({"env": {"1A": "x"}}))).unwrap_err(),
            "env: bad variable name \"1A\""
        );
        assert_eq!(
            parse_env_spec(&obj(json!({"env": {"A": 1}}))).unwrap_err(),
            "env: A must be a string"
        );
        assert!(parse_env_spec(&obj(json!({"unsetEnv": "A"}))).is_err());
        assert_eq!(
            parse_env_spec(&obj(json!({"unsetEnv": [3]}))).unwrap_err(),
            "unsetEnv: bad variable name \"3\""
        );
    }

    #[test]
    fn apply_env_removes_then_sets() {
        let mut env = vec![("GH_TOKEN".into(), "x".into()), ("KEEP".into(), "1".into())];
        let spec = EnvSpec {
            env: [("NEW".to_string(), "v".to_string())].into(),
            unset: vec!["GH_TOKEN".into()],
        };
        apply_env_spec(&mut env, Some(&spec));
        assert!(env.iter().all(|(k, _)| k != "GH_TOKEN"));
        assert!(env.contains(&("NEW".into(), "v".into())));
    }

    #[test]
    fn no_rc() {
        assert_eq!(parse_no_rc(&obj(json!({}))).unwrap(), (false, false));
        assert_eq!(parse_no_rc(&obj(json!({"noRc": true}))).unwrap(), (true, true));
        assert!(parse_no_rc(&obj(json!({"noRc": "yes"}))).is_err());
        let l = shell_args("/bin/bash", true);
        assert_eq!(l.args, vec!["--norc", "--noprofile"]);
        assert!(l.rc_skipped);
        assert!(shell_args("C:\\x\\pwsh.exe", true).rc_skipped);
        assert!(!shell_args("/usr/bin/xonsh", true).rc_skipped);
        assert!(!shell_args("/bin/bash", false).rc_skipped);
    }

    #[test]
    fn classify() {
        assert_eq!(classify_command(None), "shell");
        assert_eq!(classify_command(Some("claude --x")), "claude");
        assert_eq!(classify_command(Some("\"C:\\a b\\claude.exe\" -p")), "claude");
        assert_eq!(classify_command(Some("opencode")), "opencode");
        assert_eq!(classify_command(Some("cursor-agent")), "cursor");
        assert_eq!(classify_command(Some("git pull && claude update")), "shell");
        assert_eq!(classify_command(Some("myclaude")), "shell");
    }

    #[test]
    fn links() {
        let l = parse_links(Some(
            &json!({"card": 12, "bogus": "x", "job": "bad value!", "pr": "https://github.com/o/r/pull/1"}),
        ))
        .unwrap();
        assert_eq!(l.get("card").unwrap(), "12");
        assert!(l.get("bogus").is_none() && l.get("job").is_none());
        assert_eq!(parse_links(Some(&json!({"x": 1}))), None);
        let m = merge_links(Some(&l), &json!({"card": null, "run": "r1"})).unwrap();
        assert!(m.get("card").is_none());
        assert_eq!(m.get("run").unwrap(), "r1");
    }

    #[test]
    fn cwd_fallback() {
        let (cwd, notice) = resolve_cwd(Some("/definitely/not/here/ptyd"));
        assert_eq!(cwd, home_dir().to_string_lossy());
        assert!(notice.unwrap().contains("not found"));
        assert_eq!(resolve_cwd(None).1, None);
    }
}
