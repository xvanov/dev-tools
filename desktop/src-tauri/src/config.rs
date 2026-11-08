//! The stacks the shell can open (work, personal) and which one is active.
//! Stored as `stacks.json` in the app's config dir. Pure apart from load/save.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Stack {
    /// Shown in the tray and the settings window.
    pub name: String,
    /// The browser shell to open: a termhub front (the PA is under its /pa/).
    /// Empty = not configured yet.
    #[serde(default)]
    pub url: String,
    /// The PA event stream; default `<url>/pa/api/events` (termhub's PA proxy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Config {
    pub active: String,
    pub stacks: BTreeMap<String, Stack>,
    /// OS notifications from the event stream.
    #[serde(default = "yes")]
    pub notifications: bool,
}

fn yes() -> bool {
    true
}

impl Default for Config {
    /// Work points at the local termhub; personal is left for the user to fill
    /// in (its address is a tailnet name, which this public repo never carries).
    fn default() -> Self {
        let mut stacks = BTreeMap::new();
        stacks.insert(
            "work".into(),
            Stack {
                name: "Work".into(),
                url: "http://127.0.0.1:7000/".into(),
                events: None,
            },
        );
        stacks.insert(
            "personal".into(),
            Stack {
                name: "Personal".into(),
                url: String::new(),
                events: None,
            },
        );
        Config {
            active: "work".into(),
            stacks,
            notifications: true,
        }
    }
}

/// An http(s) URL with a host, or an error saying why not.
pub fn check_url(url: &str) -> Result<String, String> {
    let u = url.trim();
    if u.is_empty() {
        return Ok(String::new());
    }
    let rest = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .ok_or("the address must start with http:// or https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err("the address has no host".into());
    }
    Ok(u.to_string())
}

/// Stack ids: what the per-stack data directory is named after.
pub fn check_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl Stack {
    pub fn events_url(&self) -> Option<String> {
        if let Some(e) = self.events.as_ref().filter(|e| !e.trim().is_empty()) {
            return Some(e.trim().to_string());
        }
        if self.url.trim().is_empty() {
            return None;
        }
        let base = self
            .url
            .trim()
            .split(['?', '#'])
            .next()
            .unwrap_or("")
            .trim_end_matches('/');
        Some(format!("{base}/pa/api/events?topics=board,run"))
    }
}

impl Config {
    pub fn active_stack(&self) -> Option<&Stack> {
        self.stacks.get(&self.active)
    }

    /// Repair what a hand edit could break: an unknown active id, bad ids.
    pub fn normalized(mut self) -> Self {
        self.stacks.retain(|id, _| check_id(id));
        if self.stacks.is_empty() {
            return Config::default();
        }
        if !self.stacks.contains_key(&self.active) {
            self.active = self.stacks.keys().next().cloned().unwrap_or_default();
        }
        self
    }

    pub fn load(path: &Path) -> Config {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Config>(&s).ok())
            .map(Config::normalized)
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_events_url() {
        let c = Config::default();
        assert_eq!(c.active, "work");
        assert_eq!(
            c.active_stack().unwrap().events_url().unwrap(),
            "http://127.0.0.1:7000/pa/api/events?topics=board,run"
        );
        assert_eq!(c.stacks["personal"].events_url(), None);
        let s = Stack {
            name: "x".into(),
            url: "http://h/".into(),
            events: Some("http://h:7300/api/events".into()),
        };
        assert_eq!(s.events_url().unwrap(), "http://h:7300/api/events");
    }

    #[test]
    fn urls_and_ids() {
        assert!(check_url("ftp://x").is_err());
        assert!(check_url("http:///nohost").is_err());
        assert_eq!(check_url(" https://box:7443/ ").unwrap(), "https://box:7443/");
        assert_eq!(check_url("").unwrap(), "");
        assert!(check_id("work") && check_id("lab-2"));
        assert!(!check_id("../x") && !check_id("Work"));
    }

    #[test]
    fn normalize_and_roundtrip() {
        let c = Config {
            active: "gone".into(),
            ..Config::default()
        };
        assert_eq!(c.normalized().active, "personal"); // first key in order
        let dir = std::env::temp_dir().join(format!("jarvis-desktop-test-{}", std::process::id()));
        let p = dir.join("stacks.json");
        let c = Config::default();
        c.save(&p).unwrap();
        assert_eq!(Config::load(&p), c);
        std::fs::write(&p, "{broken").unwrap();
        assert_eq!(Config::load(&p), Config::default());
        let _ = std::fs::remove_dir_all(dir);
    }
}
