//! Desktop settings: small validated JSON persisted atomically under the
//! app config directory. First launch collects the project root and the
//! OpenCode config root through native folder dialogs (owned by Rust, via
//! tauri-plugin-dialog; the frontend has no dialog/fs permissions at all).
//!
//! Blocking plugin calls must not run on the main thread; the caller of
//! [`load_or_prompt`] runs on a dedicated bootstrap worker thread while the
//! event loop is live, which is exactly where blocking dialogs are safe.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub version: u32,
    #[serde(rename = "projectDirectory")]
    pub project_directory: String,
    #[serde(rename = "opencodeConfigDir")]
    pub opencode_config_dir: String,
}

pub enum SettingsError {
    /// User cancelled a first-launch folder dialog: exit without error.
    Cancelled,
    Failed(String),
}

/// Load persisted settings, or run the first-launch folder-dialog flow and
/// persist the result atomically. Cancel exits (the caller maps `Cancelled`
/// to a quiet zero exit).
pub fn load_or_prompt(app: &AppHandle) -> Result<Settings, SettingsError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| SettingsError::Failed(format!("app config dir unavailable: {e}")))?;
    let path = config_dir.join("settings.json");

    if let Some(s) = try_load(&path) {
        if validate(&s).is_ok() {
            return Ok(s);
        }
        // Persisted settings are corrupt or point at vanished directories:
        // fall through to the first-launch flow and re-prompt.
    }

    prompt_and_save(app, &path)
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
/// `fs::rename` replaces the destination atomically on the same volume.
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

fn pick_folder(app: &AppHandle, title: &str) -> Option<PathBuf> {
    let picked = app
        .dialog()
        .file()
        .set_title(title)
        .blocking_pick_folder()?;
    picked.into_path().ok()
}

fn prompt_and_save(app: &AppHandle, path: &Path) -> Result<Settings, SettingsError> {
    let project = pick_folder(
        app,
        "Owl: select the project folder to manage",
    )
    .ok_or(SettingsError::Cancelled)?;
    let config = pick_folder(
        app,
        "Owl: select your OpenCode config directory (e.g. ~/.config/opencode)",
    )
    .ok_or(SettingsError::Cancelled)?;

    let settings = Settings {
        version: 1,
        project_directory: project.to_string_lossy().into_owned(),
        opencode_config_dir: config.to_string_lossy().into_owned(),
    };
    validate(&settings).map_err(SettingsError::Failed)?;
    save_atomic(path, &settings).map_err(SettingsError::Failed)?;
    Ok(settings)
}
