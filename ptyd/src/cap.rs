//! CPU cap configuration for the sessions' shared "agents" job (Windows; the
//! parsing is platform-independent so it is tested everywhere).
//!
//! Agents run `dotnet build`, which starts one MSBuild node per logical CPU and
//! saturates the machine; ptyd puts every session under one hard CPU-rate cap
//! (see job.rs) so the desktop stays responsive.

#![cfg_attr(not(windows), allow(dead_code))]

pub const DEFAULT_CAP_PCT: u32 = 75;
pub const MIN_CAP_PCT: u32 = 5;
pub const MAX_CAP_PCT: u32 = 100;

/// Parse a cap setting: `None` (unset or empty) is the default, `0`/`off`/
/// `false`/`no`/`none`/`disable(d)` disables, a number is clamped to 5..=100.
/// `Ok(None)` = disabled; `Err` = unparseable (caller logs and uses the default).
pub fn parse_cap(raw: Option<&str>) -> Result<Option<u32>, String> {
    let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(Some(DEFAULT_CAP_PCT));
    };
    let s = s.trim_end_matches('%').trim();
    match s.to_ascii_lowercase().as_str() {
        "off" | "false" | "no" | "none" | "disable" | "disabled" => return Ok(None),
        _ => {}
    }
    match s.parse::<u32>() {
        Ok(0) => Ok(None),
        Ok(n) => Ok(Some(n.clamp(MIN_CAP_PCT, MAX_CAP_PCT))),
        Err(_) => Err(format!("unreadable CPU cap {raw:?}")),
    }
}

/// The effective cap: `--cpu-cap X` / `--cpu-cap=X` wins over `PTYD_CPU_CAP_PCT`.
pub fn resolve(args: &[String], env: Option<&str>) -> Option<u32> {
    let mut flag: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--cpu-cap" && i + 1 < args.len() {
            flag = Some(&args[i + 1]);
            i += 1;
        } else if let Some(v) = args[i].strip_prefix("--cpu-cap=") {
            flag = Some(v);
        }
        i += 1;
    }
    match parse_cap(flag.or(env)) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[ptyd] {e}; using the default {DEFAULT_CAP_PCT}%");
            Some(DEFAULT_CAP_PCT)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_when_unset_or_blank() {
        assert_eq!(parse_cap(None), Ok(Some(75)));
        assert_eq!(parse_cap(Some("  ")), Ok(Some(75)));
    }

    #[test]
    fn off_and_zero_disable() {
        for v in ["0", "off", "OFF", " Off ", "false", "none"] {
            assert_eq!(parse_cap(Some(v)), Ok(None), "{v}");
        }
    }

    #[test]
    fn numbers_clamp() {
        assert_eq!(parse_cap(Some("50")), Ok(Some(50)));
        assert_eq!(parse_cap(Some("60%")), Ok(Some(60)));
        assert_eq!(parse_cap(Some("1")), Ok(Some(5)));
        assert_eq!(parse_cap(Some("250")), Ok(Some(100)));
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(parse_cap(Some("lots")).is_err());
        assert!(parse_cap(Some("-3")).is_err());
    }

    #[test]
    fn flag_beats_env() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(resolve(&a(&["ptyd", "--cpu-cap", "40"]), Some("90")), Some(40));
        assert_eq!(resolve(&a(&["ptyd", "--cpu-cap=off"]), Some("90")), None);
        assert_eq!(resolve(&a(&["ptyd"]), Some("90")), Some(90));
        assert_eq!(resolve(&a(&["ptyd"]), None), Some(75));
        assert_eq!(resolve(&a(&["ptyd", "--cpu-cap=x"]), None), Some(75));
    }
}
