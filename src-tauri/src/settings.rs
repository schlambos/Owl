//! Desktop settings: small validated JSON persisted atomically under the app
//! config directory. Launch NEVER shows folder-selection dialogs: persisted
//! valid settings win; otherwise the environment is auto-detected
//! (see `detect.rs` for the exact order and fallbacks) and the detected
//! result is persisted for subsequent launches.

use crate::detect;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    #[serde(rename = "projectDirectory")]
    pub project_directory: String,
    #[serde(rename = "opencodeConfigDir")]
    pub opencode_config_dir: String,
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// OS user home without extra dependencies (tauri path resolvers are
/// app-scoped, not user-scoped).
fn user_home() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("HOME") {
        let p = PathBuf::from(h);
        if p.is_dir() {
            return Some(p);
        }
    }
    #[cfg(windows)]
    {
        if let Some(h) = std::env::var_os("USERPROFILE") {
            let p = PathBuf::from(h);
            if p.is_dir() {
                return Some(p);
            }
        }
        if let (Some(d), Some(p)) = (
            std::env::var_os("HOMEDRIVE"),
            std::env::var_os("HOMEPATH"),
        ) {
            let p = PathBuf::from(d).join(p);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Load persisted settings, or auto-detect and persist them. No dialogs.
pub fn load_or_detect(app: &AppHandle) -> Result<Settings, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app config dir unavailable: {e}"))?;
    let path = config_dir.join("settings.json");

    if let Some(s) = try_load(&path) {
        if validate(&s).is_ok() {
            return Ok(s);
        }
        // Persisted settings are corrupt or point at vanished directories:
        // fall through to detection. Existing valid v1 settings above always
        // win; user choices are never erased.
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;
    let runtime_dir = app_data.join("runtime");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let home = user_home();

    let settings = Settings {
        version: 1,
        project_directory: detect::detect_project_dir(
            &process_env,
            &args,
            &exe_dir(),
            &runtime_dir,
            home.as_deref(),
        )?
        .to_string_lossy()
        .into_owned(),
        opencode_config_dir: detect::detect_opencode_config_dir(
            &process_env,
            home.as_deref(),
        )?
        .to_string_lossy()
        .into_owned(),
    };
    validate(&settings)?;

    // Persist detected settings atomically so subsequent launches reuse them.
    save_atomic(&path, &settings)?;
    Ok(settings)
}

fn try_load(path: &Path) -> Option<Settings> {
    let raw = fs::read_to_string(path).ok()?;
    let s: Settings = serde_json::from_str(&raw).ok()?;
    if s.version != 1 {
        return None;
    }
    Some(s)
}

fn validate(s: &Settings) -> Result<(), String> {
    for (label, value) in [
        ("Project directory", &s.project_directory),
        ("OpenCode config directory", &s.opencode_config_dir),
    ] {
        if value.trim().is_empty() {
            return Err(format!("{label} is empty"));
        }
        let p = PathBuf::from(value);
        if !p.is_absolute() {
            return Err(format!("{label} is not absolute: {value}"));
        }
        if !p.is_dir() {
            return Err(format!("{label} is not an existing directory: {value}"));
        }
    }
    Ok(())
}

/// Persist settings atomically: write a sibling temp file, then rename.
fn save_atomic(path: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create settings directory {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("cannot serialize settings: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, format!("{body}\n"))
        .map_err(|e| format!("cannot write temporary settings {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path)
        .map_err(|e| format!("cannot finalize settings {}: {e}", path.display()))?;
    Ok(())
}
