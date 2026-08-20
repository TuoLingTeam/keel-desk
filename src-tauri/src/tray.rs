use tauri::{
    AppHandle, Emitter, Manager,
    image::Image,
    menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt;

use crate::{ExitIntent, HARNESS_RELAUNCHING_EVENT, SharedHarness, harness::HarnessProcess};

const SHOW_WINDOW: &str = "tray-show-window";
const RESTART_HARNESS: &str = "tray-restart-harness";
const TOGGLE_AUTOSTART: &str = "tray-toggle-autostart";
const QUIT: &str = "tray-quit";

/// The menu bar tints a template image itself, so macOS gets the flat whale
/// silhouette while other desktops keep the full-colour application icon.
#[cfg(target_os = "macos")]
const TRAY_TEMPLATE_ICON: &[u8] = include_bytes!("../icons/tray-template.png");

/// Build the tray icon and its menu, so closing the window can park the app
/// instead of ending the Harness session.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(SHOW_WINDOW, "显示窗口").build(app)?;
    let restart = MenuItemBuilder::with_id(RESTART_HARNESS, "重启后端").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id(TOGGLE_AUTOSTART, "开机自启")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT, "退出").build(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &restart,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let icon = Image::from_bytes(TRAY_TEMPLATE_ICON)?;
    #[cfg(not(target_os = "macos"))]
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("bundled application icon".into()))?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("DeepSeek Harness")
        .menu(&menu)
        // macOS status items open their menu with either button; elsewhere the
        // left button stays the shortcut back to the window.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(move |app, event| match event.id().as_ref() {
            SHOW_WINDOW => reveal_window(app),
            RESTART_HARNESS => restart_harness(app),
            TOGGLE_AUTOSTART => {
                let _ = autostart.set_checked(set_autostart(app));
            }
            QUIT => {
                app.state::<ExitIntent>().request();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if cfg!(target_os = "macos") {
                return;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Bring the parked window back, whether it was hidden or minimised.
pub fn reveal_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Restart only the Node side, so plugin or theme edits land without the user
/// losing the desktop window.
fn restart_harness(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    // The launcher page drives itself off `launch_status` and stops polling once
    // Harness is ready, so it has to be told that a new run has begun.
    let _ = window.emit(HARNESS_RELAUNCHING_EVENT, ());
    HarnessProcess::restart(app.state::<SharedHarness>().inner(), &window);
}

/// Flip the login item and report the state actually reached, so a failed write
/// cannot leave the checkbox lying about it.
fn set_autostart(app: &AppHandle) -> bool {
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().unwrap_or(false);
    let outcome = if enabled {
        manager.disable()
    } else {
        manager.enable()
    };
    if let Err(error) = outcome {
        eprintln!("deepseek-harness-desktop: toggling autostart failed: {error}");
    }
    manager.is_enabled().unwrap_or(enabled)
}
