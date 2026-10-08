# Remote sessions (Phase 3)

> Status: **implemented and tested locally; not deployed.** Screen sharing, remote
> mouse/keyboard, clipboard and file transfer work end to end between two desktop
> clients. Production deployment (TLS endpoints, TURN hosting, code signing) is not done.

```
 Controller (viewer)                    apps/signaling (WSS)                   Remote device (host)
 ───────────────────                    ────────────────────                   ────────────────────
 main: SignalingClient ──request──────▶ authorize (DB, RBAC, access pw) ─────▶ main: native approval dialog
                       ◀─ice_config──── TURN creds only after approval ─────▶  (or auto-approve: owner)
 renderer: RTCPeerConnection ─offer───▶ relay (participants only) ──────────▶ indicator window: answer
                             ◀─answer─── ◀───────────────────────────────────  + capture track
                             ◀─ICE────▶ relay ◀─────────────────────────────▶
 ═══════════════ DTLS-SRTP video + SCTP DataChannels (direct, or via TURN) ═══════════════
 <video>  ◀─────────────────── H.264/VP8 (GPU encoder when available) ◀────── Chromium capture (WGC/DXGI)
 input    ────── "input" DC ──────────────────────────────────────────────▶ main: authorize ─▶ helper: SendInput
 clipboard ◀──── "clipboard" DC (explicit actions only) ──────────────────▶ main: authorize ─▶ helper: clipboard
 files    ◀───── "file" DC (chunks + SHA-256) ────────────────────────────▶ main: FileSink (Downloads\Kestrel Remote)
 control  ◀───── "control" DC (monitors, quality, ping) ──────────────────▶
```

Screen frames never pass through the Node.js API or the signaling server.

## Components

| Component            | Path                                                                   | Role                                                                                                            |
| -------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Signaling client     | `apps/desktop/src/main/session/signaling-client.ts`                    | Main-process WebSocket (needs the token and device key); auto-reconnect                                         |
| Session coordinator  | `apps/desktop/src/main/session/coordinator.ts`                         | Owns all sessions; the only path to the native helper; approval dialog; indicator window; verify loop; teardown |
| Input policy         | `apps/desktop/src/main/session/policy.ts`                              | Pure authorization of input/clipboard/file requests                                                             |
| File sink            | `apps/desktop/src/main/session/file-sink.ts`                           | Safe receiving: fixed folder, sanitized names, no overwrite, size limit, SHA-256                                |
| Helper client        | `apps/desktop/src/main/native/`                                        | Spawns and talks to the Rust helper over stdio                                                                  |
| Controller WebRTC    | `apps/desktop/src/renderer/src/webrtc/controller-session.ts`           | Offer, recv-only video, DataChannels, stats, ICE restart                                                        |
| Host WebRTC          | `apps/desktop/src/renderer/src/webrtc/host-session.ts`                 | Answer, capture, adaptive quality, forwards peer requests to main                                               |
| Viewer               | `apps/desktop/src/renderer/src/pages/viewer/ViewerPage.tsx`            | Controller UI                                                                                                   |
| Session indicator    | `apps/desktop/src/renderer/src/pages/host-session/HostSessionPage.tsx` | "REMOTE SESSION ACTIVE" window on the remote machine                                                            |
| Native helper        | `native/windows-helper/` (Rust)                                        | Monitors, DXGI capture, SendInput, clipboard                                                                    |
| DataChannel protocol | `packages/webrtc/src/datachannel.ts`                                   | Strict schemas for every peer message                                                                           |
| Adaptive quality     | `packages/webrtc/src/quality.ts`                                       | Resolution/frame-rate/bitrate ladder                                                                            |
| coturn               | `infra/coturn/`                                                        | STUN/TURN config (dev + production template)                                                                    |

## Security model

- **Authorization is server-side and short-lived.**
  - Every connection request is authorized against the database (ownership, RBAC, device
    grants, optional access password).
  - TURN credentials are HMAC-derived, per user, and expire. They are only issued for
    approved sessions, so knowing a device ID is not enough to connect.
  - An approved session must reach CONNECTED within `SESSION_CONNECT_TIMEOUT_SECONDS`.
  - The host re-verifies the session every 30 s (`session.verify`). The server re-reads
    the controller's current access, narrowing permissions or ending the session. If
    verification fails three times, the host ends the session itself.
- **Permissions are verified on both sides.**
  - The controller UI only offers granted actions.
  - The host's main process re-checks every input, clipboard and file request against
    the permissions it received from the server. The peer's claims and the renderer
    don't count.
  - The Rust helper validates every command again (allowlisted keys, coordinates inside
    the desktop, size limits).
- **Native operations are isolated.**
  - The helper has a fixed command set: GET_MONITORS, START_CAPTURE, STOP_CAPTURE,
    MOUSE_MOVE, MOUSE_BUTTON, MOUSE_CLICK, MOUSE_SCROLL, KEYBOARD_EVENT,
    RELEASE_ALL_INPUT, GET_CLIPBOARD, SET_CLIPBOARD, SHUTDOWN.
  - It talks only over its stdin/stdout, which only the Electron main process holds. It
    runs no programs, touches no files, opens no ports, and exits when its parent goes away.
- **The renderer never executes native commands.** It sends requests over IPC; the main
  process checks that the calling window owns the session and has the right role, then
  authorizes and executes.
- **No secrets in the renderer.** Tokens, the device private key and TURN secrets stay in
  main or on the server; the renderer only receives that session's ICE server list.
- **No hidden access.**
  - The remote user approves with a native dialog.
  - Owners connecting to their own device are auto-approved but still get the indicator.
  - The indicator is always on top and can't be minimized; closing it ends the session.
  - It shows the connected user, duration and permissions (with toggles), and logs
    clipboard and file activity.
  - There is no unattended or stealth mode, no persistence and no auto-start.

## Video pipeline

- **Primary path:** Chromium desktop capture (Windows Graphics Capture / DXGI inside
  Chromium) feeds the WebRTC encoder directly (zero-copy).
  - The controller prefers H.264, so Chromium uses the GPU (Media Foundation) encoder
    when available and falls back to VP8/VP9 software encoding.
  - The track uses `contentHint = 'detail'`.
- **Fallback path:** the Rust helper's DXGI Desktop Duplication capture.
  - It only sends frames when the desktop changed, paced to the frame-rate limit and
    downscaled in the helper.
  - Frames reach the host renderer over a MessagePort and are fed to a
    `MediaStreamTrackGenerator`, then the same WebRTC encoder.
- **Adaptive quality** has two layers:
  - WebRTC congestion control adjusts the bitrate continuously.
  - The host steps through a 5-level ladder (scale, max frame rate, max bitrate) based
    on RTT and loss. It degrades fast and recovers slowly. Presets: auto / quality /
    balanced / speed.
- **Stats:** RTT, loss, bitrate, FPS, resolution and TURN-relay use are shown in the
  viewer. Nothing is written to the database.

## Input, clipboard, files

- **Mouse:** move, left/right/middle buttons, double click via native timing, and wheel.
  - Positions are normalized to the shared area, then mapped by the host to physical
    pixels inside the selected monitor only.
- **Keyboard:** DOM `code` mapped to scancodes (layout-independent), with modifiers and
  special keys.
  - A "Keys" menu sends shortcuts the controller's OS would intercept: Win, Alt+Tab,
    Ctrl+Esc, Ctrl+Shift+Esc, Print Screen.
  - Held keys and buttons are released on focus loss, when permission is revoked, and
    on session end.
- **Clipboard:** text only, and only on explicit user actions ("Send clipboard" /
  "Get clipboard").
  - Requires the `clipboard` permission; there is never automatic sync.
  - Each transfer is audited (size only) and shown in the remote user's indicator.
- **Files:** in both directions over the "file" DataChannel, in 16 KiB chunks with
  backpressure, progress and cancel.
  - Limits: 512 MB max, a whole-file SHA-256 check, and the `file_transfer` permission.
  - Received files go to `Downloads\Kestrel Remote`. Names are reduced to a safe
    basename (no traversal, no device names, no ADS) and existing files are never
    overwritten (`name (1).ext`).
  - Data is staged in a `.partial` file and only renamed after verification.
  - Start, complete and cancel are audited (size + hash, never names or contents).

## Multi-monitor

- The helper enumerates monitors with physical bounds, DPI scale and refresh rate. They
  are matched to Electron displays and capture sources.
- The viewer can switch monitors, show all monitors (composited side by side at their
  real positions, max 2560 px wide, 15 fps), or follow the remote cursor. It also has
  fit-to-window, 1:1 and fullscreen views.

## Session termination

Either side can end a session from its toolbar or indicator. Closing the viewer, closing
the indicator, quitting the app, signing out and revoking the device all end it too.

Teardown is idempotent and releases:

- injected input
- native capture
- partial files
- timers
- DataChannels and the peer connection
- the indicator window
- the helper process, when the last session ends

If a participant vanishes, the server fails its sessions after
`PEER_DISCONNECT_GRACE_SECONDS`. After a server restart, a reconciliation pass ends
sessions whose participants did not return.

## Testing

| Layer               | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | How                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Rust                | protocol parsing, validation, framing, key map, command loop, input release, capture streaming                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `cargo test` (15)                                        |
| Rust, real hardware | monitors, DXGI frame, cursor move + restore, clipboard round trip + restore, key injection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `cargo test -- --ignored` (5, run manually)              |
| Protocols           | malformed/smuggled DataChannel and signaling messages, chunk framing, quality ladder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `packages/webrtc` (25)                                   |
| Desktop main        | input policy, permission denial, file sink (traversal, reserved names, overwrite, integrity, limits), helper framing, display mapping, signaling reconnect                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/desktop` (73)                                      |
| Backend             | verify (narrowing / revocation), peer audit permission checks, session expiry, disconnect failure, TURN credential derivation                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PGlite integration (68 incl. Phase 2)                    |
| Signaling           | ICE config only after approval, verify/report/audit, disconnect grace + reconnect, expiry, restart reconciliation                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | real WebSocket clients (29)                              |
| Two local clients   | connect, video, monitors, clipboard both ways, file transfer with byte check, permission revoke, unauthorized/malformed native requests, end from each side, 3× reconnect cycles, signaling outage recovery, host crash                                                                                                                                                                                                                                                                                                                                                                   | Electron x2 against PBS-DESKTOP (manual run, see report) |
| Live mouse/keyboard | Viewer input → DataChannel → host → helper `SendInput`, checked by a probe window with low-level hooks (`LLMHF_INJECTED`): moves land on the exact target pixel; left/right/middle click; double click (`clicks=2`); wheel ±; Shift/Ctrl modifiers, Backspace, Enter, Home/End/Delete, Tab, arrows, Escape (typed text matched); Windows-key combo; zero input after Control is turned off; no keys or buttons left held; helper exits on session end                                                                                                                                     | Electron x2, 2026-10-07                                  |
| Live approval       | Second account (operator in a test organization) requests device A (`require_approval` on). The native "Remote connection request" dialog names the requester and the requested permissions. **Reject** → controller sees "The remote user declined the request", no indicator, session `FAILED/rejected`, `CONNECTION_REJECTED` audited. **No answer** → "The request expired before it was answered", session `EXPIRED`. **Allow** → connected, indicator shows the requester. **Allow view only** → only `screen_view` granted; Control, Keys and clipboard are disabled               | Electron x2 + UI Automation, 2026-10-07                  |
| Live TURN relay     | coturn (`infra/coturn`, Docker) with a shared secret; signaling issues short-lived per-user credentials after approval. Default mode gathers host, srflx (STUN) and relay (TURN) candidates and still picks the direct host pair, so TURN stays a fallback. With the controller forced to `iceTransportPolicy: relay`, the session connects through `turn:127.0.0.1:3478?transport=udp` (H.264 video, all four DataChannels open, clipboard over the relay) and the viewer shows the **TURN relay** badge. coturn logged only successful allocations by that user's time-limited username | Electron x2 + coturn, 2026-10-07                         |

## Known limitations

- **TURN tested on one machine only.** The live TURN test ran coturn in Docker on the same
  PC as both clients. It used plain `turn:` (UDP), not `turns:`/TLS, and did not cross a
  real NAT. A deployed TURN host with a public IP and a certificate is part of production
  deployment.
- **Single-monitor test machine.** Multi-monitor switching, composite and follow mode are
  covered by logic tests only.
- **Concurrent local mouse use.** Button events are injected at the current cursor
  position, right after the move. If the remote user moves their own mouse at the same
  time, a click can land a few pixels off and a double click may not register (Windows
  allows only a few pixels of movement between the two clicks). This was observed in the
  live test while the machine's mouse was in use.
- **Windows security boundaries:**
  - Input can't reach elevated windows or the UAC secure desktop (UIPI).
  - Ctrl+Alt+Del can't be injected from user mode.
  - Capture of the secure desktop / lock screen isn't possible without a Windows service
    (not implemented, by design, in this phase).
- **Clipboard is text only.** No images or files via the clipboard.
- **Audio** is not implemented (planned).
- **Keyboard layout:** keys are sent as physical scancodes, so the remote machine's layout
  applies (like a physical keyboard). Text from IMEs is not transmitted.
- **Single instance per service:** rate limiters and signaling routing are in memory.
  Horizontal scaling needs Redis (or similar) behind the same interfaces.
- **Hardware encoding** is Chromium's choice: it uses the GPU H.264 encoder when the
  driver offers one, otherwise software VP8/VP9. The app does not force it.
- **Fallback capture path** (helper DXGI → MessagePort → MediaStreamTrackGenerator) costs
  more CPU than the primary path and is capped at 20 fps / 1920 px.
- **Not production-ready:** no code signing, no deployed TLS endpoints
  (`wss://`/`https://`/`turns:`), no packaged-build configuration of API/signaling URLs.
