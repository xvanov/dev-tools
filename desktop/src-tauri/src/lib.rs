//! Jarvis desktop shell (plan 7.6; desktop only, D12; Windows and Linux, D14).
//!
//! One window shows the active stack's browser shell (a termhub front: the
//! Jarvis nav with the PA under /pa/), loaded from its URL with a data
//! directory of its own, so work and personal never share cookies or storage.
//! Only one stack is connected at a time: switching destroys the old window and
//! stops the old event stream before the new ones start.
//!
//! Around it: a tray icon (open, switch stack, settings, start at login,
//! notifications, quit), OS notifications from the PA's /api/events stream for
//! what needs you (an approval, a secret, a draft, a run that stopped or ended),
//! and start at login, off unless turned on from the tray or settings.
//! Closing the window hides it; the tray keeps the app (and its notifications)
//! running. `--hidden` (what start-at-login passes) starts in the tray.

mod config;
mod events;

use config::Config;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

const TRAY: &str = "jarvis";
const STACK_PREFIX: &str = "stack-";

struct AppState {
    cfg: Mutex<Config>,
    path: PathBuf,
    /// Bumped on every (re)connect; an event thread from an older one exits.
    generation: Arc<AtomicU64>,
}

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn stack_windows(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows()
        .into_iter()
        .filter(|(l, _)| l.starts_with(STACK_PREFIX))
        .map(|(_, w)| w)
        .collect()
}

/// Connect to the active stack: close whatever was open, follow its events,
/// open its window (shown or not).
fn connect(app: &AppHandle, show: bool) {
    let st = state(app);
    let gen = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    for w in stack_windows(app) {
        let _ = w.destroy();
    }
    let cfg = st.cfg.lock().unwrap().clone();
    let id = cfg.active.clone();
    let Some(stack) = cfg.active_stack().cloned() else {
        return open_settings(app);
    };
    let url = match stack.url.parse::<tauri::Url>() {
        Ok(u) if !stack.url.is_empty() => u,
        _ => return open_settings(app),
    };

    if let Some(events_url) = stack.events_url() {
        let handle = app.clone();
        let generation = st.generation.clone();
        let name = stack.name.clone();
        std::thread::spawn(move || {
            events::follow(events_url, generation, gen, |note| {
                if !state(&handle).cfg.lock().unwrap().notifications {
                    return;
                }
                let _ = handle
                    .notification()
                    .builder()
                    .title(format!("{} ({name})", note.title))
                    .body(note.body)
                    .show();
            });
        });
    }

    let data_dir = app
        .path()
        .app_local_data_dir()
        .map(|d| d.join("stacks").join(&id))
        .unwrap_or_else(|_| std::env::temp_dir().join("jarvis-desktop").join(&id));
    let built = WebviewWindowBuilder::new(app, format!("{STACK_PREFIX}{id}-{gen}"), WebviewUrl::External(url))
        .title(format!("Jarvis \u{00b7} {}", stack.name))
        .inner_size(1280.0, 860.0)
        .min_inner_size(480.0, 360.0)
        .data_directory(data_dir)
        .visible(show)
        .build();
    if let Err(e) = built {
        eprintln!("[jarvis-desktop] could not open {}: {e}", stack.name);
    }
    refresh_tray(app);
}

fn show_stack(app: &AppHandle) {
    match stack_windows(app).into_iter().next() {
        Some(w) => {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        None => connect(app, true),
    }
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Jarvis settings")
        .inner_size(600.0, 560.0)
        .build();
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let cfg = state(app).cfg.lock().unwrap().clone();
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Open Jarvis", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, s) in &cfg.stacks {
        let label = if s.url.is_empty() {
            format!("{} (not set up)", s.name)
        } else {
            s.name.clone()
        };
        menu.append(&CheckMenuItem::with_id(
            app,
            format!("stack:{id}"),
            label,
            true,
            *id == cfg.active,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "settings",
        "Settings\u{2026}",
        true,
        None::<&str>,
    )?)?;
    let auto = app.autolaunch().is_enabled().unwrap_or(false);
    menu.append(&CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        auto,
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "notify",
        "Notifications",
        true,
        cfg.notifications,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn save(app: &AppHandle) -> Result<Config, String> {
    let st = state(app);
    let cfg = st.cfg.lock().unwrap().clone();
    cfg.save(&st.path)?;
    Ok(cfg)
}

fn switch_to(app: &AppHandle, id: &str) -> Result<(), String> {
    {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        if !cfg.stacks.contains_key(id) {
            return Err(format!("no stack {id}"));
        }
        cfg.active = id.to_string();
    }
    save(app)?;
    connect(app, true);
    Ok(())
}

fn set_autostart_on(app: &AppHandle, on: bool) -> Result<bool, String> {
    let al = app.autolaunch();
    if on { al.enable() } else { al.disable() }.map_err(|e| e.to_string())?;
    refresh_tray(app);
    al.is_enabled().map_err(|e| e.to_string())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_stack(app),
        "settings" => open_settings(app),
        "quit" => app.exit(0),
        "autostart" => {
            let on = app.autolaunch().is_enabled().unwrap_or(false);
            let _ = set_autostart_on(app, !on);
        }
        "notify" => {
            {
                let st = state(app);
                let mut cfg = st.cfg.lock().unwrap();
                cfg.notifications = !cfg.notifications;
            }
            let _ = save(app);
            refresh_tray(app);
        }
        other => {
            if let Some(stack) = other.strip_prefix("stack:") {
                if switch_to(app, stack).is_err() {
                    refresh_tray(app);
                }
            }
        }
    }
}

// ---- commands for the settings window (ui/) ------------------------------------

#[tauri::command]
fn get_config(app: AppHandle) -> serde_json::Value {
    let cfg = state(&app).cfg.lock().unwrap().clone();
    let auto = app.autolaunch().is_enabled().unwrap_or(false);
    serde_json::json!({ "config": cfg, "autostart": auto })
}

#[tauri::command]
fn save_stack(app: AppHandle, id: String, url: String, events: Option<String>) -> Result<Config, String> {
    let url = config::check_url(&url)?;
    let events = match events.as_deref().map(str::trim) {
        Some(e) if !e.is_empty() => Some(config::check_url(e)?),
        _ => None,
    };
    let reconnect = {
        let st = state(&app);
        let mut cfg = st.cfg.lock().unwrap();
        let active = cfg.active == id;
        let s = cfg.stacks.get_mut(&id).ok_or(format!("no stack {id}"))?;
        let changed = s.url != url || s.events != events;
        s.url = url;
        s.events = events;
        active && changed
    };
    let cfg = save(&app)?;
    if reconnect {
        connect(&app, true);
    } else {
        refresh_tray(&app);
    }
    Ok(cfg)
}

#[tauri::command]
fn switch_stack(app: AppHandle, id: String) -> Result<(), String> {
    switch_to(&app, &id)
}

#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> Result<bool, String> {
    set_autostart_on(&app, on)
}

#[tauri::command]
fn set_notifications(app: AppHandle, on: bool) -> Result<(), String> {
    state(&app).cfg.lock().unwrap().notifications = on;
    save(&app)?;
    refresh_tray(&app);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_stack(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_stack,
            switch_stack,
            set_autostart,
            set_notifications
        ])
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("stacks.json");
            let cfg = Config::load(&path);
            app.manage(AppState {
                cfg: Mutex::new(cfg),
                path,
                generation: Arc::new(AtomicU64::new(0)),
            });
            let handle = app.handle().clone();
            let menu = tray_menu(&handle)?;
            let mut tray = TrayIconBuilder::with_id(TRAY)
                .tooltip("Jarvis")
                .menu(&menu)
                .on_menu_event(|app, ev| handle_menu(app, ev.id().as_ref()))
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        show_stack(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            let hidden = std::env::args().any(|a| a == "--hidden");
            connect(&handle, !hidden);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the stack window hides it: notifications keep coming, and
            // the tray brings it back as it was.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label().starts_with(STACK_PREFIX) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Jarvis desktop shell")
        .run(|_app, event| {
            // No windows left is not a reason to quit: the tray is the app.
            if let RunEvent::ExitRequested { api, code: None, .. } = event {
                api.prevent_exit();
            }
        });
}
