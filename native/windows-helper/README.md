# native/windows-helper

Rust helper for the Windows-only parts of a remote session:

| Area                | Implementation                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Monitor enumeration | `EnumDisplayMonitors` + `GetMonitorInfoW`, per-monitor DPI (`GetDpiForMonitor`), refresh rate                                   |
| Screen capture      | DXGI Desktop Duplication (`IDXGIOutput1::DuplicateOutput`), changed frames only, paced, downscaled; recovers from `ACCESS_LOST` |
| Mouse               | `SendInput` absolute virtual-desktop moves, buttons, clicks, wheel                                                              |
| Keyboard            | `SendInput` scancodes from an allowlist of DOM `KeyboardEvent.code` values                                                      |
| Clipboard           | `CF_UNICODETEXT` read/write (256 KiB limit)                                                                                     |

The primary video path is Chromium's own capture (see `docs/phase3.md`); this
helper's capture is the fallback.

## Protocol

The Electron main process spawns `kestrel-helper.exe` (no shell, no arguments)
and talks to it over **stdin/stdout only**. Frames are a `u32` little-endian
length, then a body whose first byte is `0x01` (JSON) or `0x02` (video frame).

```json
{"id": 7, "cmd": "MOUSE_MOVE", "args": {"x": 1200, "y": 640}}
{"id": 7, "ok": true, "result": {}}
```

Commands: `HELLO` (required first, protocol version), `GET_MONITORS`,
`START_CAPTURE`, `STOP_CAPTURE`, `MOUSE_MOVE`, `MOUSE_BUTTON`, `MOUSE_CLICK`,
`MOUSE_SCROLL`, `KEYBOARD_EVENT`, `RELEASE_ALL_INPUT`, `GET_CLIPBOARD`,
`SET_CLIPBOARD`, `SHUTDOWN`.

Unknown commands, unknown fields and out-of-range values are rejected. There is
no command that runs programs, touches files or changes system settings.

## Safety properties

- **No other process can drive it.** There are no sockets or named pipes; only the
  parent holds its stdio handles.
- **Authorization lives in the parent.** The Electron main process decides what is
  allowed, and the helper re-validates every command.
- **Input is released.** Held keys and buttons are released on `RELEASE_ALL_INPUT`,
  on `SHUTDOWN` and when stdin closes, so nothing stays stuck.
- **No persistence.** It exits when the parent goes away and installs nothing.
- **User privileges only.** It runs as the signed-in user. Input cannot reach
  elevated windows or the secure desktop (UIPI).

## Build and test

```bash
pnpm --filter @remote-desktop/windows-helper build      # cargo build --release
pnpm --filter @remote-desktop/windows-helper test       # unit tests (no desktop access)
pnpm lint:native                                        # clippy -D warnings + rustfmt
cd native/windows-helper && cargo test -- --ignored     # real hardware: moves the cursor
                                                        # and uses the clipboard (restores both)
```

Requires the Rust MSVC toolchain (`rustup`, stable) and the Visual Studio C++
build tools. Electron packaging copies `target/release/kestrel-helper.exe` into
the app's `resources/`.
