//! The command loop, independent of the transport so it can be tested with
//! in-memory streams and a fake platform.

use crate::keymap;
use crate::platform::{Monitor, Platform};
use crate::protocol::{
    self, error_response, ok_response, ButtonAction, Command, KeyAction, MouseButton,
    ProtocolError, Request, KIND_JSON, PROTOCOL_VERSION,
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

pub type CaptureFn = fn(
    Monitor,
    u32,
    u32,
    Arc<AtomicBool>,
    &mut dyn FnMut(&Value, &[u8]) -> std::io::Result<()>,
) -> Result<(), ProtocolError>;

/// Shared writer: responses (command thread) and frames (capture thread)
/// must never interleave inside one frame.
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct CaptureHandle {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

pub struct Helper<P: Platform + 'static> {
    platform: Arc<P>,
    writer: SharedWriter,
    capture_fn: CaptureFn,
    greeted: bool,
    capture: Option<CaptureHandle>,
    /// Injected keys/buttons still held down, so they can be released on
    /// session end and never stay stuck.
    pressed_keys: HashSet<String>,
    pressed_buttons: HashSet<MouseButton>,
}

impl<P: Platform + 'static> Helper<P> {
    pub fn new(platform: P, writer: SharedWriter, capture_fn: CaptureFn) -> Self {
        Self {
            platform: Arc::new(platform),
            writer,
            capture_fn,
            greeted: false,
            capture: None,
            pressed_keys: HashSet::new(),
            pressed_buttons: HashSet::new(),
        }
    }

    fn write(&self, value: &Value) -> std::io::Result<()> {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        protocol::write_json(&mut *writer, value)
    }

    /// Runs until EOF or SHUTDOWN. Always releases input and stops capture.
    pub fn run(&mut self, reader: &mut impl Read) -> std::io::Result<()> {
        let result = self.serve(reader);
        self.release_all_input();
        self.stop_capture();
        result
    }

    fn serve(&mut self, reader: &mut impl Read) -> std::io::Result<()> {
        while let Some(body) = protocol::read_frame(reader)? {
            if body[0] != KIND_JSON {
                self.write(&error_response(
                    None,
                    &ProtocolError::new("invalid_frame", "Expected JSON"),
                ))?;
                continue;
            }
            match protocol::parse_request(&body[1..]) {
                Ok(Request { id, command }) => {
                    let shutdown = command == Command::Shutdown;
                    let response = match self.handle(command) {
                        Ok(result) => ok_response(id, result),
                        Err(error) => error_response(Some(id), &error),
                    };
                    self.write(&response)?;
                    if shutdown {
                        return Ok(());
                    }
                }
                Err((id, error)) => self.write(&error_response(id, &error))?,
            }
        }
        Ok(())
    }

    pub fn handle(&mut self, command: Command) -> Result<Value, ProtocolError> {
        if !self.greeted {
            return match command {
                Command::Hello { protocol } if protocol == PROTOCOL_VERSION => {
                    self.greeted = true;
                    Ok(
                        json!({ "protocol": PROTOCOL_VERSION, "version": env!("CARGO_PKG_VERSION") }),
                    )
                }
                Command::Hello { .. } => Err(ProtocolError::new(
                    "unsupported_protocol",
                    "Protocol version mismatch",
                )),
                _ => Err(ProtocolError::new("not_ready", "Send HELLO first")),
            };
        }
        match command {
            Command::Hello { .. } => Err(ProtocolError::new("invalid_state", "Already greeted")),
            Command::GetMonitors => Ok(json!({ "monitors": self.platform.monitors()? })),
            Command::StartCapture {
                monitor_id,
                max_fps,
                max_width,
            } => {
                let monitor = self
                    .platform
                    .monitors()?
                    .into_iter()
                    .find(|m| m.id == monitor_id)
                    .ok_or_else(|| ProtocolError::new("unknown_monitor", "No such monitor"))?;
                self.start_capture(monitor, max_fps, max_width);
                Ok(json!({}))
            }
            Command::StopCapture => {
                self.stop_capture();
                Ok(json!({}))
            }
            Command::MouseMove { x, y } => {
                self.platform.mouse_move(x, y)?;
                Ok(json!({}))
            }
            Command::MouseButton { button, action } => {
                self.platform.mouse_button(button, action)?;
                match action {
                    ButtonAction::Down => self.pressed_buttons.insert(button),
                    ButtonAction::Up => self.pressed_buttons.remove(&button),
                };
                Ok(json!({}))
            }
            Command::MouseClick { button, count } => {
                for _ in 0..count {
                    self.platform.mouse_button(button, ButtonAction::Down)?;
                    self.platform.mouse_button(button, ButtonAction::Up)?;
                }
                Ok(json!({}))
            }
            Command::MouseScroll { delta_x, delta_y } => {
                self.platform.mouse_scroll(delta_x, delta_y)?;
                Ok(json!({}))
            }
            Command::KeyboardEvent { code, action } => {
                let (scancode, extended) = keymap::lookup(&code)
                    .ok_or_else(|| ProtocolError::new("invalid_args", "Key is not allowed"))?;
                self.platform.key(scancode, extended, action)?;
                match action {
                    KeyAction::Down => self.pressed_keys.insert(code),
                    KeyAction::Up => self.pressed_keys.remove(&code),
                };
                Ok(json!({}))
            }
            Command::ReleaseAllInput => Ok(json!({ "released": self.release_all_input() })),
            Command::GetClipboard => Ok(json!({ "text": self.platform.get_clipboard()? })),
            Command::SetClipboard { text } => {
                self.platform.set_clipboard(&text)?;
                Ok(json!({}))
            }
            Command::Shutdown => Ok(json!({})),
        }
    }

    /// Releases everything this helper pressed. Returns how many were released.
    fn release_all_input(&mut self) -> usize {
        let keys: Vec<String> = self.pressed_keys.drain().collect();
        let buttons: Vec<MouseButton> = self.pressed_buttons.drain().collect();
        for code in &keys {
            if let Some((scancode, extended)) = keymap::lookup(code) {
                let _ = self.platform.key(scancode, extended, KeyAction::Up);
            }
        }
        for button in &buttons {
            let _ = self.platform.mouse_button(*button, ButtonAction::Up);
        }
        keys.len() + buttons.len()
    }

    fn start_capture(&mut self, monitor: Monitor, max_fps: u32, max_width: u32) {
        self.stop_capture();
        let stop = Arc::new(AtomicBool::new(false));
        let writer = Arc::clone(&self.writer);
        let capture_fn = self.capture_fn;
        let thread_stop = Arc::clone(&stop);
        let monitor_id = monitor.id.clone();
        let thread = std::thread::spawn(move || {
            let mut emit = |header: &Value, pixels: &[u8]| {
                let mut out = writer.lock().unwrap_or_else(|e| e.into_inner());
                protocol::write_frame(&mut *out, header, pixels)
            };
            let result = capture_fn(
                monitor,
                max_fps,
                max_width,
                Arc::clone(&thread_stop),
                &mut emit,
            );
            let mut fields = Map::new();
            fields.insert("monitorId".into(), Value::String(monitor_id));
            match result {
                Ok(()) => fields.insert("reason".into(), Value::String("stopped".into())),
                Err(error) => {
                    fields.insert("reason".into(), Value::String("error".into()));
                    fields.insert("code".into(), Value::String(error.code.into()));
                    fields.insert("message".into(), Value::String(error.message))
                }
            };
            let mut out = writer.lock().unwrap_or_else(|e| e.into_inner());
            let _ = protocol::write_json(&mut *out, &protocol::event("captureStopped", fields));
        });
        self.capture = Some(CaptureHandle { stop, thread });
    }

    fn stop_capture(&mut self) {
        if let Some(capture) = self.capture.take() {
            capture.stop.store(true, Ordering::Relaxed);
            let _ = capture.thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Rect;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct FakePlatform {
        log: StdMutex<Vec<String>>,
    }

    impl Platform for FakePlatform {
        fn monitors(&self) -> Result<Vec<Monitor>, ProtocolError> {
            Ok(vec![Monitor {
                id: "M1".into(),
                name: "Display 1".into(),
                primary: true,
                x: 0,
                y: 0,
                width: 100,
                height: 50,
                scale_factor: 1.0,
                refresh_hz: 60,
            }])
        }
        fn virtual_screen(&self) -> Rect {
            Rect {
                x: 0,
                y: 0,
                width: 100,
                height: 50,
            }
        }
        fn mouse_move(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
            if !self.virtual_screen().contains(x, y) {
                return Err(ProtocolError::new("invalid_args", "outside"));
            }
            self.log.lock().unwrap().push(format!("move {x},{y}"));
            Ok(())
        }
        fn mouse_button(&self, b: MouseButton, a: ButtonAction) -> Result<(), ProtocolError> {
            self.log.lock().unwrap().push(format!("button {b:?} {a:?}"));
            Ok(())
        }
        fn mouse_scroll(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
            self.log.lock().unwrap().push(format!("scroll {x},{y}"));
            Ok(())
        }
        fn key(&self, s: u16, e: bool, a: KeyAction) -> Result<(), ProtocolError> {
            self.log
                .lock()
                .unwrap()
                .push(format!("key {s:#x} {e} {a:?}"));
            Ok(())
        }
        fn get_clipboard(&self) -> Result<String, ProtocolError> {
            Ok("remote text".into())
        }
        fn set_clipboard(&self, t: &str) -> Result<(), ProtocolError> {
            self.log.lock().unwrap().push(format!("clip {t}"));
            Ok(())
        }
    }

    fn fake_capture(
        monitor: Monitor,
        _fps: u32,
        _w: u32,
        stop: Arc<AtomicBool>,
        emit: &mut dyn FnMut(&Value, &[u8]) -> std::io::Result<()>,
    ) -> Result<(), ProtocolError> {
        // Emit a burst, then keep "capturing" until stopped, as the real loop does.
        for n in 1..=3 {
            emit(
                &json!({"seq": n, "monitorId": monitor.id, "width": 2, "height": 2}),
                &[0; 16],
            )
            .map_err(|_| ProtocolError::new("io", "closed"))?;
        }
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        Ok(())
    }

    struct VecWriter(Arc<StdMutex<Vec<u8>>>);
    impl Write for VecWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn request(id: u32, cmd: &str, args: Value) -> Vec<u8> {
        let body = serde_json::to_vec(&json!({"id": id, "cmd": cmd, "args": args})).unwrap();
        let mut frame = ((body.len() + 1) as u32).to_le_bytes().to_vec();
        frame.push(KIND_JSON);
        frame.extend(body);
        frame
    }

    fn run(input: Vec<u8>) -> (Vec<Value>, usize, Vec<String>) {
        let out = Arc::new(StdMutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(VecWriter(Arc::clone(&out)))));
        let platform = FakePlatform::default();
        let mut helper = Helper::new(platform, writer, fake_capture);
        helper.run(&mut input.as_slice()).unwrap();
        let log = helper.platform.log.lock().unwrap().clone();
        let bytes = out.lock().unwrap().clone();
        let mut reader = bytes.as_slice();
        let (mut json_messages, mut frames) = (Vec::new(), 0);
        while let Some(body) = protocol::read_frame(&mut reader).unwrap() {
            if body[0] == KIND_JSON {
                json_messages.push(serde_json::from_slice(&body[1..]).unwrap());
            } else {
                frames += 1;
            }
        }
        (json_messages, frames, log)
    }

    #[test]
    fn requires_hello_first() {
        let mut input = request(1, "GET_MONITORS", Value::Null);
        input.extend(request(2, "HELLO", json!({"protocol": 99})));
        input.extend(request(3, "HELLO", json!({"protocol": PROTOCOL_VERSION})));
        input.extend(request(4, "GET_MONITORS", Value::Null));
        let (messages, _, _) = run(input);
        assert_eq!(messages[0]["error"]["code"], "not_ready");
        assert_eq!(messages[1]["error"]["code"], "unsupported_protocol");
        assert_eq!(messages[2]["ok"], true);
        assert_eq!(messages[3]["result"]["monitors"][0]["id"], "M1");
    }

    #[test]
    fn injects_input_and_releases_held_keys_on_exit() {
        let mut input = request(1, "HELLO", json!({"protocol": PROTOCOL_VERSION}));
        input.extend(request(2, "MOUSE_MOVE", json!({"x": 10, "y": 20})));
        input.extend(request(3, "MOUSE_MOVE", json!({"x": 500, "y": 20})));
        input.extend(request(
            4,
            "KEYBOARD_EVENT",
            json!({"code": "ShiftLeft", "action": "down"}),
        ));
        input.extend(request(
            5,
            "MOUSE_BUTTON",
            json!({"button": "left", "action": "down"}),
        ));
        input.extend(request(
            6,
            "MOUSE_CLICK",
            json!({"button": "right", "count": 2}),
        ));
        let (messages, _, log) = run(input);
        assert_eq!(messages[1]["ok"], true);
        assert_eq!(messages[2]["error"]["code"], "invalid_args");
        assert_eq!(log[0], "move 10,20");
        // Stream ended with Shift and the left button held: both get released.
        assert!(log.contains(&"key 0x2a false Up".to_string()));
        assert!(log.contains(&"button Left Up".to_string()));
        assert_eq!(
            log.iter().filter(|l| l.starts_with("button Right")).count(),
            4
        );
    }

    #[test]
    fn handles_clipboard_and_rejects_bad_frames() {
        let mut input = request(1, "HELLO", json!({"protocol": PROTOCOL_VERSION}));
        input.extend(request(2, "GET_CLIPBOARD", Value::Null));
        input.extend(request(3, "SET_CLIPBOARD", json!({"text": "hi"})));
        input.extend(request(4, "EXEC", json!({"cmd": "calc"})));
        let mut binary = 5u32.to_le_bytes().to_vec();
        binary.extend([0x02, 1, 2, 3, 4]);
        input.extend(binary);
        input.extend(request(5, "SHUTDOWN", Value::Null));
        input.extend(request(6, "GET_CLIPBOARD", Value::Null)); // after shutdown: never processed
        let (messages, _, log) = run(input);
        assert_eq!(messages[1]["result"]["text"], "remote text");
        assert_eq!(log, vec!["clip hi".to_string()]);
        assert_eq!(messages[3]["error"]["code"], "invalid_command");
        assert_eq!(messages[4]["error"]["code"], "invalid_frame");
        assert_eq!(messages.len(), 6);
    }

    #[test]
    fn streams_capture_frames_and_reports_stop() {
        let mut input = request(1, "HELLO", json!({"protocol": PROTOCOL_VERSION}));
        input.extend(request(
            2,
            "START_CAPTURE",
            json!({"monitorId": "nope", "maxFps": 30, "maxWidth": 1280}),
        ));
        input.extend(request(
            3,
            "START_CAPTURE",
            json!({"monitorId": "M1", "maxFps": 30, "maxWidth": 1280}),
        ));
        let (messages, frames, _) = run(input);
        assert_eq!(messages[1]["error"]["code"], "unknown_monitor");
        assert_eq!(messages[2]["ok"], true);
        assert_eq!(frames, 3);
        assert!(messages.iter().any(|m| m["event"] == "captureStopped"));
    }
}
