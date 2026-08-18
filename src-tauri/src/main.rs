//! Owl desktop shell (Tauri).
//!
//! Rust owns the entire desktop lifecycle: settings auto-detection and
//! persistence (no first-launch dialogs), runtime staging, sidecar
//! spawn/readiness, the main window, and shutdown. The frontend has zero
//! Tauri permissions — it is just the sidecar SPA loaded from its exact
//! loopback origin.

mod detect;
mod settings;
mod sidecar;
mod staging;

use settings::load_or_detect;
use sidecar::{new_launch_token, spawn_and_wait_ready};
use staging::stage_runtime;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// Graceful HTTP shutdown window before the bounded hard kill begins.
const SHUTDOWN_HTTP_TIMEOUT: Duration = Duration::from_secs(4);
/// Wait for the sidecar to exit after a successful HTTP shutdown.
const SHUTDOWN_EXIT_WAIT: Duration = Duration::from_secs(8);
/// Upper bound on the unconditional bounded hard kill.
const HARD_KILL_WAIT: Duration = Duration::from_secs(3);

pub struct AppState {
    child: Mutex<Option<Child>>,
    origin: Mutex<Option<String>>,
    token: String,
}

static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);

/// Exact-origin navigation lock: everything except the sidecar origin is
/// refused. Popups are denied outright; the app is a single-origin surface.
fn origin_of(url: &tauri::Url) -> String {
    url.origin().ascii_serialization()
}

fn create_main_window(app: &AppHandle, origin: &str) -> Result<(), String> {
    let url = tauri::Url::parse(origin).map_err(|e| format!("invalid sidecar origin: {e}"))?;
    let nav_origin = origin.to_string();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Owl")
        .inner_size(1440.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(move |url| origin_of(url) == nav_origin)
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|e| format!("cannot create main window: {e}"))?;
    Ok(())
}

fn show_fatal(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message)
        .title("Owl failed to start")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .blocking_show();
}

fn bootstrap(app: &AppHandle) -> Result<(Child, String, String), String> {
    let settings = load_or_detect(app)?;
    let runtime = stage_runtime(app)?;
    let token = new_launch_token();
    let (child, origin) = spawn_and_wait_ready(&runtime, &settings, &token)?;
    Ok((child, origin, token))
}

/// Loopback HTTP POST to the sidecar's authenticated shutdown route. Raw
/// std::net on purpose: no HTTP-client dependency for a single fixed request.
fn request_sidecar_shutdown(origin: &str, token: &str) -> Result<(), String> {
    let url = tauri::Url::parse(origin).map_err(|e| format!("bad origin: {e}"))?;
    let port = url
        .port()
        .ok_or_else(|| "origin has no port".to_string())?;
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let mut stream = TcpStream::connect_timeout(&addr, SHUTDOWN_HTTP_TIMEOUT)
        .map_err(|e| format!("shutdown connect failed: {e}"))?;
    let _ = stream.set_read_timeout(Some(SHUTDOWN_HTTP_TIMEOUT));
    let _ = stream.set_write_timeout(Some(SHUTDOWN_HTTP_TIMEOUT));
    let request = format!(
        "POST /internal/shutdown HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Authorization: Bearer {token}\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\
         \r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("shutdown write failed: {e}"))?;
    let mut response = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    let deadline = Instant::now() + SHUTDOWN_HTTP_TIMEOUT;
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                response.extend_from_slice(&buf[..n]);
                if response.len() > 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
        if Instant::now() >= deadline {
            break;
        }
    }
    let head = String::from_utf8_lossy(&response);
    let status_line = head.lines().next().unwrap_or_default();
    if status_line.contains(" 200") {
        Ok(())
    } else {
        Err(format!("shutdown request rejected: {status_line}"))
    }
}

/// Wait (bounded) for child exit; returns true when the child exited.
fn wait_child_exit(child: &mut Child, bound: Duration) -> bool {
    let deadline = Instant::now() + bound;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {}
            Err(_) => return true, // cannot observe; stop waiting
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Shutdown order: authenticated HTTP graceful shutdown first (which lets the
/// server stop only the OpenCode backend it OWNS — externally-owned OpenCode
/// is never touched), then a bounded hard kill of the sidecar child only.
fn shutdown_sidecar(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let origin = state.origin.lock().ok().and_then(|o| o.clone());
    if let Some(origin) = origin {
        let _ = request_sidecar_shutdown(&origin, &state.token);
    }
    let mut maybe_child = state.child.lock().ok().and_then(|mut c| c.take());
    if let Some(child) = maybe_child.as_mut() {
        if !wait_child_exit(child, SHUTDOWN_EXIT_WAIT) {
            let _ = child.kill();
            let _ = wait_child_exit(child, HARD_KILL_WAIT);
        }
        let _ = child.wait();
    }
}

/// Second launch: surface the existing window when present, recreate it at
/// the known sidecar origin when the window is gone, otherwise no-op. Must
/// tolerate there being no window at all (early/damaged state).
fn focus_or_recreate(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let origin = app
        .try_state::<AppState>()
        .and_then(|s| s.origin.lock().ok().and_then(|o| o.clone()));
    if let Some(origin) = origin {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = create_main_window(&handle, &origin);
        });
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_or_recreate(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // Bootstrap (detect/persist settings, stage runtime, spawn and
            // wait for the sidecar) on a dedicated worker thread with the
            // event loop live; the WebView window must be created back on
            // the main thread.
            thread::spawn(move || match bootstrap(&handle) {
                Ok((child, origin, token)) => {
                    handle.manage(AppState {
                        child: Mutex::new(Some(child)),
                        origin: Mutex::new(Some(origin.clone())),
                        token,
                    });
                    let win_handle = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if let Err(e) = create_main_window(&win_handle, &origin) {
                            show_fatal(&win_handle, &e);
                            win_handle.exit(1);
                        }
                    });
                }
                Err(message) => {
                    show_fatal(&handle, &message);
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building owl desktop application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                // Only intercept the first exit request; the follow-up exit
                // issued after cleanup must pass through.
                if !SHUTDOWN_STARTED.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
                    let handle = app.clone();
                    thread::spawn(move || {
                        shutdown_sidecar(&handle);
                        handle.exit(0);
                    });
                }
            }
        });
}
