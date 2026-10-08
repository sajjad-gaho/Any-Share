//! Non-Windows stubs: every native operation reports `unsupported`.

use super::{Monitor, Platform, Rect};
use crate::protocol::{ButtonAction, KeyAction, MouseButton, ProtocolError};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct StubPlatform;

fn unsupported<T>() -> Result<T, ProtocolError> {
    Err(ProtocolError::new(
        "unsupported",
        "Only supported on Windows",
    ))
}

impl Platform for StubPlatform {
    fn monitors(&self) -> Result<Vec<Monitor>, ProtocolError> {
        unsupported()
    }
    fn virtual_screen(&self) -> Rect {
        Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        }
    }
    fn mouse_move(&self, _x: i32, _y: i32) -> Result<(), ProtocolError> {
        unsupported()
    }
    fn mouse_button(&self, _b: MouseButton, _a: ButtonAction) -> Result<(), ProtocolError> {
        unsupported()
    }
    fn mouse_scroll(&self, _x: i32, _y: i32) -> Result<(), ProtocolError> {
        unsupported()
    }
    fn key(&self, _s: u16, _e: bool, _a: KeyAction) -> Result<(), ProtocolError> {
        unsupported()
    }
    fn get_clipboard(&self) -> Result<String, ProtocolError> {
        unsupported()
    }
    fn set_clipboard(&self, _t: &str) -> Result<(), ProtocolError> {
        unsupported()
    }
}

pub fn init_process() {}

pub fn capture_loop(
    _monitor: Monitor,
    _max_fps: u32,
    _max_width: u32,
    _stop: Arc<AtomicBool>,
    _emit: &mut dyn FnMut(&serde_json::Value, &[u8]) -> std::io::Result<()>,
) -> Result<(), ProtocolError> {
    unsupported()
}
