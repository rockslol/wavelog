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
static NOTCH_CATCH: AtomicBool = AtomicBool::new(false);
static NOTCH_DROPS: AtomicBool = AtomicBool::new(true);
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

/// Something outside Wavelog sometimes drops the notch out of the always-on-top layer, and then every app covers it.
/// Its WS_EX_TOPMOST flag doesn't show this (tao writes it back on each style change), so look at what's above it:
/// if any of those windows isn't always-on-top, the notch was pushed down. Put it back.
fn notch_on_top(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::*;
    let Some(h) = app.get_webview_window("notch").and_then(|w| w.hwnd().ok()).map(|h| h.0 as HWND) else { return };
    unsafe {
        if IsWindowVisible(h) == 0 {
            return;
        }
        let mut above = GetWindow(h, GW_HWNDPREV);
        for _ in 0..1000 {
            if above.is_null() {
                return;
            }
            if GetWindowLongPtrW(above, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST == 0 {
                SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
                return;
            }
            above = GetWindow(above, GW_HWNDPREV);
        }
    }
}

unsafe extern "system" fn on_foreground(_: windows_sys::Win32::UI::Accessibility::HWINEVENTHOOK, _: u32, _: HWND, _: i32, _: i32, _: u32, _: u32) {
    let Some(app) = APP.get() else { return };
    layer(app);
    notch_on_top(app);
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
fn notch(w: f64, h: f64, autohide: Option<bool>, drops: Option<bool>) {
    *NOTCH.lock().unwrap() = (w, h);
    if let Some(a) = autohide {
        NOTCH_AUTOHIDE.store(a, Relaxed);
    }
    if let Some(d) = drops {
        NOTCH_DROPS.store(d, Relaxed);
    }
}

/// Drags shelf files out of the notch into Explorer, Discord, a browser. Runs on the main thread (sync command), which
/// has OLE set up; the shell builds the data object and the drag image. Copy or link only, so the shelf never moves a file.
#[tauri::command]
fn shelf_drag(window: tauri::WebviewWindow, paths: Vec<String>) -> bool {
    use windows::Win32::System::{Com::IDataObject, Ole::{IDropSource, DROPEFFECT_COPY, DROPEFFECT_LINK}};
    use windows::Win32::UI::Shell::{Common::ITEMIDLIST, *};
    let Ok(h) = window.hwnd() else { return false };
    unsafe {
        let ids: Vec<*const ITEMIDLIST> = paths.iter()
            .map(|p| ILCreateFromPathW(&windows::core::HSTRING::from(p.as_str())) as *const ITEMIDLIST)
            .filter(|p| !p.is_null()).collect();
        let drag = || -> windows::core::Result<()> {
            let data: IDataObject = SHCreateShellItemArrayFromIDLists(&ids)?.BindToHandler(None, &BHID_DataObject)?;
            SHDoDragDrop(Some(windows::Win32::Foundation::HWND(h.0 as _)), &data, None::<&IDropSource>, DROPEFFECT_COPY | DROPEFFECT_LINK)?;
            Ok(())
        };
        let ok = !ids.is_empty() && drag().is_ok();
        ids.into_iter().for_each(|p| ILFree(Some(p)));
        ok
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
            let (mut inside, mut near, mut show) = (false, false, true);
            if let (Ok(p), Ok(s), Ok(k), Ok(h), true) = (w.outer_position(), w.outer_size(), w.scale_factor(), w.hwnd(), visible() && w.is_visible().unwrap_or(false)) {
                let (cx, cy, mid) = (c.x as f64, c.y as f64, p.x as f64 + s.width as f64 / 2.0);
                inside = (cx - mid).abs() < rw * k / 2.0 && c.y >= p.y && cy < p.y as f64 + rh * k;
                near = (cx - mid).abs() < (rw.max(200.0) / 2.0 + 90.0) * k && c.y >= p.y && cy < p.y as f64 + (rh.max(34.0) + 90.0) * k;
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
            // A drag (button held) coming close lets the mouse through too, so files dragged from Explorer reach the
            // notch's drop handler. The page only opens the shelf once a file drag actually enters.
            let catch = inside || (show && near && NOTCH_DROPS.load(Relaxed) && mouse_down());
            if show != NOTCH_SHOWN.swap(show, Relaxed) {
                let _ = app.emit_to("notch", "reveal", show);
            }
            if catch != NOTCH_CATCH.swap(catch, Relaxed) {
                let _ = w.set_ignore_cursor_events(!catch);
            }
            if inside != NOTCH_IN.swap(inside, Relaxed) {
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

/// Apps recording from any microphone right now: active audio sessions on the capture devices. (Newer Windows 11
/// builds no longer write mic use to the CapabilityAccessManager registry keys, so this is the reliable way.)
#[tauri::command]
async fn mic_users() -> Vec<String> {
    session_apps(windows::Win32::Media::Audio::eCapture, false)
}

/// Apps (exe names) with an active audio session on any device of this direction. `loud`: only sessions that are
/// making sound right now (peak above a whisper).
fn session_apps(flow: windows::Win32::Media::Audio::EDataFlow, loud: bool) -> Vec<String> {
    use windows::core::Interface;
    use windows::Win32::{Media::Audio::*, System::Com::*};
    let mut out = vec![];
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(e) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let Ok(devices) = e.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { return out };
        for i in 0..devices.GetCount().unwrap_or(0) {
            let Ok(d) = devices.Item(i) else { continue };
            let Ok(list) = d.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None).and_then(|m| m.GetSessionEnumerator()) else { continue };
            for j in 0..list.GetCount().unwrap_or(0) {
                let Ok(s) = list.GetSession(j) else { continue };
                if !matches!(s.GetState(), Ok(st) if st == AudioSessionStateActive) {
                    continue;
                }
                if loud && s.cast::<Meter>().and_then(|m| m.GetPeakValue()).unwrap_or(0.0) < 0.01 {
                    continue;
                }
                let Ok(pid) = s.cast::<IAudioSessionControl2>().and_then(|s| s.GetProcessId()) else { continue };
                let name = exe_name(pid);
                if pid != 0 && !name.is_empty() && !out.contains(&name) {
                    out.push(name);
                }
            }
        }
    }
    out
}

// ---- Sound output switcher -------------------------------------------------------------------------------------
// Windows has no public API to change the default output. Everyone uses the undocumented IPolicyConfig (see the
// Audio Switch script); only SetDefaultEndpoint is called, the other slots just keep the vtable order.
#[allow(non_snake_case)]
mod policy {
    #[windows::core::interface("f8679f50-850a-41cf-9c72-430f290290c8")]
    pub unsafe trait IPolicyConfig: windows::core::IUnknown {
        fn GetMixFormat(&self) -> windows::core::HRESULT;
        fn GetDeviceFormat(&self) -> windows::core::HRESULT;
        fn ResetDeviceFormat(&self) -> windows::core::HRESULT;
        fn SetDeviceFormat(&self) -> windows::core::HRESULT;
        fn GetProcessingPeriod(&self) -> windows::core::HRESULT;
        fn SetProcessingPeriod(&self) -> windows::core::HRESULT;
        fn GetShareMode(&self) -> windows::core::HRESULT;
        fn SetShareMode(&self) -> windows::core::HRESULT;
        fn GetPropertyValue(&self) -> windows::core::HRESULT;
        fn SetPropertyValue(&self) -> windows::core::HRESULT;
        pub fn SetDefaultEndpoint(&self, id: windows::core::PCWSTR, role: windows::Win32::Media::Audio::ERole) -> windows::core::HRESULT;
        fn SetEndpointVisibility(&self) -> windows::core::HRESULT;
    }
}
use policy::IPolicyConfig;

fn take_pwstr(p: windows::core::PWSTR) -> String {
    unsafe {
        let s = p.to_string().unwrap_or_default();
        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _));
        s
    }
}

/// Playback devices: (id, name, is the default).
#[tauri::command]
async fn audio_outputs() -> Vec<(String, String, bool)> {
    use windows::Win32::{Devices::FunctionDiscovery::PKEY_Device_FriendlyName, Media::Audio::*, System::Com::*};
    let mut out = vec![];
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(e) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let default = e.GetDefaultAudioEndpoint(eRender, eConsole).and_then(|d| d.GetId()).map(take_pwstr).unwrap_or_default();
        let Ok(list) = e.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
        for i in 0..list.GetCount().unwrap_or(0) {
            let Ok(d) = list.Item(i) else { continue };
            let Ok(id) = d.GetId().map(take_pwstr) else { continue };
            let name = d.OpenPropertyStore(STGM_READ).and_then(|s| s.GetValue(&PKEY_Device_FriendlyName)).map(|v| v.to_string()).unwrap_or_default();
            let is_default = id == default;
            out.push((id, name, is_default));
        }
    }
    out
}

/// Makes this device the default output for everything (games, calls, music).
#[tauri::command]
async fn set_audio_output(id: String) -> bool {
    use windows::Win32::{Media::Audio::*, System::Com::*};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let clsid = windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
        let Ok(p) = CoCreateInstance::<_, IPolicyConfig>(&clsid, None, CLSCTX_ALL) else { return false };
        let w: Vec<u16> = id.encode_utf16().chain([0]).collect();
        [eConsole, eMultimedia, eCommunications].iter().all(|&r| p.SetDefaultEndpoint(windows::core::PCWSTR(w.as_ptr()), r).is_ok())
    }
}

// ---- Auto-ducking ----------------------------------------------------------------------------------------------
// Lowers Spotify (its own mixer row, not the PC) during calls, videos and games, and fades it back after.
// Settings come from the logger (notch.duck_*); Valorant match state and the fullscreen game from /duck/state.
const CALL_APPS: [&str; 14] = ["discord.exe", "teams.exe", "ms-teams.exe", "zoom.exe", "skype.exe", "slack.exe", "whatsapp.exe",
    "telegram.exe", "signal.exe", "chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe"];
const VIDEO_APPS: [&str; 11] = ["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vlc.exe", "mpv.exe",
    "mpc-hc64.exe", "mpc-be64.exe", "potplayermini64.exe", "microsoft.media.player.exe"];
static DUCK_BASE: Mutex<Option<f32>> = Mutex::new(None); // Spotify's volume before the dip, put back on exit too

#[derive(Clone, Copy)]
struct DuckCfg {
    calls: bool,
    videos: bool,
    valorant: bool,
    games: bool,
    level: f32,
}

fn http_get(path: &str) -> Option<serde_json::Value> {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect_timeout(&"127.0.0.1:8721".parse().ok()?, Duration::from_millis(500)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    write!(s, "GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    serde_json::from_str(buf.split_once("\r\n\r\n")?.1).ok()
}

fn duck_cfg() -> Option<DuckCfg> {
    let n = http_get("/settings")?.get("notch").cloned().unwrap_or_default();
    let on = |k: &str, d: bool| n.get(k).and_then(|v| v.as_bool()).unwrap_or(d);
    Some(DuckCfg {
        calls: on("duck_calls", true),
        videos: on("duck_videos", true),
        valorant: on("duck_valorant", true),
        games: on("duck_games", false),
        level: n.get("duck_level").and_then(|v| v.as_f64()).unwrap_or(0.25) as f32,
    })
}

fn set_spotify(sessions: &[windows::Win32::Media::Audio::ISimpleAudioVolume], v: f32) {
    for s in sessions {
        let _ = unsafe { s.SetMasterVolume(v.clamp(0.0, 1.0), std::ptr::null()) };
    }
}

fn fade(sessions: &[windows::Win32::Media::Audio::ISimpleAudioVolume], from: f32, to: f32) {
    for i in 1..=12 {
        let t = i as f32 / 12.0;
        set_spotify(sessions, from + (to - from) * (1.0 - (1.0 - t) * (1.0 - t)));
        thread::sleep(Duration::from_millis(50));
    }
}

fn ducker() {
    use std::time::Instant;
    let mut cfg = DuckCfg { calls: false, videos: false, valorant: false, games: false, level: 0.25 };
    let (mut cfg_at, mut state_at): (Option<Instant>, Option<Instant>) = (None, None);
    let (mut in_match, mut in_game) = (false, false);
    let (mut loud_start, mut loud_last): (Option<Instant>, Option<Instant>) = (None, None);
    let mut set_to: Option<f32> = None; // what we set while ducked
    let mut overridden = false; // the user moved the volume during a dip: leave it alone until the dip ends
    let mut clear_since: Option<Instant> = None;
    loop {
        if cfg_at.is_none_or(|t| t.elapsed() > Duration::from_secs(15)) {
            cfg_at = Some(Instant::now());
            if let Some(c) = duck_cfg() {
                cfg = c;
            }
        }
        let on = cfg.calls || cfg.videos || cfg.valorant || cfg.games;
        if (cfg.valorant || cfg.games) && state_at.is_none_or(|t| t.elapsed() > Duration::from_secs(5)) {
            state_at = Some(Instant::now());
            if let Some(j) = http_get("/duck/state") {
                in_match = j["valorant"] == "INGAME";
                in_game = j["game"].is_string();
            }
        }
        let call = cfg.calls && session_apps(windows::Win32::Media::Audio::eCapture, false).iter().any(|a| CALL_APPS.contains(&a.to_lowercase().as_str()));
        let video = cfg.videos && {
            if session_apps(windows::Win32::Media::Audio::eRender, true).iter().any(|a| VIDEO_APPS.contains(&a.to_lowercase().as_str())) {
                loud_last = Some(Instant::now());
                loud_start.get_or_insert(Instant::now());
            } else if loud_last.is_none_or(|t| t.elapsed() > Duration::from_secs(3)) {
                loud_start = None; // quiet for 3 s: the video stopped
            }
            loud_start.is_some_and(|t| t.elapsed() >= Duration::from_secs(2)) // ignore short sounds
        };
        let want = on && (call || video || (cfg.valorant && in_match) || (cfg.games && in_game));

        let sessions = spotify_sessions();
        match (sessions.first().and_then(|s| unsafe { s.GetMasterVolume() }.ok()), want) {
            (None, _) => (set_to, overridden, clear_since) = (None, false, None), // Spotify isn't playing on this PC
            (Some(cur), true) => {
                clear_since = None;
                if let Some(t) = set_to {
                    if (cur - t).abs() > 0.03 {
                        (set_to, overridden) = (None, true);
                        *DUCK_BASE.lock().unwrap() = None;
                    }
                } else if !overridden {
                    let target = cur * cfg.level;
                    *DUCK_BASE.lock().unwrap() = Some(cur);
                    fade(&sessions, cur, target);
                    set_to = Some(target);
                }
            }
            (Some(cur), false) => {
                overridden = false;
                if let Some(t) = set_to {
                    // Wait 2 s so a pause in a call or video doesn't bounce the volume.
                    if clear_since.get_or_insert(Instant::now()).elapsed() >= Duration::from_secs(2) {
                        if let Some(base) = DUCK_BASE.lock().unwrap().take() {
                            if (cur - t).abs() <= 0.03 {
                                fade(&sessions, cur, base);
                            }
                        }
                        (set_to, clear_since) = (None, None);
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(if on { 500 } else { 3000 }));
    }
}

// Camera in use: Media Foundation's sensor activity monitor reports which processes stream from a camera (also through
// Windows' shared Frame Server). It only watches; the camera isn't opened. Windows calls back whenever that changes.
static CAM_PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

#[windows::core::implement(windows::Win32::Media::MediaFoundation::IMFSensorActivitiesReportCallback)]
struct CamWatch;

impl windows::Win32::Media::MediaFoundation::IMFSensorActivitiesReportCallback_Impl for CamWatch_Impl {
    fn OnActivitiesReport(&self, report: windows::core::Ref<windows::Win32::Media::MediaFoundation::IMFSensorActivitiesReport>) -> windows::core::Result<()> {
        let r = report.ok()?;
        let mut pids = vec![];
        unsafe {
            for i in 0..r.GetCount()? {
                let a = r.GetActivityReport(i)?;
                for j in 0..a.GetProcessCount()? {
                    let p = a.GetProcessActivity(j)?;
                    if p.GetStreamingState()?.as_bool() {
                        pids.push(p.GetProcessId()?);
                    }
                }
            }
        }
        *CAM_PIDS.lock().unwrap() = pids;
        Ok(())
    }
}

fn camera_watch() {
    use windows::Win32::{Media::MediaFoundation::*, System::Com::*};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if MFStartup(MF_VERSION, MFSTARTUP_LITE).is_err() {
            return;
        }
        let cb: IMFSensorActivitiesReportCallback = CamWatch.into();
        let Ok(monitor) = MFCreateSensorActivityMonitor(&cb) else { return };
        if monitor.Start().is_err() {
            return;
        }
        loop {
            thread::sleep(Duration::from_secs(3600)); // keeps the monitor alive; Windows calls CamWatch on its own thread
        }
    }
}

/// Apps streaming from a camera right now.
#[tauri::command]
fn camera_users() -> Vec<String> {
    let mut out: Vec<String> = CAM_PIDS.lock().unwrap().iter().map(|&p| exe_name(p)).filter(|n| !n.is_empty()).collect();
    out.dedup();
    out
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
        .invoke_handler(tauri::generate_handler![open_stats, backdrop, set_widgets, reveal, notch, media, volume, spotify_volume, mic_users, camera_users, audio_outputs, set_audio_output, open_spotify, open_url, devtools, start_logger, notch_monitor, monitors, shelf_drag])
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
            thread::spawn(camera_watch);
            thread::spawn(ducker);
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                let f = fullscreen_foreground();
                if f != FULLSCREEN.swap(f, Relaxed) {
                    sync(&handle);
                }
                notch_on_top(&handle);
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
                if let Some(base) = DUCK_BASE.lock().unwrap().take() {
                    set_spotify(&spotify_sessions(), base); // don't leave Spotify quiet when Wavelog quits mid-dip
                }
            }
        });
}
