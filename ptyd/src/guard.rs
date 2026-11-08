//! The request guard (termhub lib/requestGuard.js), minus what only matters on a
//! tailnet-facing tier: ptyd binds loopback, so `Host` must be loopback, an IP
//! literal, this machine's name or one in TERMHUB_ALLOWED_HOSTS.

use axum::http::{HeaderMap, Method};

pub struct Refusal {
    pub status: u16,
    pub error: String,
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

pub fn hostname_of(host: &str) -> String {
    let h = host.trim().to_lowercase();
    if let Some(rest) = h.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("").to_string();
    }
    match (h.find(':'), h.rfind(':')) {
        (Some(a), Some(b)) if a == b && a > 0 => h[..a].to_string(),
        _ => h,
    }
}

pub fn machine_name() -> String {
    if let Ok(m) = std::env::var("TERMHUB_MACHINE") {
        if !m.is_empty() {
            return m;
        }
    }
    if let Ok(c) = std::env::var("COMPUTERNAME") {
        if !c.is_empty() {
            return c;
        }
    }
    if let Ok(h) = std::fs::read_to_string("/proc/sys/kernel/hostname") {
        let h = h.trim();
        if !h.is_empty() {
            return h.to_string();
        }
    }
    std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into())
}

fn host_allowed(host: &str) -> bool {
    let name = hostname_of(host);
    if name.is_empty() {
        return false;
    }
    if name.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    let name = name.trim_end_matches('.').to_string();
    let mut allowed = vec!["localhost".to_string()];
    for n in [
        Some(machine_name()),
        std::env::var("COMPUTERNAME").ok(),
        std::env::var("TERMHUB_MACHINE").ok(),
    ]
    .into_iter()
    .flatten()
    {
        let n = n.to_lowercase();
        allowed.push(n.split('.').next().unwrap_or("").to_string());
        allowed.push(n);
    }
    for n in std::env::var("TERMHUB_ALLOWED_HOSTS").unwrap_or_default().split(',') {
        let n = n.trim().to_lowercase();
        if !n.is_empty() {
            allowed.push(n);
        }
    }
    allowed.contains(&name)
}

fn origin_host(origin: &str) -> Option<String> {
    let rest = origin.split_once("://")?.1;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_lowercase())
    }
}

fn check_host_and_origin(h: &HeaderMap) -> Option<Refusal> {
    let host = header(h, "host").unwrap_or("");
    if !host_allowed(host) {
        return Some(Refusal {
            status: 403,
            error: format!("Host \"{host}\" is not this machine (set TERMHUB_ALLOWED_HOSTS to allow another name)"),
        });
    }
    if let Some(origin) = header(h, "origin") {
        if !origin.is_empty() && origin_host(origin).as_deref() != Some(host.to_lowercase().as_str()) {
            return Some(Refusal {
                status: 403,
                error: "cross-origin request refused".into(),
            });
        }
    }
    None
}

pub fn check_request(method: &Method, path: &str, h: &HeaderMap) -> Option<Refusal> {
    if !path.starts_with("/api/") || method == Method::OPTIONS {
        return None;
    }
    if let Some(r) = check_host_and_origin(h) {
        return Some(r);
    }
    if method == Method::GET || method == Method::HEAD {
        return None;
    }
    if header(h, "x-termhub") != Some("1") {
        return Some(Refusal {
            status: 403,
            error: "missing X-Termhub: 1 header".into(),
        });
    }
    let ty = header(h, "content-type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if matches!(
        ty.as_str(),
        "text/plain" | "application/x-www-form-urlencoded" | "multipart/form-data"
    ) {
        return Some(Refusal {
            status: 415,
            error: format!("Content-Type {ty} is not accepted (send application/json)"),
        });
    }
    None
}

pub fn check_upgrade(h: &HeaderMap) -> Option<Refusal> {
    check_host_and_origin(h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hm(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn rules() {
        assert_eq!(hostname_of("[::1]:7000"), "::1");
        assert_eq!(hostname_of("127.0.0.1:7020"), "127.0.0.1");
        let ok = hm(&[
            ("host", "127.0.0.1:1"),
            ("x-termhub", "1"),
            ("content-type", "application/json"),
        ]);
        assert!(check_request(&Method::POST, "/api/sessions", &ok).is_none());
        let no_hdr = hm(&[("host", "127.0.0.1:1")]);
        assert_eq!(
            check_request(&Method::POST, "/api/sessions", &no_hdr).unwrap().status,
            403
        );
        assert!(check_request(&Method::GET, "/api/sessions", &no_hdr).is_none());
        let plain = hm(&[
            ("host", "127.0.0.1:1"),
            ("x-termhub", "1"),
            ("content-type", "text/plain"),
        ]);
        assert_eq!(
            check_request(&Method::POST, "/api/sessions", &plain).unwrap().status,
            415
        );
        let evil = hm(&[("host", "evil.example")]);
        assert_eq!(check_request(&Method::GET, "/api/sessions", &evil).unwrap().status, 403);
        let xorigin = hm(&[("host", "127.0.0.1:1"), ("origin", "http://evil.example")]);
        assert_eq!(check_upgrade(&xorigin).unwrap().status, 403);
        let same = hm(&[("host", "127.0.0.1:1"), ("origin", "http://127.0.0.1:1")]);
        assert!(check_upgrade(&same).is_none());
    }
}
