#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::{
    fs,
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const LAUNCHER_PORT: u16 = 5240;
const PRIVATE_REALM_URL: &str = "http://127.0.0.1:5230/";

struct ShutdownFlag(AtomicBool);

#[derive(Debug, Deserialize)]
struct LauncherSession {
    token: String,
    pid: u32,
    port: u16,
}

struct BackendProcess {
    child: Mutex<Option<Child>>,
    session_path: PathBuf,
}

impl BackendProcess {
    fn new(child: Option<Child>, session_path: PathBuf) -> Self {
        Self {
            child: Mutex::new(child),
            session_path,
        }
    }

    fn stop(&self) {
        let Ok(mut child_slot) = self.child.lock() else {
            return;
        };
        let Some(mut child) = child_slot.take() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        remove_owned_session(&self.session_path, child.id());
    }
}

impl Drop for BackendProcess {
    fn drop(&mut self) {
        let Ok(child_slot) = self.child.get_mut() else {
            return;
        };
        let Some(mut child) = child_slot.take() else {
            return;
        };
        if child.try_wait().ok().flatten().is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        remove_owned_session(&self.session_path, child.id());
    }
}

fn repository_marker(path: &Path) -> bool {
    path.join("iris_launcher/app.py").is_file() && path.join("scripts/lily.ps1").is_file()
}

fn find_repository_root() -> io::Result<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(path) = std::env::current_exe() {
        starts.push(path);
    }
    if let Ok(path) = std::env::current_dir() {
        starts.push(path);
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for start in starts {
        let base = if start.is_file() {
            start.parent().unwrap_or(&start)
        } else {
            start.as_path()
        };
        for candidate in base.ancestors() {
            if repository_marker(candidate) {
                return Ok(candidate.to_path_buf());
            }
        }
    }

    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "IRIS could not find the Lily repository. Keep the executable inside the repository or rebuild it there.",
    ))
}

fn read_session(path: &Path) -> Option<LauncherSession> {
    let source = fs::read_to_string(path).ok()?;
    let session: LauncherSession = serde_json::from_str(&source).ok()?;
    if session.port != LAUNCHER_PORT || session.token.is_empty() {
        return None;
    }
    Some(session)
}

fn remove_owned_session(path: &Path, pid: u32) {
    if read_session(path).is_some_and(|session| session.pid == pid) {
        let _ = fs::remove_file(path);
    }
}

fn launcher_is_ready() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], LAUNCHER_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(350)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1:5240\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.take(8192).read_to_string(&mut response).is_ok() && valid_ping_response(&response)
}

fn valid_ping_response(response: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let mut status = headers
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let protocol = status.next().unwrap_or_default();
    if !matches!(protocol, "HTTP/1.0" | "HTTP/1.1") || status.next() != Some("200") {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .map(|payload| payload["app"] == "iris-launcher" && payload["ok"] == true)
        .unwrap_or(false)
}

fn launcher_url(session: &LauncherSession) -> io::Result<tauri::Url> {
    let mut url = tauri::Url::parse(&format!("http://127.0.0.1:{LAUNCHER_PORT}/"))
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    url.query_pairs_mut()
        .append_pair("token", &session.token)
        .append_pair("native", "1");
    Ok(url)
}

fn spawn_python_backend(repository_root: &Path) -> io::Result<Child> {
    // Resolve the real interpreter first: the Windows py launcher has a different PID.
    let candidates: [(&str, &[&str]); 2] = [
        ("py.exe", &["-3", "-c", "import sys; print(sys.executable)"]),
        ("python.exe", &["-c", "import sys; print(sys.executable)"]),
    ];
    for (program, args) in candidates {
        let mut probe = hidden_command(program);
        let output = probe.args(args).output();
        let Ok(output) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let interpreter = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if !interpreter.is_absolute() || !interpreter.is_file() {
            continue;
        }
        let mut command = hidden_command(&interpreter);
        command
            .args(["-m", "iris_launcher.app", "--no-browser"])
            .current_dir(repository_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        return command.spawn();
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "Python 3 was not found. Install Python 3 and reopen IRIS.",
    ))
}

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn ensure_backend(repository_root: &Path) -> io::Result<(tauri::Url, Option<Child>, PathBuf)> {
    let session_path = repository_root.join("iris_launcher/runtime/session.json");
    if launcher_is_ready() {
        if let Some(session) = read_session(&session_path) {
            return Ok((launcher_url(&session)?, None, session_path));
        }
    }

    if TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], LAUNCHER_PORT)),
        Duration::from_millis(350),
    )
    .is_ok()
    {
        return Err(io::Error::new(io::ErrorKind::AddrInUse,
            "Port 5240 is already in use without a matching IRIS session. Close the old launcher or conflicting app, then reopen IRIS."));
    }

    let mut child = spawn_python_backend(repository_root)?;
    let expected_pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "IRIS backend stopped before startup completed ({status})"
            )));
        }
        if launcher_is_ready() {
            if let Some(session) = read_session(&session_path) {
                if session.pid == expected_pid {
                    return Ok((launcher_url(&session)?, Some(child), session_path));
                }
            }
        }
        thread::sleep(Duration::from_millis(140));
    }

    let _ = child.kill();
    let _ = child.wait();
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "IRIS backend did not become ready within 20 seconds",
    ))
}

fn create_tray_icon() -> Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let index = ((y * SIZE + x) * 4) as usize;
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance > 14.5 {
                continue;
            }
            rgba[index] = 17;
            rgba[index + 1] = 17;
            rgba[index + 2] = 15;
            rgba[index + 3] = 255;
            let stem = dx.abs() < 1.7 && dy.abs() < 8.0;
            let cap = dy.abs() > 7.0 && dy.abs() < 9.5 && dx.abs() < 5.0;
            let orbit = ((dx * dx) / 120.0 + (dy * dy) / 28.0 - 1.0).abs() < 0.16;
            if stem || cap {
                rgba[index] = 244;
                rgba[index + 1] = 240;
                rgba[index + 2] = 229;
            } else if orbit {
                rgba[index] = 255;
                rgba[index + 1] = 79;
                rgba[index + 2] = 154;
            }
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}

fn show_window(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn open_external(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = Command::new("explorer.exe")
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show IRIS", true, None::<&str>)?;
    let realm = MenuItem::with_id(app, "realm", "Open Private Realm", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Exit IRIS", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &realm, &quit])?;

    TrayIconBuilder::with_id("iris-launcher")
        .icon(create_tray_icon())
        .tooltip("IRIS Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    show_window(&window);
                }
            }
            "realm" => open_external(PRIVATE_REALM_URL),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    match window.is_visible() {
                        Ok(true) => {
                            let _ = window.hide();
                        }
                        _ => show_window(&window),
                    }
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                show_window(&window);
            }
        }))
        .setup(|app| {
            app.manage(ShutdownFlag(AtomicBool::new(false)));
            let started = AtomicBool::new(false);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("IRIS Launcher")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 640.0)
                .resizable(true)
                .decorations(false)
                .theme(Some(tauri::Theme::Dark))
                .center()
                .on_page_load(move |window, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished
                        && !started.swap(true, Ordering::SeqCst)
                    {
                        start_backend_for_window(window);
                    }
                })
                .build()?;
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("IRIS Launcher failed to start");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(flag) = app.try_state::<ShutdownFlag>() {
                flag.0.store(true, Ordering::SeqCst);
            }
            if let Some(backend) = app.try_state::<BackendProcess>() {
                backend.stop();
            }
        }
    });
}

fn start_backend_for_window(window: WebviewWindow) {
    let handle = window.app_handle().clone();
    thread::spawn(move || {
        let result = find_repository_root().and_then(|root| ensure_backend(&root));
        match result {
            Ok((url, child, session_path)) => {
                let backend = BackendProcess::new(child, session_path);
                if handle.state::<ShutdownFlag>().0.load(Ordering::SeqCst) {
                    backend.stop();
                    return;
                }
                handle.manage(backend);
                if handle.state::<ShutdownFlag>().0.load(Ordering::SeqCst) {
                    handle.state::<BackendProcess>().stop();
                    return;
                }
                if let Err(error) = window.navigate(url) {
                    show_startup_error(&window, &error.to_string());
                }
            }
            Err(error) => show_startup_error(&window, &error.to_string()),
        }
    });
}

fn show_startup_error(window: &WebviewWindow, message: &str) {
    let encoded = serde_json::to_string(message).unwrap_or_default();
    let _ = window.eval(format!("document.getElementById('startup-message').textContent = {encoded}; document.getElementById('startup-title').textContent = 'IRIS needs attention';"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_accepts_python_http10_and_http11() {
        for protocol in ["HTTP/1.0", "HTTP/1.1"] {
            assert!(valid_ping_response(&format!(
                "{protocol} 200 OK\r\n\r\n{{\"app\":\"iris-launcher\",\"ok\":true}}"
            )));
        }
    }

    #[test]
    fn ping_rejects_other_services_and_errors() {
        for response in [
            "HTTP/1.0 404 Not Found\r\n\r\n{\"app\":\"iris-launcher\",\"ok\":true}",
            "HTTP/1.0 200 OK\r\n\r\n{\"app\":\"other\",\"ok\":true}",
            "HTTP/1.0 200 OK\r\n\r\nnot json iris-launcher",
        ] {
            assert!(!valid_ping_response(response));
        }
    }

    #[test]
    fn native_url_encodes_token_and_sets_host_flag() {
        let session = LauncherSession {
            token: "test&token".into(),
            pid: 123,
            port: LAUNCHER_PORT,
        };
        let url = launcher_url(&session).unwrap();
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:5240/?token=test%26token&native=1"
        );
    }
}
