//! Win32 implementations: monitors (GDI + per-monitor DPI), input (SendInput),
//! clipboard (CF_UNICODETEXT).

use super::{Monitor, Platform, Rect};
use crate::protocol::{ButtonAction, KeyAction, MouseButton, ProtocolError};
use std::mem::size_of;
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, EnumDisplaySettingsW, GetMonitorInfoW, DEVMODEW, ENUM_CURRENT_SETTINGS,
    HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::HiDpi::{
    GetDpiForMonitor, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, MONITORINFOF_PRIMARY, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
    SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

pub use super::capture::capture_loop;

const CF_UNICODETEXT: u32 = 13;

/// Coordinates must be physical pixels, consistent with DXGI capture.
pub fn init_process() {
    // Ignore failure: it only fails if awareness was already set (e.g. by a manifest).
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
}

pub struct WindowsPlatform;

fn win_error(code: &'static str, context: &str) -> ProtocolError {
    let error = windows::core::Error::from_thread();
    ProtocolError::new(code, format!("{context}: {}", error.message()))
}

fn send(inputs: &[INPUT]) -> Result<(), ProtocolError> {
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        // Typically UIPI: the foreground window belongs to a higher-integrity
        // process (e.g. an elevated app or the UAC secure desktop).
        return Err(win_error("input_blocked", "Windows rejected the input"));
    }
    Ok(())
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn wide_to_string(wide: &[u16]) -> String {
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..len])
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let list = &mut *(data.0 as *mut Vec<HMONITOR>);
    list.push(monitor);
    BOOL(1)
}

impl Platform for WindowsPlatform {
    fn monitors(&self) -> Result<Vec<Monitor>, ProtocolError> {
        let mut handles: Vec<HMONITOR> = Vec::new();
        let ok = unsafe {
            EnumDisplayMonitors(
                None,
                None,
                Some(collect_monitor),
                LPARAM(&mut handles as *mut Vec<HMONITOR> as isize),
            )
        };
        if !ok.as_bool() {
            return Err(win_error("os_error", "EnumDisplayMonitors failed"));
        }
        let mut monitors = Vec::with_capacity(handles.len());
        for (index, handle) in handles.into_iter().enumerate() {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
            let ok = unsafe {
                GetMonitorInfoW(handle, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO)
            };
            if !ok.as_bool() {
                continue;
            }
            let rect = info.monitorInfo.rcMonitor;
            let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
            let _ = unsafe { GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) };
            let mut mode = DEVMODEW {
                dmSize: size_of::<DEVMODEW>() as u16,
                ..Default::default()
            };
            let refresh = if unsafe {
                EnumDisplaySettingsW(
                    PCWSTR(info.szDevice.as_ptr()),
                    ENUM_CURRENT_SETTINGS,
                    &mut mode,
                )
            }
            .as_bool()
            {
                mode.dmDisplayFrequency
            } else {
                0
            };
            monitors.push(Monitor {
                id: wide_to_string(&info.szDevice),
                name: format!("Display {}", index + 1),
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                x: rect.left,
                y: rect.top,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
                scale_factor: f64::from(dpi_x) / 96.0,
                refresh_hz: refresh,
            });
        }
        // Primary first, then left-to-right: a stable, intuitive order.
        monitors.sort_by_key(|m| (!m.primary, m.x, m.y));
        Ok(monitors)
    }

    fn virtual_screen(&self) -> Rect {
        unsafe {
            Rect {
                x: GetSystemMetrics(SM_XVIRTUALSCREEN),
                y: GetSystemMetrics(SM_YVIRTUALSCREEN),
                width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
                height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
            }
        }
    }

    fn mouse_move(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        let screen = self.virtual_screen();
        if !screen.contains(x, y) {
            return Err(ProtocolError::new(
                "invalid_args",
                "Position is outside the desktop",
            ));
        }
        // Absolute coordinates are normalised to 0..=65535 over the virtual desktop.
        let nx = ((i64::from(x - screen.x) * 65535) / i64::from((screen.width - 1).max(1))) as i32;
        let ny = ((i64::from(y - screen.y) * 65535) / i64::from((screen.height - 1).max(1))) as i32;
        send(&[mouse_input(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            nx,
            ny,
            0,
        )])
    }

    fn mouse_button(&self, button: MouseButton, action: ButtonAction) -> Result<(), ProtocolError> {
        let flags = match (button, action) {
            (MouseButton::Left, ButtonAction::Down) => MOUSEEVENTF_LEFTDOWN,
            (MouseButton::Left, ButtonAction::Up) => MOUSEEVENTF_LEFTUP,
            (MouseButton::Right, ButtonAction::Down) => MOUSEEVENTF_RIGHTDOWN,
            (MouseButton::Right, ButtonAction::Up) => MOUSEEVENTF_RIGHTUP,
            (MouseButton::Middle, ButtonAction::Down) => MOUSEEVENTF_MIDDLEDOWN,
            (MouseButton::Middle, ButtonAction::Up) => MOUSEEVENTF_MIDDLEUP,
        };
        send(&[mouse_input(flags, 0, 0, 0)])
    }

    fn mouse_scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), ProtocolError> {
        let mut inputs = Vec::with_capacity(2);
        if delta_y != 0 {
            inputs.push(mouse_input(MOUSEEVENTF_WHEEL, 0, 0, delta_y));
        }
        if delta_x != 0 {
            inputs.push(mouse_input(MOUSEEVENTF_HWHEEL, 0, 0, delta_x));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }

    fn key(&self, scancode: u16, extended: bool, action: KeyAction) -> Result<(), ProtocolError> {
        let mut flags: KEYBD_EVENT_FLAGS = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if action == KeyAction::Up {
            flags |= KEYEVENTF_KEYUP;
        }
        send(&[INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VIRTUAL_KEY(0),
                    wScan: scancode,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }])
    }

    fn get_clipboard(&self) -> Result<String, ProtocolError> {
        let _guard = ClipboardGuard::open()?;
        if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }.is_err() {
            return Ok(String::new());
        }
        let handle = unsafe { GetClipboardData(CF_UNICODETEXT) }
            .map_err(|_| win_error("clipboard_error", "Cannot read the clipboard"))?;
        let global = HGLOBAL(handle.0);
        let pointer = unsafe { GlobalLock(global) } as *const u16;
        if pointer.is_null() {
            return Err(win_error("clipboard_error", "Cannot lock clipboard data"));
        }
        let mut len = 0usize;
        // Bounded scan: never read more than the protocol allows.
        let max_units = crate::protocol::MAX_CLIPBOARD_BYTES;
        unsafe {
            while len < max_units && *pointer.add(len) != 0 {
                len += 1;
            }
        }
        let text = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(pointer, len) });
        let _ = unsafe { GlobalUnlock(global) };
        Ok(text)
    }

    fn set_clipboard(&self, text: &str) -> Result<(), ProtocolError> {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = wide.len() * 2;
        let global = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes) }
            .map_err(|_| win_error("clipboard_error", "Cannot allocate clipboard memory"))?;
        let pointer = unsafe { GlobalLock(global) } as *mut u16;
        if pointer.is_null() {
            let _ = unsafe { GlobalFree(Some(global)) };
            return Err(win_error("clipboard_error", "Cannot lock clipboard memory"));
        }
        unsafe {
            std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
            let _ = GlobalUnlock(global);
        }
        let _guard = match ClipboardGuard::open() {
            Ok(guard) => guard,
            Err(error) => {
                let _ = unsafe { GlobalFree(Some(global)) };
                return Err(error);
            }
        };
        if unsafe { EmptyClipboard() }.is_err() {
            let _ = unsafe { GlobalFree(Some(global)) };
            return Err(win_error("clipboard_error", "Cannot clear the clipboard"));
        }
        // On success the system owns the memory.
        if unsafe { SetClipboardData(CF_UNICODETEXT, Some(HANDLE(global.0))) }.is_err() {
            let _ = unsafe { GlobalFree(Some(global)) };
            return Err(win_error("clipboard_error", "Cannot set clipboard data"));
        }
        Ok(())
    }
}

/// Opens the clipboard (retrying briefly: another app may hold it) and always closes it.
struct ClipboardGuard;

impl ClipboardGuard {
    fn open() -> Result<Self, ProtocolError> {
        for _ in 0..10 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Err(win_error(
            "clipboard_busy",
            "The clipboard is in use by another application",
        ))
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

/// Real-hardware checks. Ignored by default because they touch the live
/// desktop; run with `cargo test -- --ignored`. Each test restores what it
/// changes (cursor position, clipboard text).
#[cfg(test)]
mod native_tests {
    use super::*;
    use crate::platform::capture::capture_loop;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    fn cursor() -> (i32, i32) {
        let mut point = POINT::default();
        unsafe { GetCursorPos(&mut point) }.unwrap();
        (point.x, point.y)
    }

    #[test]
    #[ignore]
    fn enumerates_monitors() {
        init_process();
        let monitors = WindowsPlatform.monitors().unwrap();
        assert!(!monitors.is_empty());
        assert_eq!(monitors.iter().filter(|m| m.primary).count(), 1);
        assert!(monitors[0].primary, "primary is listed first");
        for m in &monitors {
            assert!(m.width > 0 && m.height > 0 && m.scale_factor >= 1.0);
            println!("{m:?}");
        }
    }

    #[test]
    #[ignore]
    fn captures_a_frame_from_the_primary_monitor() {
        init_process();
        let monitor = WindowsPlatform
            .monitors()
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let mut frames = Vec::new();
        let stopper = Arc::clone(&stop);
        // Nudge the desktop so DXGI has a changed frame to report.
        let (x, y) = cursor();
        let _ = WindowsPlatform.mouse_move(x, y);
        let result = capture_loop(monitor.clone(), 10, 640, stop, &mut |header, pixels| {
            frames.push((header.clone(), pixels.len()));
            stopper.store(true, std::sync::atomic::Ordering::Relaxed);
            Ok(())
        });
        // An idle desktop may produce no frame before stop; that is not a failure
        // of the pipeline, so only assert on frames we did get.
        result.unwrap();
        if let Some((header, len)) = frames.first() {
            let w = header["width"].as_u64().unwrap() as usize;
            let h = header["height"].as_u64().unwrap() as usize;
            assert!(w <= 640);
            assert_eq!(*len, w * h * 4);
            println!("captured {w}x{h} from {}", monitor.id);
        }
    }

    #[test]
    #[ignore]
    fn moves_the_cursor_and_restores_it() {
        init_process();
        let original = cursor();
        let monitor = WindowsPlatform
            .monitors()
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let target = (
            monitor.x + monitor.width / 2,
            monitor.y + monitor.height / 2,
        );
        WindowsPlatform.mouse_move(target.0, target.1).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let moved = cursor();
        WindowsPlatform.mouse_move(original.0, original.1).unwrap();
        assert!(
            (moved.0 - target.0).abs() <= 2 && (moved.1 - target.1).abs() <= 2,
            "{moved:?} vs {target:?}"
        );
        assert!(WindowsPlatform.mouse_move(i32::MAX / 2, 0).is_err());
    }

    #[test]
    #[ignore]
    fn clipboard_round_trip_restores_previous_text() {
        let previous = WindowsPlatform.get_clipboard().unwrap();
        WindowsPlatform
            .set_clipboard("kestrel helper test ✓")
            .unwrap();
        let read = WindowsPlatform.get_clipboard().unwrap();
        WindowsPlatform.set_clipboard(&previous).unwrap();
        assert_eq!(read, "kestrel helper test ✓");
    }

    #[test]
    #[ignore]
    fn injects_a_harmless_key() {
        // F24 exists on no physical keyboard and no app binds it by default.
        let (scancode, extended) = crate::keymap::lookup("F24").unwrap();
        WindowsPlatform
            .key(scancode, extended, KeyAction::Down)
            .unwrap();
        WindowsPlatform
            .key(scancode, extended, KeyAction::Up)
            .unwrap();
    }
}
