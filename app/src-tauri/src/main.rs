#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Mutex, OnceLock};
use std::{fs, thread, time::Duration};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use tauri_plugin_global_shortcut::ShortcutState;

const WIDGETS: [&str; 13] = ["widget", "lyrics", "calendar", "photos", "weather", "system", "clock", "countdown", "todo", "timer", "note", "valorant", "stack"];

fn dims(size: &str) -> (f64, f64) {
    match size {
        "s" => (192.0, 192.0),
        "l" => (372.0, 372.0),
        _ => (372.0, 192.0),
    }
}

static SHOWN: AtomicBool = AtomicBool::new(true);
static FULLSCREEN: AtomicBool = AtomicBool::new(false);
static LAST: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());
static SCALE: AtomicU64 = AtomicU64::new(0x3FF0000000000000);
static DRAG: Mutex<Option<String>> = Mutex::new(None);
static BACKEND: Mutex<Option<std::process::Child>> = Mutex::new(None);
static OVERLAY: Mutex<Vec<String>> = Mutex::new(Vec::new());
static TAB: AtomicBool = AtomicBool::new(false);
static TAB_Y: AtomicU64 = AtomicU64::new(0x3FE6666666666666);
static RAISED: AtomicBool = AtomicBool::new(false);
static NOTCH: Mutex<(f64, f64)> = Mutex::new((0.0, 0.0));
static NOTCH_IN: AtomicBool = AtomicBool::new(false);
const NOTCH_SIZE: (f64, f64) = (640.0, 780.0);
static APP: OnceLock<AppHandle> = OnceLock::new();
static NOTCH_MONITOR: Mutex<String> = Mutex::new(String::new());

fn start_backend() {
    use std::os::windows::process::CommandExt;
    let Ok(me) = std::env::current_exe() else { return };
    let exe = me.with_file_name("wavelog-logger.exe");
    let dev = me.parent().is_some_and(|d| d.ends_with("release") || d.ends_with("debug"));
    let up = std::net::TcpStream::connect_timeout(&"127.0.0.1:8721".parse().unwrap(), Duration::from_millis(300)).is_ok();
    if !dev && !up && exe.exists() {
        *BACKEND.lock().unwrap() = std::process::Command::new(exe).creation_flags(0x08000000).spawn().ok();
    }
}
fn mouse_down() -> bool {
    unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x01) < 0 }
}

fn visible() -> bool {
    SHOWN.load(Relaxed) && !FULLSCREEN.load(Relaxed)
}

fn shown(label: &str) -> bool {
    visible() || (SHOWN.load(Relaxed) && OVERLAY.lock().unwrap().iter().any(|l| l == label))
}

fn sync(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label == "stats" || label == "tabpanel" {
            continue;
        }
        let (on, over) = (shown(&label), shown(&label) && !visible());
        let _ = app.emit_to(label.as_str(), "visibility", on);
        let _ = app.emit_to(label.as_str(), "overlay", over);
        if label != "notch" {
            let _ = w.set_ignore_cursor_events(over);
        }
        if !on {
            let _ = w.hide();
        } else if !w.is_visible().unwrap_or(true) {
            restore(app, &w);
            let _ = w.show();
        }
    }
    layer(app);
}

fn on_desk(label: &str) -> bool {
    !matches!(label, "stats" | "tabpanel" | "notch")
}

fn class_is_desktop(h: HWND) -> bool {
    let mut c = [0u16; 16];
    let n = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetClassNameW(h, c.as_mut_ptr(), 16) } as usize;
    matches!(String::from_utf16_lossy(&c[..n]).as_str(), "WorkerW" | "Progman")
}

fn top_at_center(h: HWND) -> HWND {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let mut r: RECT = std::mem::zeroed();
        GetWindowRect(h, &mut r);
        GetAncestor(WindowFromPoint(POINT { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }), GA_ROOT)
    }
}

fn target() -> HWND {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    if RAISED.load(Relaxed) || !visible() { HWND_TOPMOST } else { HWND_BOTTOM }
}

unsafe extern "system" fn keep_layer(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _: usize, _: usize) -> LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    if msg == WM_WINDOWPOSCHANGING {
        let p = &mut *(lp as *mut WINDOWPOS);
        if p.flags & SWP_NOZORDER == 0 {
            p.hwndInsertAfter = target();
        }
    }
    windows_sys::Win32::UI::Shell::DefSubclassProc(h, msg, wp, lp)
}

fn layer(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let wins: Vec<HWND> = app.webview_windows().iter().filter(|(l, _)| on_desk(l)).filter_map(|(_, w)| w.hwnd().ok()).map(|h| h.0 as HWND).collect();
    unsafe {
        if !class_is_desktop(GetForegroundWindow()) {
            RAISED.store(false, Relaxed);
        } else if wins.iter().any(|&h| IsWindowVisible(h) != 0 && class_is_desktop(top_at_center(h))) {
            RAISED.store(true, Relaxed);
        }
        for &h in &wins {
            if IsIconic(h) != 0 {
                ShowWindow(h, SW_SHOWNOACTIVATE);
            }
            SetWindowPos(h, target(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

unsafe extern "system" fn on_foreground(_: windows_sys::Win32::UI::Accessibility::HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    let Some(app) = APP.get() else { return };
    layer(app);
    let app = app.clone();
    thread::spawn(move || {
        for ms in [300, 700] {
            thread::sleep(Duration::from_millis(ms));
            layer(&app);
        }
    });
}

fn no_activate(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    if let Ok(h) = w.hwnd() {
        unsafe { SetWindowLongPtrW(h.0 as _, GWL_EXSTYLE, GetWindowLongPtrW(h.0 as _, GWL_EXSTYLE) | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize) };
    }
}

fn base<'a>(app: &'a AppHandle, label: &str, title: String, w: f64, h: f64) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(w, h)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --renderer-process-limit=1")
}

fn place_notch(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    // The screen picked in Settings > Notch, or the main one.
    let want = NOTCH_MONITOR.lock().unwrap().clone();
    let picked = w.available_monitors().unwrap_or_default().into_iter().find(|m| !want.is_empty() && m.name().is_some_and(|n| *n == want));
    let (Some(m), Ok(h)) = (picked.or(w.primary_monitor().ok().flatten()), w.hwnd()) else { return };
    let k = m.scale_factor();
    let (pw, ph) = ((NOTCH_SIZE.0 * k) as i32, (NOTCH_SIZE.1 * k) as i32);
    let (x, y) = (m.position().x + (m.size().width as i32 - pw) / 2, m.position().y);
    unsafe { SetWindowPos(h.0 as _, HWND_TOPMOST, x, y, pw, ph, SWP_NOACTIVATE) };
}

static NOTCH_AUTOHIDE: AtomicBool = AtomicBool::new(false);
static NOTCH_SHOWN: AtomicBool = AtomicBool::new(true);

#[tauri::command]
fn notch_monitor(app: AppHandle, name: String) {
    if *NOTCH_MONITOR.lock().unwrap() != name {
        *NOTCH_MONITOR.lock().unwrap() = name;
        if let Some(w) = app.get_webview_window("notch") {
            place_notch(&w);
        }
    }
}

/// Screens for Settings > Notch: (name, is main screen, width, height) in physical pixels.
#[tauri::command]
fn monitors(app: AppHandle) -> Vec<(String, bool, u32, u32)> {
    let Some(w) = app.get_webview_window("stats") else { return vec![] };
    let main = w.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    w.available_monitors().unwrap_or_default().iter().filter_map(|m| {
        let n = m.name()?.clone();
        Some((n.clone(), Some(&n) == main.as_ref(), m.size().width, m.size().height))
    }).collect()
}

#[tauri::command]
fn notch(w: f64, h: f64, autohide: Option<bool>) {
    *NOTCH.lock().unwrap() = (w, h);
    if let Some(a) = autohide {
        NOTCH_AUTOHIDE.store(a, Relaxed);
    }
}

// True when an app window (not the desktop, not the notch) sits at this point.
// Click-through windows (the idle notch, game overlays) don't count: WindowFromPoint skips them.
fn app_under(notch: HWND, x: i32, y: i32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    unsafe {
        let h = GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT);
        !h.is_null() && h != notch && !class_is_desktop(h)
    }
}

fn notch_hover(app: &AppHandle) {
    let mut wanted = std::time::Instant::now();
    let mut edge_at: Option<std::time::Instant> = None;
    loop {
        let win = app.get_webview_window("notch");
        if let Some(w) = &win {
            let mut c = POINT { x: 0, y: 0 };
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut c) };
            let (rw, rh) = *NOTCH.lock().unwrap();
            let (mut inside, mut show) = (false, true);
            if let (Ok(p), Ok(s), Ok(k), Ok(h), true) = (w.outer_position(), w.outer_size(), w.scale_factor(), w.hwnd(), visible() && w.is_visible().unwrap_or(false)) {
                let (cx, cy, mid) = (c.x as f64, c.y as f64, p.x as f64 + s.width as f64 / 2.0);
                inside = (cx - mid).abs() < rw * k / 2.0 && c.y >= p.y && cy < p.y as f64 + rh * k;
                // Auto-hide: hidden while an app is under the notch's spot. Coming close isn't enough to bring it
                // back, or it would pop up over browser tabs right when you click them. Instead, rest the mouse on
                // the top edge of the screen for a moment; once it's out it stays while the mouse is on it.
                if NOTCH_AUTOHIDE.load(Relaxed) {
                    let over_app = app_under(h.0 as HWND, mid as i32, p.y + 2);
                    let edge = (cx - mid).abs() < (rw.max(200.0) / 2.0 + 30.0) * k && c.y >= p.y - 2 && c.y <= p.y + 1;
                    edge_at = if edge { edge_at.or(Some(std::time::Instant::now())) } else { None };
                    let held = edge_at.is_some_and(|t| t.elapsed() >= Duration::from_millis(300));
                    if !over_app || held || (inside && NOTCH_SHOWN.load(Relaxed)) {
                        wanted = std::time::Instant::now();
                    }
                    show = wanted.elapsed() < Duration::from_millis(350);
                }
            }
            inside &= show;
            if show != NOTCH_SHOWN.swap(show, Relaxed) {
                let _ = app.emit_to("notch", "reveal", show);
            }
            if inside != NOTCH_IN.swap(inside, Relaxed) {
                let _ = w.set_ignore_cursor_events(!inside);
                let _ = app.emit_to("notch", "hover", inside);
            }
        }
        thread::sleep(Duration::from_millis(if win.is_some() { 40 } else { 500 }));
    }
}

fn audio() -> windows::core::Result<windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume> {
    use windows::Win32::{Media::Audio::*, System::Com::*};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        e.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

#[tauri::command]
async fn volume(delta: Option<f32>, set: Option<f32>, mute: Option<bool>) -> Option<(f32, bool)> {
    let v = audio().ok()?;
    unsafe {
        let now = v.GetMasterVolumeLevelScalar().ok()?;
        if let Some(l) = set.or(delta.map(|d| now + d)) {
            let _ = v.SetMasterVolumeLevelScalar(l.clamp(0.0, 1.0), std::ptr::null());
            let _ = v.SetMute(false, std::ptr::null());
        }
        if let Some(m) = mute {
            let _ = v.SetMute(m, std::ptr::null());
        }
        Some((v.GetMasterVolumeLevelScalar().ok()?, v.GetMute().ok()?.as_bool()))
    }
}

/// Spotify's audio sessions: its row in the Windows volume mixer (sometimes more than one).
fn spotify_sessions() -> Vec<windows::Win32::Media::Audio::ISimpleAudioVolume> {
    use windows::core::Interface;
    use windows::Win32::{Media::Audio::*, System::Com::*};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(e) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return vec![] };
        let Ok(d) = e.GetDefaultAudioEndpoint(eRender, eConsole) else { return vec![] };
        let Ok(list) = d.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None).and_then(|m| m.GetSessionEnumerator()) else { return vec![] };
        (0..list.GetCount().unwrap_or(0))
            .filter_map(|i| {
                let s = list.GetSession(i).ok()?;
                let pid = s.cast::<IAudioSessionControl2>().ok()?.GetProcessId().ok()?;
                if exe_name(pid).eq_ignore_ascii_case("spotify.exe") { s.cast::<ISimpleAudioVolume>().ok() } else { None }
            })
            .collect()
    }
}

/// Spotify's own volume, not the PC's. None when Spotify isn't playing sound on this PC.
#[tauri::command]
async fn spotify_volume(delta: Option<f32>, set: Option<f32>, mute: Option<bool>) -> Option<(f32, bool)> {
    let all = spotify_sessions();
    let first = all.first()?;
    unsafe {
        let now = first.GetMasterVolume().ok()?;
        for v in &all {
            if let Some(l) = set.or(delta.map(|d| now + d)) {
                let _ = v.SetMasterVolume(l.clamp(0.0, 1.0), std::ptr::null());
                let _ = v.SetMute(false, std::ptr::null());
            }
            if let Some(m) = mute {
                let _ = v.SetMute(m, std::ptr::null());
            }
        }
        Some((first.GetMasterVolume().ok()?, first.GetMute().ok()?.as_bool()))
    }
}

fn exe_name(pid: u32) -> String {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return String::new();
        }
        let (mut buf, mut n) = ([0u16; 260], 260u32);
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut n);
        CloseHandle(h);
        if ok == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize]).rsplit('\\').next().unwrap_or_default().to_string()
    }
}

type Meter = windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
type Vol = windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;

// The system volume plus a peak meter on Spotify's own audio session, so the
// notch bars move with the music and not with game or browser sound.
fn audio_parts() -> (Option<Vol>, Option<Meter>) {
    use windows::core::Interface;
    use windows::Win32::{Media::Audio::*, System::Com::*};
    unsafe {
        let e: IMMDeviceEnumerator = match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
            Ok(e) => e,
            Err(_) => return (None, None),
        };
        let Ok(d) = e.GetDefaultAudioEndpoint(eRender, eConsole) else { return (None, None) };
        let vol = d.Activate::<Vol>(CLSCTX_ALL, None).ok();
        let mut meter = None;
        if let Ok(list) = d.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None).and_then(|m| m.GetSessionEnumerator()) {
            for i in 0..list.GetCount().unwrap_or(0) {
                let Ok(s) = list.GetSession(i) else { continue };
                let Ok(pid) = s.cast::<IAudioSessionControl2>().and_then(|s| s.GetProcessId()) else { continue };
                if !exe_name(pid).eq_ignore_ascii_case("spotify.exe") {
                    continue;
                }
                let active = matches!(s.GetState(), Ok(st) if st == AudioSessionStateActive);
                if let (Ok(m), true) = (s.cast::<Meter>(), active || meter.is_none()) {
                    meter = Some(m);
                }
            }
        }
        (vol, meter)
    }
}

fn notch_audio(app: &AppHandle) {
    unsafe {
        let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
    }
    let (mut vol, mut meter): (Option<Vol>, Option<Meter>) = (None, None);
    let (mut last_vol, mut last_lv, mut n) = (None::<(f32, bool)>, -2.0f32, 0u32);
    loop {
        let on = visible() && app.get_webview_window("notch").is_some_and(|w| w.is_visible().unwrap_or(false));
        if !on {
            (vol, meter, last_vol, last_lv, n) = (None, None, None, -2.0, 0);
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        if n % 60 == 0 {
            (vol, meter) = audio_parts();
        }
        n += 1;
        if let Some(v) = &vol {
            if let (Ok(l), Ok(m)) = unsafe { (v.GetMasterVolumeLevelScalar(), v.GetMute()) } {
                let cur = ((l * 100.0).round() / 100.0, m.as_bool());
                if last_vol.is_some_and(|p| p != cur) {
                    let _ = app.emit_to("notch", "sysvol", cur);
                }
                last_vol = Some(cur);
            }
        }
        let lv = meter.as_ref().and_then(|m| unsafe { m.GetPeakValue() }.ok()).map_or(-1.0, |p| (p * 50.0).round() / 50.0);
        if lv != last_lv {
            let _ = app.emit_to("notch", "level", lv);
            last_lv = lv;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[tauri::command]
fn open_spotify(id: String) {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
        shell_open(&format!("spotify:track:{id}"));
    }
}

fn shell_open(target: &str) {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY, SW_SHOWNORMAL}};
    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let (op, uri) = (wide("open"), wide(target));
    unsafe {
        AllowSetForegroundWindow(ASFW_ANY);
        ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), uri.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

/// Opens a web page in the default browser: any https link, or the local logger (Spotify sign-in).
#[tauri::command]
fn open_url(url: String) {
    if url.starts_with("https://") || url.starts_with("http://127.0.0.1:8721/") {
        shell_open(&url);
    }
}

#[tauri::command]
fn devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

fn logger_up() -> bool {
    std::net::TcpStream::connect_timeout(&"127.0.0.1:8721".parse().unwrap(), Duration::from_millis(200)).is_ok()
}

/// Second half of "Restart logger": the page asks the old logger to exit, then this starts a new one.
#[tauri::command]
async fn start_logger() -> bool {
    for _ in 0..80 {
        if !logger_up() {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if let Some(mut old) = BACKEND.lock().unwrap().take() {
        let _ = old.try_wait();
    }
    start_backend();
    for _ in 0..150 {
        if logger_up() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

#[tauri::command]
fn media(key: String) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    let vk = match key.as_str() {
        "prev" => VK_MEDIA_PREV_TRACK,
        "next" => VK_MEDIA_NEXT_TRACK,
        _ => VK_MEDIA_PLAY_PAUSE,
    } as u8;
    unsafe {
        keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, 0);
        keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
    }
}

fn save_position(app: &AppHandle, label: &str, x: i32, y: i32) {
    if let Some(file) = position_file(app, label) {
        let _ = fs::create_dir_all(file.parent().unwrap());
        let _ = fs::write(&file, format!("{x},{y}"));
    }
}

fn snap(app: &AppHandle, label: &str) {
    use windows_sys::Win32::Graphics::Gdi::*;
    let Some(win) = app.get_webview_window(label) else { return };
    let (Ok(p), Ok(s), Ok(f), Ok(h)) = (win.outer_position(), win.outer_size(), win.scale_factor(), win.hwnd()) else { return };
    let k = f * f64::from_bits(SCALE.load(Relaxed));
    let (inset, gap, near) = ((16.0 * k) as i32, (12.0 * k) as i32, (18.0 * f) as i32);
    let card = |x: i32, y: i32, w: u32, h: u32| (x + inset, y + inset, x + w as i32 - inset, y + h as i32 - inset);
    let (l, t, r, b) = card(p.x, p.y, s.width, s.height);
    let (cw, ch) = (r - l, b - t);
    let mut mi: MONITORINFO = unsafe { std::mem::zeroed() };
    mi.cbSize = size_of::<MONITORINFO>() as u32;
    unsafe { GetMonitorInfoW(MonitorFromWindow(h.0 as _, MONITOR_DEFAULTTONEAREST), &mut mi) };
    let w = mi.rcWork;
    let (mut xs, mut ys) = (vec![w.left + gap, w.right - gap - cw], vec![w.top + gap, w.bottom - gap - ch]);
    for (other, o) in app.webview_windows() {
        if other == label || !on_desk(&other) || !o.is_visible().unwrap_or(false) {
            continue;
        }
        let (Ok(op), Ok(os)) = (o.outer_position(), o.outer_size()) else { continue };
        let (ol, ot, or, ob) = card(op.x, op.y, os.width, os.height);
        xs.extend([ol, or - cw, or + gap, ol - gap - cw]);
        ys.extend([ot, ob - ch, ob + gap, ot - gap - ch]);
    }
    let pick = |v: i32, c: &[i32]| c.iter().copied().filter(|x| (x - v).abs() <= near).min_by_key(|x| (x - v).abs()).unwrap_or(v);
    let (nl, nt) = (pick(l, &xs), pick(t, &ys));
    if (nl, nt) != (l, t) {
        let _ = win.set_position(PhysicalPosition::new(nl - inset, nt - inset));
    }
    save_position(app, label, nl - inset, nt - inset);
}

#[tauri::command]
fn reveal(path: String) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer").raw_arg(format!("/select,\"{path}\"")).spawn();
}

fn position_file(app: &AppHandle, label: &str) -> Option<std::path::PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(format!("{label}-position.txt")))
}

fn restore(app: &AppHandle, win: &tauri::WebviewWindow) {
    let Some(file) = position_file(app, win.label()) else { return };
    let saved: Vec<i32> = fs::read_to_string(file).unwrap_or_default().split(',').filter_map(|v| v.parse().ok()).collect();
    let [x, y] = saved[..] else { return };
    let on_screen = win.available_monitors().unwrap_or_default().iter().any(|m| {
        let (p, s) = (m.position(), m.size());
        let (cx, cy) = (x + 90, y + 60);
        cx >= p.x && cy >= p.y && cx < p.x + s.width as i32 && cy < p.y + s.height as i32
    });
    if on_screen {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

fn toggle(app: &AppHandle) {
    SHOWN.fetch_xor(true, Relaxed);
    sync(app);
}

#[tauri::command]
fn open_stats(app: AppHandle) {
    let w = app.get_webview_window("stats").unwrap();
    let _ = (w.show(), w.unminimize(), w.set_focus());
}

fn make(app: &AppHandle, label: &str, w: f64, h: f64, x: f64, y: f64) -> tauri::Result<()> {
    let title = if label == "widget" { "Wavelog Widget".into() } else { format!("Wavelog {label}") };
    let win = base(app, label, title, w, h).position(x, y).visible(shown(label)).build()?;
    no_activate(&win);
    let h = win.hwnd().map_or(0, |h| h.0 as isize);
    let _ = app.run_on_main_thread(move || unsafe {
        windows_sys::Win32::UI::Shell::SetWindowSubclass(h as _, Some(keep_layer), 1, 0);
    });
    restore(app, &win);
    let (app, label) = (app.clone(), label.to_string());
    win.on_window_event(move |e| {
        if let (WindowEvent::Moved(p), true) = (e, mouse_down()) {
            save_position(&app, &label, p.x, p.y);
            let mut drag = DRAG.lock().unwrap();
            if drag.is_none() {
                *drag = Some(label.clone());
                let (app, label) = (app.clone(), label.clone());
                thread::spawn(move || {
                    while mouse_down() {
                        thread::sleep(Duration::from_millis(30));
                    }
                    snap(&app, &label);
                    *DRAG.lock().unwrap() = None;
                });
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn set_widgets(app: AppHandle, list: Vec<(String, String)>, scale: Option<f64>, overlay: Option<Vec<String>>, tab_y: Option<f64>) -> Result<(), String> {
    // The stats page calls this twice at startup. Without the lock both calls see no window yet,
    // both build one, and the first copy loses its label: it never hides for games or reacts to hover.
    static BUSY: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
    let _busy = BUSY.get_or_init(|| tauri::async_runtime::Mutex::new(())).lock().await;
    if let Some(t) = tab_y {
        TAB_Y.store(t.clamp(0.0, 0.95).to_bits(), Relaxed);
    }
    if let Some(o) = overlay {
        *OVERLAY.lock().unwrap() = o;
    }
    match (app.get_webview_window("notch"), list.iter().any(|(l, _)| l == "notch")) {
        (Some(w), false) => {
            let _ = w.destroy();
        }
        (None, true) => {
            let w = base(&app, "notch", "Wavelog notch".into(), NOTCH_SIZE.0, NOTCH_SIZE.1).always_on_top(true).visible(shown("notch")).build().map_err(|e| e.to_string())?;
            no_activate(&w);
            NOTCH_IN.store(false, Relaxed);
            NOTCH_SHOWN.store(true, Relaxed);
            let _ = w.set_ignore_cursor_events(true);
            place_notch(&w);
        }
        _ => {}
    }
    let k = scale.unwrap_or(1.0).clamp(0.5, 1.5);
    SCALE.store(k.to_bits(), Relaxed);
    let (mut x, mut y) = (24.0, 24.0);
    for label in WIDGETS {
        let want = list.iter().find(|(l, _)| l == label).map(|(_, size)| dims(size)).map(|(w, h)| (w * k, h * k));
        match (app.get_webview_window(label), want) {
            (Some(win), None) => {
                let _ = win.destroy();
                LAST.lock().unwrap().remove(label);
            }
            (Some(win), Some((w, h))) => {
                let _ = win.set_size(tauri::LogicalSize::new(w, h));
                let _ = win.set_zoom(k);
            }
            (None, Some((w, h))) => {
                if y + h > 1000.0 {
                    (x, y) = (x + 390.0 * k, 24.0);
                }
                make(&app, label, w, h, x, y).map_err(|e| e.to_string())?;
                let _ = app.get_webview_window(label).map(|win| win.set_zoom(k));
            }
            _ => {}
        }
        y += want.map_or(0.0, |(_, h)| h - 20.0);
    }
    sync(&app);
    Ok(())
}

#[tauri::command]
fn backdrop(window: tauri::WebviewWindow, force: Option<bool>) -> tauri::ipc::Response {
    use windows_sys::Win32::Graphics::Gdi::*;
    let (Ok(p), Ok(s), Ok(k)) = (window.outer_position(), window.outer_size(), window.scale_factor()) else {
        return tauri::ipc::Response::new(vec![]);
    };
    let own = window.hwnd().map_or(std::ptr::null_mut(), |h| h.0 as HWND);
    if !visible() || (force != Some(true) && top_at_center(own) != own) {
        return tauri::ipc::Response::new(vec![]);
    }
    let m = (32.0 * k) as i32;
    let (fw, fh) = (s.width as i32 + 2 * m, s.height as i32 + 2 * m);
    let (w, h) = (fw / 2, fh / 2);
    let mut buf = vec![0u8; 8 + (w * h * 4) as usize];
    buf[..4].copy_from_slice(&(w as u32).to_le_bytes());
    buf[4..8].copy_from_slice(&(h as u32).to_le_bytes());
    unsafe {
        let screen = GetDC(std::ptr::null_mut());
        let dc = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, bmp);
        SetStretchBltMode(dc, HALFTONE);
        StretchBlt(dc, 0, 0, w, h, screen, p.x - m, p.y - m, fw, fh, SRCCOPY);
        SelectObject(dc, old);
        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        GetDIBits(dc, bmp, 0, h as u32, buf[8..].as_mut_ptr() as _, &mut bi, DIB_RGB_COLORS);
        DeleteObject(bmp);
        DeleteDC(dc);
        ReleaseDC(std::ptr::null_mut(), screen);
    }
    let (x0, y0, x1, y1) = (m / 2, m / 2, (m + s.width as i32) / 2, (m + s.height as i32) / 2);
    let mut hash = 0xcbf29ce484222325u64;
    for (i, px) in buf[8..].chunks_exact_mut(4).enumerate() {
        let (x, y) = (i as i32 % w, i as i32 / w);
        if x >= x0 && x < x1 && y >= y0 && y < y1 {
            px.fill(0);
        } else {
            px[3] = 255;
            if i % 7 == 0 {
                hash = (hash ^ (px[0] as u64 | (px[1] as u64) << 8 | (px[2] as u64) << 16)).wrapping_mul(0x100000001b3);
            }
        }
    }
    if LAST.lock().unwrap().insert(window.label().into(), hash) == Some(hash) && force != Some(true) {
        buf.clear();
    }
    tauri::ipc::Response::new(buf)
}

fn valorant_front() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let mut t = [0u16; 16];
    let n = unsafe { GetWindowTextW(GetForegroundWindow(), t.as_mut_ptr(), 16) } as usize;
    String::from_utf16_lossy(&t[..n]).starts_with("VALORANT")
}

fn place(h: HWND) {
    use windows_sys::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};
    unsafe {
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = size_of::<MONITORINFO>() as u32;
        GetMonitorInfoW(MonitorFromWindow(GetForegroundWindow(), MONITOR_DEFAULTTONEAREST), &mut mi);
        let (m, mut r): (RECT, RECT) = (mi.rcMonitor, std::mem::zeroed());
        GetWindowRect(h, &mut r);
        let x = m.left + (m.right - m.left - (r.right - r.left)) / 2;
        let y = m.top + ((m.bottom - m.top) as f64 * f64::from_bits(TAB_Y.load(Relaxed))) as i32;
        SetWindowPos(h, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

fn tab_panel(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    loop {
        let on = FULLSCREEN.load(Relaxed) && SHOWN.load(Relaxed) && valorant_front();
        let panel = app.get_webview_window("tabpanel");
        if on && panel.is_none() {
            if let Ok(w) = base(app, "tabpanel", "Wavelog tab panel".into(), 740.0, 200.0).always_on_top(true).visible(false).build() {
                let _ = w.set_ignore_cursor_events(true);
                no_activate(&w);
            }
            continue;
        }
        let down = on && unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x09) } < 0;
        if down != TAB.load(Relaxed) {
            TAB.store(down, Relaxed);
            if let Some(Ok(h)) = panel.as_ref().map(|w| w.hwnd()) {
                let _ = app.emit_to("tabpanel", "visibility", down);
                if down {
                    place(h.0 as _);
                }
                unsafe { ShowWindow(h.0 as _, if down { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
            }
        }
        thread::sleep(Duration::from_millis(if on { 30 } else { 400 }));
    }
}

fn fullscreen_foreground() -> bool {
    use windows_sys::Win32::{Graphics::Gdi::*, UI::WindowsAndMessaging::*};
    unsafe {
        let h = GetForegroundWindow();
        let mut pid = 0;
        GetWindowThreadProcessId(h, &mut pid);
        if h.is_null() || pid == std::process::id() || h == GetShellWindow() {
            return false;
        }
        if class_is_desktop(h) {
            return false;
        }
        let mut r: RECT = std::mem::zeroed();
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = size_of::<MONITORINFO>() as u32;
        GetWindowRect(h, &mut r);
        GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi);
        let m = mi.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|a| a == "--autostart") {
                open_stats(app.clone());
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+alt+s"])
                .unwrap()
                .with_handler(|app, _, e| if e.state == ShortcutState::Pressed { toggle(app) })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![open_stats, backdrop, set_widgets, reveal, notch, media, volume, spotify_volume, open_spotify, open_url, devtools, start_logger, notch_monitor, monitors])
        .setup(|app| {
            FULLSCREEN.store(fullscreen_foreground(), Relaxed);
            let _ = APP.set(app.handle().clone());
            unsafe {
                use windows_sys::Win32::UI::{Accessibility::SetWinEventHook, WindowsAndMessaging::*};
                SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, std::ptr::null_mut(), Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT);
            }
            start_backend();
            let stats = app.get_webview_window("stats").unwrap();
            let s = stats.clone();
            stats.on_window_event(move |e| {
                if let WindowEvent::CloseRequested { api, .. } = e {
                    api.prevent_close();
                    let _ = s.hide();
                }
            });

            let menu = Menu::with_items(app, &[
                &MenuItem::with_id(app, "toggle", "Show or hide widgets", true, Some("ctrl+alt+s"))?,
                &MenuItem::with_id(app, "stats", "Open stats", true, None::<&str>)?,
                &MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?,
                &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
            ])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Wavelog")
                .menu(&menu)
                .on_menu_event(|app, e| match e.id.as_ref() {
                    "toggle" => toggle(app),
                    "stats" => open_stats(app.clone()),
                    "settings" => {
                        open_stats(app.clone());
                        let _ = app.emit_to("stats", "open-settings", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            thread::spawn(move || tab_panel(&handle));
            let handle = app.handle().clone();
            thread::spawn(move || notch_hover(&handle));
            let handle = app.handle().clone();
            thread::spawn(move || notch_audio(&handle));
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                let f = fullscreen_foreground();
                if f != FULLSCREEN.swap(f, Relaxed) {
                    sync(&handle);
                }
                thread::sleep(Duration::from_secs(1));
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start")
        .run(|_, e| {
            if let tauri::RunEvent::Exit = e {
                if let Some(mut c) = BACKEND.lock().unwrap().take() {
                    let _ = c.kill();
                }
            }
        });
}
