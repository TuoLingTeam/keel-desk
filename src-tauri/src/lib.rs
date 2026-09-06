mod harness;
mod tray;
mod usage;

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use harness::{HarnessProcess, LaunchSnapshot};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

pub type SharedHarness = Arc<Mutex<HarnessProcess>>;

/// Emitted when the tray restarts the Node side, so the launcher page leaves
/// the workspace it had already mounted and follows the new run.
pub const HARNESS_RELAUNCHING_EVENT: &str = "harness://relaunching";

/// Closing the window parks the app in the tray, so only the tray's quit item
/// is allowed to take the Harness session down with it.
#[derive(Default)]
pub struct ExitIntent(AtomicBool);

impl ExitIntent {
    pub(crate) fn request(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub(crate) fn requested(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[tauri::command]
fn launch_status(state: tauri::State<'_, SharedHarness>) -> LaunchSnapshot {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .snapshot()
}

#[tauri::command]
fn restart_harness(state: tauri::State<'_, SharedHarness>, window: tauri::WebviewWindow) {
    // The launcher page drives itself off `launch_status` and stops polling once
    // Harness is ready, so it has to be told that a new run has begun — the
    // manager panel's "restart" posts through the same invoke, and without
    // this event the page would keep pointing at the old (dead) port.
    let _ = window.emit(HARNESS_RELAUNCHING_EVENT, ());
    HarnessProcess::restart(&state, &window);
}

/// 标题栏用量挂件的数据源。余额要走网络、用量要解压会话日志，都不能占用 UI 线程，
/// 所以放到 blocking 线程池里跑。
#[tauri::command]
async fn usage_snapshot(day_start: Option<u64>) -> Result<usage::UsageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || usage::snapshot(day_start))
        .await
        .map_err(|error| format!("采集用量快照失败：{error}"))
}

/// 把 Harness 的主题偏好在文档创建前写进 `<html>`，让首帧就是最终配色。
///
/// `documentElement` 在 init script 运行时可能尚未存在，所以用
/// `MutationObserver` 盯住它出现的那一刻——这仍然早于任何像素被绘制。
fn boot_theme_plugin<R: tauri::Runtime>(preference: &str) -> tauri::plugin::TauriPlugin<R> {
    let script = format!(
        r#"(() => {{
  const preference = {preference};
  const dark = preference === 'dark'
    || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const mark = () => {{
    const root = document.documentElement;
    if (root === null) return false;
    root.setAttribute('data-dsh-boot', dark ? 'dark' : 'light');
    root.style.colorScheme = dark ? 'dark' : 'light';
    return true;
  }};
  if (mark()) return;
  new MutationObserver((_records, observer) => {{
    if (mark()) observer.disconnect();
  }}).observe(document, {{ childList: true, subtree: true }});
}})()"#,
        preference = serde_json::to_string(preference).unwrap_or_else(|_| "\"system\"".into()),
    );
    tauri::plugin::Builder::new("dsh-boot-theme")
        .js_init_script(script)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let harness = Arc::new(Mutex::new(HarnessProcess::new()));
    let setup_harness = Arc::clone(&harness);

    // 主题偏好必须在页面开始渲染之前就位，否则深色用户会先看到一帧浅色。
    // 插件的 init script 在文档创建前注入，比任何页面脚本都早。
    let boot_theme = usage::boot_theme_preference().unwrap_or_else(|| "system".into());

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(true)
                .build(),
        )
        .plugin(boot_theme_plugin(&boot_theme))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // VISIBLE is deliberately left out: a window parked in the tray
                // at shutdown must still come back on the next launch. The
                // plugin only restores a saved position that still intersects a
                // connected monitor, so unplugging a display falls back to the
                // system's own placement instead of stranding the window.
                .with_state_flags(
                    StateFlags::POSITION
                        | StateFlags::SIZE
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Arc::clone(&harness))
        .manage(ExitIntent::default())
        .invoke_handler(tauri::generate_handler![launch_status, usage_snapshot, restart_harness])
        .setup(move |app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "main window was not created".to_string())?;
            tray::install(app.handle())?;

            let handle = app.handle().clone();
            let parked = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event
                    && !handle.state::<ExitIntent>().requested()
                {
                    api.prevent_close();
                    let _ = parked.hide();
                }
            });

            HarnessProcess::spawn(setup_harness, window);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building DeepSeek Harness Desktop");

    app.run(move |handle, event| {
        match event {
            RunEvent::ExitRequested { api, code, .. } => {
                let intent = handle.state::<ExitIntent>();
                if code.is_some() {
                    // An explicit quit: the tray item, Cmd+Q, or the OS logging
                    // the session out. Record it so the window stops diverting
                    // its own close into the tray.
                    intent.request();
                } else if !intent.requested() {
                    // The last window merely closed, which parks the app.
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => {
                harness
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .stop();
            }
            // Clicking the macOS dock icon brings the parked window back.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => tray::reveal_window(handle),
            _ => {}
        }
    });
}
