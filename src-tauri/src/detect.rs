//! Automatic environment detection for first launch.
//!
//! The desktop app never shows folder-selection dialogs. On any launch where
//! no valid settings are persisted, the OpenCode config directory and the
//! project directory are derived from (in order):
//!
//! OpenCode config directory:
//!   1. inherited non-empty absolute existing `OPENCODE_CONFIG_DIR`;
//!   2. `$XDG_CONFIG_HOME/opencode` when XDG_CONFIG_HOME is non-empty;
//!   3. `~/.config/opencode` on macOS/Windows/Linux.
//! The conventional default ((2) or (3)) is canonicalized and CREATED when
//! missing (never prompts); only genuine filesystem errors fail launch.
//!
//! Project directory:
//!   1. inherited non-empty absolute existing `OMO_CP_PROJECT_DIR`;
//!   2. first explicit launch argument resolving to an existing directory
//!      (argv[0] and `-`/`--` flags are ignored), including macOS Finder
//!      drops passed as arguments;
//!   3. an actively running OpenCode at `127.0.0.1:4096` — bounded loopback
//!      GET `/path`; JSON field `directory` is preferred over `worktree`;
//!      only absolute existing directories are accepted. When an inherited
//!      `OPENCODE_SERVER_PASSWORD` is present, OpenCode Basic auth is used
//!      with the inherited `OPENCODE_SERVER_USERNAME` or the official
//!      default username `opencode`;
//!   4. process cwd only when it is an existing high-confidence workspace
//!      (contains `.git`, `.opencode`, or `package.json`) and is not the app
//!      bundle/sidecar runtime directory (GUI launches would otherwise adopt
//!      `Contents/MacOS` or the staged runtime);
//!   5. user home as the final existing fallback.
//!
//! Everything here is prompt-free; the pure helpers are unit-tested.

use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Managed/reused OpenCode address probed for the active project.
const OPENCODE_PROBE_PORT: u16 = 4096;
/// Whole-request bound for the /path probe — detection must never stall
/// startup on a wedged local server.
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// Official OpenCode default Basic-auth username.
const OPENCODE_DEFAULT_USERNAME: &str = "opencode";

/// Non-empty trimmed env value, else None.
fn env_value(get_env: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    let v = get_env(key)?;
    let t = v.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Resolve a candidate string to a canonical absolute existing directory.
pub fn existing_abs_dir(raw: &str) -> Option<PathBuf> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    let p = PathBuf::from(t);
    if !p.is_absolute() {
        return None;
    }
    let c = p.canonicalize().ok()?;
    if c.is_dir() {
        Some(c)
    } else {
        None
    }
}

/// Standard base64 (RFC 4648), no line breaks. Only used for the Basic-auth
/// header; kept inline to avoid a dependency for ~20 lines.
pub fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Extract the first JSON string value for a top-level `key` using
/// serde_json (settings.rs already depends on it transitively via serde).
fn json_string_field(body: &str, key: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get(key)?.as_str().map(str::to_string)
}

/// Pick the project from an OpenCode `/path` response body: `directory`
/// first, then `worktree`; only non-empty strings surface.
pub fn project_from_path_body(body: &str) -> Option<String> {
    json_string_field(body, "directory").or_else(|| json_string_field(body, "worktree"))
}

/// Bounded loopback GET of OpenCode `/path` at 127.0.0.1:4096. Returns the
/// response body on HTTP 200, otherwise None. Basic auth is attached when an
/// inherited `OPENCODE_SERVER_PASSWORD` is present.
pub fn probe_opencode_project(
    get_env: &dyn Fn(&str) -> Option<String>,
) -> Option<PathBuf> {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), OPENCODE_PROBE_PORT);
    let mut stream = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT).ok()?;
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));

    let mut request = String::from(
        "GET /path HTTP/1.1\r\nHost: 127.0.0.1:4096\r\nConnection: close\r\n",
    );
    if let Some(password) = env_value(get_env, "OPENCODE_SERVER_PASSWORD") {
        let user = env_value(get_env, "OPENCODE_SERVER_USERNAME")
            .unwrap_or_else(|| OPENCODE_DEFAULT_USERNAME.to_string());
        let creds = base64_encode(format!("{user}:{password}").as_bytes());
        request.push_str(&format!("Authorization: Basic {creds}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).ok()?;

    let mut buf = Vec::with_capacity(1024);
    stream.take(32 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split("\r\n");
    let status = lines.next()?;
    if !status.contains(" 200") {
        return None;
    }
    // Split headers/body on the first empty line.
    let body_start = text.find("\r\n\r\n")? + 4;
    let body = &text[body_start..];
    let candidate = project_from_path_body(body)?;
    existing_abs_dir(&candidate)
}

/// First explicit launch argument resolving to an existing directory.
/// argv[0] and anything starting with `-` are ignored.
pub fn first_launch_arg_dir(args: &[String]) -> Option<PathBuf> {
    args.iter()
        .filter(|a| !a.starts_with('-'))
        .find_map(|a| existing_abs_dir(a))
}

/// High-confidence workspace marker: `.git`, `.opencode`, or `package.json`.
pub fn has_workspace_marker(dir: &Path) -> bool {
    [".git", ".opencode", "package.json"]
        .iter()
        .any(|m| dir.join(m).exists())
}

/// cwd candidate, rejected when it is the app bundle's executable directory
/// (or inside it) or the staged runtime root — those are Owl internals, not
/// a managed project.
pub fn cwd_workspace(exe_dir: &Path, runtime_dir: &Path) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?.canonicalize().ok()?;
    if !cwd.is_dir() {
        return None;
    }
    if cwd == exe_dir || cwd.starts_with(exe_dir) {
        return None;
    }
    if cwd == runtime_dir || cwd.starts_with(runtime_dir) {
        return None;
    }
    if !has_workspace_marker(&cwd) {
        return None;
    }
    Some(cwd)
}

/// OpenCode config directory resolution (see module docs for the order).
/// `home` is the user home directory candidate.
pub fn detect_opencode_config_dir(
    get_env: &dyn Fn(&str) -> Option<String>,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    // 1. Inherited explicit selector — must be non-empty, absolute, existing.
    if let Some(v) = env_value(get_env, "OPENCODE_CONFIG_DIR") {
        if let Some(dir) = existing_abs_dir(&v) {
            return Ok(dir);
        }
    }

    // 2./3. Conventional default (XDG base when non-empty, else ~/.config).
    let base = env_value(get_env, "XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| {
        home.map(|h| h.join(".config"))
    });
    let Some(base) = base else {
        return Err(
            "cannot locate a home or XDG config directory for OpenCode config detection"
                .to_string(),
        );
    };
    let candidate = base.join("opencode");

    // Create the conventional default rather than prompting; fail only on
    // genuine filesystem errors.
    if !candidate.exists() {
        fs::create_dir_all(&candidate).map_err(|e| {
            format!(
                "cannot create OpenCode config directory {}: {e}",
                candidate.display()
            )
        })?;
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize {}: {e}", candidate.display()))?;
    if !canonical.is_dir() {
        return Err(format!(
            "OpenCode config directory is not a directory: {}",
            canonical.display()
        ));
    }
    Ok(canonical)
}

/// Project directory resolution (see module docs for the order). `exe_dir`
/// and `runtime_dir` gate the cwd heuristic.
pub fn detect_project_dir(
    get_env: &dyn Fn(&str) -> Option<String>,
    args: &[String],
    exe_dir: &Path,
    runtime_dir: &Path,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    // 1. Inherited explicit selector.
    if let Some(v) = env_value(get_env, "OMO_CP_PROJECT_DIR") {
        if let Some(dir) = existing_abs_dir(&v) {
            return Ok(dir);
        }
    }
    // 2. First explicit launch argument.
    if let Some(dir) = first_launch_arg_dir(args) {
        return Ok(dir);
    }
    // 3. Active OpenCode /path probe.
    if let Some(dir) = probe_opencode_project(get_env) {
        return Ok(dir);
    }
    // 4. High-confidence cwd workspace (not app internals).
    if let Some(dir) = cwd_workspace(exe_dir, runtime_dir) {
        return Ok(dir);
    }
    // 5. Home — final existing fallback; never prompt.
    if let Some(h) = home {
        if h.is_dir() {
            return Ok(h.to_path_buf());
        }
    }
    Err("no project directory could be detected and no home directory exists".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        }
    }

    #[test]
    fn base64_standard_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"opencode:s3cret"), "b3BlbmNvZGU6czNjcmV0");
    }

    #[test]
    fn path_body_prefers_directory_then_worktree() {
        assert_eq!(
            project_from_path_body(r#"{"directory":"/a/b","worktree":"/a"}"#),
            Some("/a/b".to_string())
        );
        assert_eq!(
            project_from_path_body(r#"{"worktree":"/a"}"#),
            Some("/a".to_string())
        );
        assert_eq!(project_from_path_body(r#"{"other":1}"#), None);
        assert_eq!(project_from_path_body("not json"), None);
    }

    #[test]
    fn launch_arg_skips_flags_and_non_dirs() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let tmp_s = tmp.to_string_lossy().into_owned();
        assert_eq!(
            first_launch_arg_dir(&["--inspect".into(), tmp_s.clone()]),
            Some(tmp.clone())
        );
        assert_eq!(
            first_launch_arg_dir(&["/definitely/not/a/dir-xyz".into()]),
            None
        );
        assert_eq!(first_launch_arg_dir(&[]), None);
    }

    #[test]
    fn config_dir_env_selector_wins_and_defaults_fall_back() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let explicit = tmp.join("owl-detect-explicit");
        fs::create_dir_all(&explicit).unwrap();
        let explicit_s = explicit.to_string_lossy().into_owned();

        let env = env_of(&[("OPENCODE_CONFIG_DIR", explicit_s.as_str())]);
        assert_eq!(
            detect_opencode_config_dir(&env, None).unwrap(),
            explicit.canonicalize().unwrap()
        );

        // Non-empty XDG base → $XDG_CONFIG_HOME/opencode (created, not
        // prompted) when no explicit selector exists.
        let xdg = tmp.join("owl-detect-xdg");
        let env = env_of(&[("XDG_CONFIG_HOME", xdg.to_string_lossy().as_ref())]);
        let got = detect_opencode_config_dir(&env, None).unwrap();
        assert_eq!(got, xdg.join("opencode").canonicalize().unwrap());
        assert!(got.is_dir());

        // Home fallback → ~/.config/opencode.
        let home = tmp.join("owl-detect-home");
        fs::create_dir_all(&home).unwrap();
        let env = env_of(&[]);
        let got = detect_opencode_config_dir(&env, Some(&home)).unwrap();
        assert_eq!(
            got,
            home.join(".config").join("opencode").canonicalize().unwrap()
        );

        let _ = fs::remove_dir_all(&explicit);
        let _ = fs::remove_dir_all(&xdg);
        let _ = fs::remove_dir_all(&home);
    }
}
