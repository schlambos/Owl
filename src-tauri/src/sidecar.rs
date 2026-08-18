//! Sidecar process management.
//!
//! The compiled Bun server is spawned as a child of the desktop app with an
//! explicit, minimal desktop contract:
//!   - OMO_CP_DESKTOP=1            (desktop mode; loopback + ephemeral port)
//!   - OMO_CP_HOST=127.0.0.1
//!   - OMO_CP_PORT=0
//!   - OMO_CP_INSTALL_DIR          staged runtime root (stable identity)
//!   - OMO_CP_PROJECT_DIR          user-selected project root
//!   - OPENCODE_CONFIG_DIR         user-selected OpenCode config root
//!   - OMO_CP_SHUTDOWN_TOKEN       unpredictable per-launch token
//!
//! Readiness is the exact parseable `OWL_READY http://127.0.0.1:<port>` line
//! on stdout. stdout keeps being drained forever after readiness so the child
//! never blocks on a full pipe (and never receives SIGPIPE from a closed
//! read end).

use crate::settings::Settings;
use crate::staging::StagedRuntime;
use rand::RngCore;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long the shell waits for the OWL_READY line before failing launch.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

pub fn new_launch_token() -> String {
    let mut buf = [0u8; 32];
    rand::rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Extract `http://127.0.0.1:<port>` from an exact OWL_READY line.
fn parse_ready(line: &str) -> Option<String> {
    let rest = line.strip_prefix("OWL_READY ")?;
    let origin = rest.trim();
    if origin.starts_with("http://127.0.0.1:")
        && origin["http://127.0.0.1:".len()..]
            .chars()
            .all(|c| c.is_ascii_digit())
    {
        Some(origin.to_string())
    } else {
        None
    }
}

/// Spawn the staged sidecar and wait (bounded) for its OWL_READY line.
/// On success returns the child handle and the exact loopback origin.
pub fn spawn_and_wait_ready(
    runtime: &StagedRuntime,
    settings: &Settings,
    token: &str,
) -> Result<(Child, String), String> {
    let mut cmd = Command::new(&runtime.sidecar);
    cmd.env("OMO_CP_DESKTOP", "1")
        .env("OMO_CP_HOST", "127.0.0.1")
        .env("OMO_CP_PORT", "0")
        .env("OMO_CP_INSTALL_DIR", &runtime.root)
        .env("OMO_CP_PROJECT_DIR", &settings.project_directory)
        .env("OPENCODE_CONFIG_DIR", &settings.opencode_config_dir)
        .env("OMO_CP_SHUTDOWN_TOKEN", token)
        .current_dir(&runtime.root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .stdin(Stdio::null());

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to spawn sidecar {}: {e}",
            runtime.sidecar.display()
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;

    // The reader thread scans for the ready line, then keeps draining stdout
    // for the entire child lifetime.
    let shared = Arc::new((Mutex::new(None::<String>), Condvar::new()));
    {
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break, // pipe gone; child exiting
                };
                if let Some(origin) = parse_ready(&line) {
                    let (lock, cv) = &*shared;
                    if let Ok(mut slot) = lock.lock() {
                        if slot.is_none() {
                            *slot = Some(origin);
                        }
                    }
                    cv.notify_all();
                }
            }
        });
    }

    let (lock, cv) = &*shared;
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut slot = lock.lock().map_err(|_| "sidecar ready-state poisoned".to_string())?;
    loop {
        if let Some(origin) = slot.clone() {
            return Ok((child, origin));
        }
        let now = Instant::now();
        if now >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "sidecar did not report OWL_READY within {}s",
                READY_TIMEOUT.as_secs()
            ));
        }
        let remaining = deadline - now;
        match cv.wait_timeout(slot, remaining.min(Duration::from_secs(1))) {
            Ok((guard, _)) => slot = guard,
            Err(_) => return Err("sidecar ready-state poisoned".to_string()),
        }
    }
}
