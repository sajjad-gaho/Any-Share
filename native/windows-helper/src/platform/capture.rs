//! Screen capture with DXGI Desktop Duplication.
//!
//! Frames are only produced when the desktop actually changed (DXGI reports
//! accumulated updates), are paced to `max_fps`, and are downscaled to
//! `max_width` before they leave the process. This is the native fallback
//! video source; the primary pipeline is Chromium's own WebRTC desktop
//! capture, which encodes on the GPU without copying frames through Node.

use super::{downscale_bgra, scaled_size, Monitor};
use crate::protocol::ProtocolError;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput1,
    IDXGIOutputDuplication, IDXGIResource, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_WAIT_TIMEOUT,
    DXGI_OUTDUPL_FRAME_INFO,
};

struct Duplication {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    staging: Option<ID3D11Texture2D>,
}

fn os_error(context: &str, error: windows::core::Error) -> ProtocolError {
    ProtocolError::new("capture_error", format!("{context}: {}", error.message()))
}

fn wide_to_string(wide: &[u16]) -> String {
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..len])
}

/// Finds the DXGI output for a GDI device name and starts duplicating it.
fn open(monitor_id: &str) -> Result<Duplication, ProtocolError> {
    let factory: IDXGIFactory1 =
        unsafe { CreateDXGIFactory1() }.map_err(|e| os_error("CreateDXGIFactory1", e))?;
    let mut adapter_index = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(adapter_index) } {
        adapter_index += 1;
        let mut output_index = 0;
        while let Ok(output) = unsafe { adapter.EnumOutputs(output_index) } {
            output_index += 1;
            let Ok(desc) = (unsafe { output.GetDesc() }) else {
                continue;
            };
            if wide_to_string(&desc.DeviceName) != monitor_id {
                continue;
            }
            return duplicate(
                &adapter,
                &output
                    .cast::<IDXGIOutput1>()
                    .map_err(|e| os_error("IDXGIOutput1", e))?,
            );
        }
    }
    Err(ProtocolError::new("unknown_monitor", "No such monitor"))
}

fn duplicate(adapter: &IDXGIAdapter1, output: &IDXGIOutput1) -> Result<Duplication, ProtocolError> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let base: IDXGIAdapter = adapter.cast().map_err(|e| os_error("IDXGIAdapter", e))?;
    unsafe {
        D3D11CreateDevice(
            &base,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
    }
    .map_err(|e| os_error("D3D11CreateDevice", e))?;
    let device = device.ok_or_else(|| ProtocolError::new("capture_error", "No D3D11 device"))?;
    let context = context.ok_or_else(|| ProtocolError::new("capture_error", "No D3D11 context"))?;
    let duplication = unsafe { output.DuplicateOutput(&device) }.map_err(|e| {
        os_error(
            "DuplicateOutput (another app may be duplicating, or the session is locked)",
            e,
        )
    })?;
    Ok(Duplication {
        device,
        context,
        duplication,
        staging: None,
    })
}

impl Duplication {
    /// Waits up to `timeout` for a changed frame. `Ok(None)` when nothing changed.
    fn next_frame(
        &mut self,
        timeout: Duration,
        max_width: u32,
    ) -> Result<Option<(u32, u32, Vec<u8>)>, windows::core::Error> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        match unsafe {
            self.duplication
                .AcquireNextFrame(timeout.as_millis() as u32, &mut info, &mut resource)
        } {
            Ok(()) => {}
            Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(None),
            Err(error) => return Err(error),
        }
        let result = self.copy_frame(resource, info.AccumulatedFrames, max_width);
        // Always hand the frame back to DXGI, even if copying failed.
        let release = unsafe { self.duplication.ReleaseFrame() };
        let frame = result?;
        release?;
        Ok(frame)
    }

    fn copy_frame(
        &mut self,
        resource: Option<IDXGIResource>,
        accumulated: u32,
        max_width: u32,
    ) -> Result<Option<(u32, u32, Vec<u8>)>, windows::core::Error> {
        // Pointer-only updates do not change pixels.
        let Some(resource) = resource else {
            return Ok(None);
        };
        if accumulated == 0 {
            return Ok(None);
        }
        let texture: ID3D11Texture2D = resource.cast()?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
            return Err(windows::core::Error::new(
                windows::Win32::Foundation::E_NOTIMPL,
                "Unsupported desktop format (HDR / non-BGRA)",
            ));
        }
        let staging = self.staging_for(&desc)?;
        unsafe { self.context.CopyResource(&staging, &texture) };
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?
        };
        let (width, height) = scaled_size(desc.Width, desc.Height, max_width);
        let stride = mapped.RowPitch as usize;
        let source = unsafe {
            std::slice::from_raw_parts(mapped.pData as *const u8, stride * desc.Height as usize)
        };
        let pixels = downscale_bgra(source, desc.Width, desc.Height, stride, width, height);
        unsafe { self.context.Unmap(&staging, 0) };
        Ok(Some((width, height, pixels)))
    }

    fn staging_for(
        &mut self,
        source: &D3D11_TEXTURE2D_DESC,
    ) -> Result<ID3D11Texture2D, windows::core::Error> {
        if let Some(existing) = &self.staging {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe { existing.GetDesc(&mut desc) };
            if desc.Width == source.Width && desc.Height == source.Height {
                return Ok(existing.clone());
            }
        }
        let desc = D3D11_TEXTURE2D_DESC {
            Width: source.Width,
            Height: source.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: source.Format,
            SampleDesc: source.SampleDesc,
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        unsafe {
            self.device
                .CreateTexture2D(&desc, None, Some(&mut staging))?
        };
        let staging = staging
            .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        self.staging = Some(staging.clone());
        Ok(staging)
    }
}

/// Captures `monitor` until `stop` is set or `emit` fails (parent gone).
/// Recovers from `ACCESS_LOST` (mode change, secure desktop) by re-opening.
pub fn capture_loop(
    monitor: Monitor,
    max_fps: u32,
    max_width: u32,
    stop: Arc<AtomicBool>,
    emit: &mut dyn FnMut(&serde_json::Value, &[u8]) -> std::io::Result<()>,
) -> Result<(), ProtocolError> {
    let interval = Duration::from_secs_f64(1.0 / f64::from(max_fps.max(1)));
    let mut duplication = open(&monitor.id)?;
    let mut sequence: u64 = 0;
    let started = Instant::now();
    let mut next_due = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now < next_due {
            std::thread::sleep(next_due - now);
        }
        next_due = Instant::now() + interval;
        match duplication.next_frame(Duration::from_millis(100), max_width) {
            Ok(Some((width, height, pixels))) => {
                sequence += 1;
                let header = json!({
                    "seq": sequence,
                    "monitorId": monitor.id,
                    "width": width,
                    "height": height,
                    "sourceWidth": monitor.width,
                    "sourceHeight": monitor.height,
                    "timestampUs": started.elapsed().as_micros() as u64,
                });
                if emit(&header, &pixels).is_err() {
                    break;
                }
            }
            Ok(None) => {}
            Err(error) if error.code() == DXGI_ERROR_ACCESS_LOST => {
                std::thread::sleep(Duration::from_millis(200));
                duplication = open(&monitor.id)?;
            }
            Err(error) => return Err(os_error("AcquireNextFrame", error)),
        }
    }
    Ok(())
}
