//! Runtime staging.
//!
//! The compiled sidecar and its sibling runtime assets are copied out of the
//! read-only (or ephemeral/mounted) bundle into a stable app-data location:
//!
//! ```text
//! <app_data>/runtime/current/
//!   owl[.exe]                      compiled Bun sidecar
//!   package.json                   root identity (name "omo-control-plane")
//!   web/                           built SPA
//!   packages/omo-telemetry-bridge  managed telemetry bridge source
//!   LICENSE
//! ```
//!
//! Why: the server's install-root proof and the managed telemetry-bridge
//! identity both derive from realpaths under the install root. Spawning from
//! inside an AppImage FUSE mount (or a macOS translocated .app) would bake a
//! volatile mount path into that identity and registration. Staging under
//! app-data keeps the identity stable across launches and updates.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub struct StagedRuntime {
    /// `<app_data>/runtime/current` — the install root handed to the sidecar
    /// via `OMO_CP_INSTALL_DIR`.
    pub root: PathBuf,
    /// `<root>/owl` or `<root>/owl.exe`.
    pub sidecar: PathBuf,
}

fn millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn sidecar_filename() -> &'static str {
    if cfg!(windows) {
        "owl.exe"
    } else {
        "owl"
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("cannot create {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot list {}: {e}", src.display()))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|e| format!("cannot stat {}: {e}", from.display()))?;
        if kind.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if kind.is_file() {
            fs::copy(&from, &to)
                .map_err(|e| format!("cannot copy {} -> {}: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)
        .map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Copy the bundled runtime into `<app_data>/runtime/current`, replacing any
/// previous tree via rename-based swap. The old tree is moved aside first so
/// a failed staging never leaves `current` absent.
pub fn stage_runtime(app: &AppHandle) -> Result<StagedRuntime, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir unavailable: {e}"))?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data dir unavailable: {e}"))?;

    let runtime_dir = app_data.join("runtime");
    fs::create_dir_all(&runtime_dir)
        .map_err(|e| format!("cannot create {}: {e}", runtime_dir.display()))?;

    let stamp = format!("{}-{}", std::process::id(), millis());
    let staging = runtime_dir.join(format!("staging-{stamp}"));
    let current = runtime_dir.join("current");
    let previous = runtime_dir.join(format!("previous-{stamp}"));

    // Sources: bundled resources (web/, packages/, package.json, LICENSE) and
    // the externalBin sidecar located next to the main executable.
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("current exe unavailable: {e}"))?
        .parent()
        .ok_or_else(|| "current exe has no parent directory".to_string())?
        .to_path_buf();
    let bundled_sidecar = exe_dir.join(sidecar_filename());
    if !bundled_sidecar.is_file() {
        return Err(format!(
            "bundled sidecar not found at {}",
            bundled_sidecar.display()
        ));
    }

    copy_dir_recursive(&resource_dir, &staging)?;
    fs::copy(&bundled_sidecar, staging.join(sidecar_filename())).map_err(|e| {
        format!(
            "cannot copy sidecar {} -> {}: {e}",
            bundled_sidecar.display(),
            staging.display()
        )
    })?;

    // Required layout proof before swap.
    let staged_sidecar = staging.join(sidecar_filename());
    mark_executable(&staged_sidecar)?;
    for required in [
        staged_sidecar.clone(),
        staging.join("package.json"),
        staging.join("web").join("index.html"),
        staging
            .join("packages")
            .join("omo-telemetry-bridge")
            .join("package.json"),
    ] {
        if !required.is_file() {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!(
                "staged runtime is incomplete, missing {}",
                required.display()
            ));
        }
    }

    // Swap into place.
    let had_current = current.exists();
    if had_current {
        fs::rename(&current, &previous)
            .map_err(|e| format!("cannot retire previous runtime: {e}"))?;
    }
    if let Err(e) = fs::rename(&staging, &current) {
        if had_current {
            let _ = fs::rename(&previous, &current); // best-effort rollback
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("cannot activate staged runtime: {e}"));
    }
    let _ = fs::remove_dir_all(&previous);

    Ok(StagedRuntime {
        root: current.clone(),
        sidecar: current.join(sidecar_filename()),
    })
}
