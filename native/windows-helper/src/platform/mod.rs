//! Native operations. Windows-only; other targets compile stubs so the
//! protocol layer can be unit-tested anywhere.

use crate::protocol::{ButtonAction, KeyAction, MouseButton, ProtocolError};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    /// GDI device name, e.g. `\\.\DISPLAY1`. Stable while the display configuration is.
    pub id: String,
    pub name: String,
    pub primary: bool,
    /// Physical pixels in virtual-desktop coordinates.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub scale_factor: f64,
    pub refresh_hz: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

/// Everything the command loop needs from the OS.
pub trait Platform: Send + Sync {
    fn monitors(&self) -> Result<Vec<Monitor>, ProtocolError>;
    fn virtual_screen(&self) -> Rect;
    fn mouse_move(&self, x: i32, y: i32) -> Result<(), ProtocolError>;
    fn mouse_button(&self, button: MouseButton, action: ButtonAction) -> Result<(), ProtocolError>;
    fn mouse_scroll(&self, delta_x: i32, delta_y: i32) -> Result<(), ProtocolError>;
    fn key(&self, scancode: u16, extended: bool, action: KeyAction) -> Result<(), ProtocolError>;
    fn get_clipboard(&self) -> Result<String, ProtocolError>;
    fn set_clipboard(&self, text: &str) -> Result<(), ProtocolError>;
}

#[cfg(windows)]
mod windows_impl;
#[cfg(windows)]
pub use windows_impl::{capture_loop, init_process, WindowsPlatform as NativePlatform};

#[cfg(windows)]
pub mod capture;

#[cfg(not(windows))]
mod stub;
#[cfg(not(windows))]
pub use stub::{capture_loop, init_process, StubPlatform as NativePlatform};

/// Box-free downscale target: keeps aspect ratio, never upscales, even dimensions.
pub fn scaled_size(width: u32, height: u32, max_width: u32) -> (u32, u32) {
    if width <= max_width {
        return (width & !1, height & !1);
    }
    let scaled_height = (u64::from(height) * u64::from(max_width) / u64::from(width)) as u32;
    (max_width & !1, scaled_height.max(2) & !1)
}

/// Nearest-neighbour BGRA downscale from a strided source into a tight buffer.
pub fn downscale_bgra(
    src: &[u8],
    src_width: u32,
    src_height: u32,
    src_stride: usize,
    dst_width: u32,
    dst_height: u32,
) -> Vec<u8> {
    let mut out = vec![0u8; dst_width as usize * dst_height as usize * 4];
    for y in 0..dst_height as usize {
        let sy = (y as u64 * u64::from(src_height) / u64::from(dst_height)) as usize;
        let row = &src[sy * src_stride..];
        let out_row = &mut out[y * dst_width as usize * 4..(y + 1) * dst_width as usize * 4];
        if dst_width == src_width {
            out_row.copy_from_slice(&row[..dst_width as usize * 4]);
            continue;
        }
        for x in 0..dst_width as usize {
            let sx = (x as u64 * u64::from(src_width) / u64::from(dst_width)) as usize;
            out_row[x * 4..x * 4 + 4].copy_from_slice(&row[sx * 4..sx * 4 + 4]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_without_upscaling() {
        assert_eq!(scaled_size(1920, 1080, 1280), (1280, 720));
        assert_eq!(scaled_size(1280, 720, 1920), (1280, 720));
        assert_eq!(scaled_size(1365, 767, 4000), (1364, 766));
        assert_eq!(scaled_size(3840, 2160, 1366), (1366, 768));
    }

    #[test]
    fn downscales_bgra_with_stride() {
        // 4x2 source with 4 bytes of row padding; pixel value = column index.
        let stride = 4 * 4 + 4;
        let mut src = vec![0u8; stride * 2];
        for y in 0..2 {
            for x in 0..4 {
                src[y * stride + x * 4] = x as u8;
                src[y * stride + x * 4 + 1] = y as u8;
            }
        }
        let out = downscale_bgra(&src, 4, 2, stride, 2, 2);
        assert_eq!(out.len(), 2 * 2 * 4);
        assert_eq!(out[0], 0);
        assert_eq!(out[4], 2);
        assert_eq!(out[8 + 1], 1);
        let same = downscale_bgra(&src, 4, 2, stride, 4, 2);
        assert_eq!(same[12], 3);
    }

    #[test]
    fn rect_contains() {
        let r = Rect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert!(r.contains(-1920, 0));
        assert!(r.contains(-1, 1079));
        assert!(!r.contains(0, 0));
    }
}
