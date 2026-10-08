//! Wire protocol between the Electron main process and this helper.
//!
//! Transport: the helper's stdin/stdout, which only the parent process holds.
//! Every message is a frame: `u32` little-endian body length, then the body.
//! The first body byte is the kind:
//!
//! * `0x01` JSON (UTF-8): requests (parent -> helper), responses and events
//!   (helper -> parent).
//! * `0x02` video frame (helper -> parent only): `u32` LE header length, a
//!   JSON header, then tightly packed BGRA pixels.
//!
//! Requests are `{"id": <u32>, "cmd": "<COMMAND>", "args": {...}}`. Only the
//! commands in [`Command`] exist; unknown commands, unknown fields and
//! out-of-range values are rejected. There is deliberately no command that
//! runs programs, touches files or changes system settings.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u32 = 1;
pub const KIND_JSON: u8 = 0x01;
pub const KIND_FRAME: u8 = 0x02;
/// Largest request accepted (clipboard text is the biggest legitimate payload).
pub const MAX_INBOUND_FRAME: usize = 1024 * 1024;
pub const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;
pub const MAX_SCROLL_DELTA: i32 = 2400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonAction {
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
}

/// The complete command set. Field names are camelCase on the wire.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "cmd",
    content = "args",
    rename_all = "SCREAMING_SNAKE_CASE",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Command {
    Hello {
        protocol: u32,
    },
    GetMonitors,
    StartCapture {
        monitor_id: String,
        max_fps: u32,
        max_width: u32,
    },
    StopCapture,
    /// Absolute position in physical virtual-desktop pixels.
    MouseMove {
        x: i32,
        y: i32,
    },
    MouseButton {
        button: MouseButton,
        action: ButtonAction,
    },
    MouseClick {
        button: MouseButton,
        count: u8,
    },
    MouseScroll {
        delta_x: i32,
        delta_y: i32,
    },
    /// `code` is a DOM `KeyboardEvent.code` from the allowlist in `keymap`.
    KeyboardEvent {
        code: String,
        action: KeyAction,
    },
    ReleaseAllInput,
    GetClipboard,
    SetClipboard {
        text: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: u32,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
}

impl ProtocolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Parses one JSON request body. Returns the id (if readable) with any error,
/// so the caller can still answer the right request.
pub fn parse_request(body: &[u8]) -> Result<Request, (Option<u32>, ProtocolError)> {
    let value: Value = serde_json::from_slice(body).map_err(|_| {
        (
            None,
            ProtocolError::new("invalid_json", "Request is not valid JSON"),
        )
    })?;
    let Value::Object(mut object) = value else {
        return Err((
            None,
            ProtocolError::new("invalid_request", "Request must be an object"),
        ));
    };
    let id = object
        .get("id")
        .and_then(Value::as_u64)
        .and_then(|id| u32::try_from(id).ok());
    let Some(id) = id else {
        return Err((
            None,
            ProtocolError::new("invalid_request", "Missing or invalid id"),
        ));
    };
    object.remove("id");
    if object.keys().any(|key| key != "cmd" && key != "args") {
        return Err((
            Some(id),
            ProtocolError::new("invalid_request", "Unknown request field"),
        ));
    }
    let command: Command = serde_json::from_value(Value::Object(object)).map_err(|error| {
        (
            Some(id),
            ProtocolError::new("invalid_command", format!("Invalid command: {error}")),
        )
    })?;
    validate(&command).map_err(|error| (Some(id), error))?;
    Ok(Request { id, command })
}

/// Range checks that do not need system state. Position checks against the
/// actual virtual desktop happen in the platform layer.
pub fn validate(command: &Command) -> Result<(), ProtocolError> {
    match command {
        Command::StartCapture {
            monitor_id,
            max_fps,
            max_width,
        } => {
            if monitor_id.is_empty() || monitor_id.len() > 64 {
                return Err(ProtocolError::new("invalid_args", "Invalid monitor id"));
            }
            if !(1..=60).contains(max_fps) {
                return Err(ProtocolError::new("invalid_args", "maxFps must be 1-60"));
            }
            if !(320..=7680).contains(max_width) {
                return Err(ProtocolError::new(
                    "invalid_args",
                    "maxWidth must be 320-7680",
                ));
            }
        }
        Command::MouseClick { count, .. } if !(1..=2).contains(count) => {
            return Err(ProtocolError::new("invalid_args", "count must be 1 or 2"));
        }
        Command::MouseScroll { delta_x, delta_y }
            if delta_x.abs() > MAX_SCROLL_DELTA || delta_y.abs() > MAX_SCROLL_DELTA =>
        {
            return Err(ProtocolError::new(
                "invalid_args",
                "Scroll delta out of range",
            ));
        }
        Command::KeyboardEvent { code, .. } if crate::keymap::lookup(code).is_none() => {
            return Err(ProtocolError::new("invalid_args", "Key is not allowed"));
        }
        Command::SetClipboard { text } if text.len() > MAX_CLIPBOARD_BYTES => {
            return Err(ProtocolError::new(
                "invalid_args",
                "Clipboard text too large",
            ));
        }
        _ => {}
    }
    Ok(())
}

pub fn ok_response(id: u32, result: Value) -> Value {
    json!({ "id": id, "ok": true, "result": result })
}

pub fn error_response(id: Option<u32>, error: &ProtocolError) -> Value {
    json!({ "id": id, "ok": false, "error": { "code": error.code, "message": error.message } })
}

pub fn event(name: &str, fields: Map<String, Value>) -> Value {
    let mut object = fields;
    object.insert("event".into(), Value::String(name.into()));
    Value::Object(object)
}

/// Reads one frame. `Ok(None)` on clean EOF (the parent went away).
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match reader.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 || len > MAX_INBOUND_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame length out of range",
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_json(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(value)?;
    let len = u32::try_from(payload.len() + 1)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "message too large"))?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&[KIND_JSON])?;
    writer.write_all(&payload)?;
    writer.flush()
}

pub fn write_frame(writer: &mut impl Write, header: &Value, pixels: &[u8]) -> io::Result<()> {
    let header = serde_json::to_vec(header)?;
    let header_len = u32::try_from(header.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "header too large"))?;
    let len = u32::try_from(1 + 4 + header.len() + pixels.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&[KIND_FRAME])?;
    writer.write_all(&header_len.to_le_bytes())?;
    writer.write_all(&header)?;
    writer.write_all(pixels)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Request, (Option<u32>, ProtocolError)> {
        parse_request(text.as_bytes())
    }

    #[test]
    fn parses_valid_commands() {
        assert_eq!(
            parse(r#"{"id":1,"cmd":"GET_MONITORS"}"#).unwrap().command,
            Command::GetMonitors
        );
        assert_eq!(
            parse(r#"{"id":2,"cmd":"MOUSE_MOVE","args":{"x":-10,"y":20}}"#)
                .unwrap()
                .command,
            Command::MouseMove { x: -10, y: 20 }
        );
        assert_eq!(
            parse(r#"{"id":3,"cmd":"KEYBOARD_EVENT","args":{"code":"KeyA","action":"down"}}"#)
                .unwrap()
                .command,
            Command::KeyboardEvent {
                code: "KeyA".into(),
                action: KeyAction::Down
            }
        );
        assert_eq!(
            parse(r#"{"id":4,"cmd":"START_CAPTURE","args":{"monitorId":"\\\\.\\DISPLAY1","maxFps":30,"maxWidth":1920}}"#)
                .unwrap()
                .command,
            Command::StartCapture { monitor_id: r"\\.\DISPLAY1".into(), max_fps: 30, max_width: 1920 }
        );
    }

    #[test]
    fn rejects_unknown_commands_and_fields() {
        let err = parse(r#"{"id":5,"cmd":"RUN_PROCESS","args":{"path":"cmd.exe"}}"#).unwrap_err();
        assert_eq!(err.0, Some(5));
        assert_eq!(err.1.code, "invalid_command");
        assert!(parse(r#"{"id":6,"cmd":"MOUSE_MOVE","args":{"x":1,"y":2,"z":3}}"#).is_err());
        assert!(parse(r#"{"id":7,"cmd":"GET_MONITORS","extra":true}"#).is_err());
        assert!(parse(r#"{"cmd":"GET_MONITORS"}"#).is_err());
        assert!(parse(r#"[1,2]"#).is_err());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn validates_ranges() {
        assert!(
            parse(r#"{"id":1,"cmd":"MOUSE_CLICK","args":{"button":"left","count":3}}"#).is_err()
        );
        assert!(
            parse(r#"{"id":1,"cmd":"MOUSE_SCROLL","args":{"deltaX":0,"deltaY":99999}}"#).is_err()
        );
        assert!(parse(
            r#"{"id":1,"cmd":"KEYBOARD_EVENT","args":{"code":"PowerOff","action":"down"}}"#
        )
        .is_err());
        assert!(parse(
            r#"{"id":1,"cmd":"START_CAPTURE","args":{"monitorId":"x","maxFps":0,"maxWidth":1920}}"#
        )
        .is_err());
        assert!(parse(
            r#"{"id":1,"cmd":"START_CAPTURE","args":{"monitorId":"x","maxFps":30,"maxWidth":10}}"#
        )
        .is_err());
        assert!(
            parse(r#"{"id":1,"cmd":"MOUSE_BUTTON","args":{"button":"x1","action":"down"}}"#)
                .is_err()
        );
        let big = format!(
            r#"{{"id":1,"cmd":"SET_CLIPBOARD","args":{{"text":"{}"}}}}"#,
            "a".repeat(MAX_CLIPBOARD_BYTES + 1)
        );
        assert!(parse(&big).is_err());
    }

    #[test]
    fn frames_round_trip() {
        let mut buffer = Vec::new();
        write_json(&mut buffer, &json!({"a": 1})).unwrap();
        let mut reader = buffer.as_slice();
        let body = read_frame(&mut reader).unwrap().unwrap();
        assert_eq!(body[0], KIND_JSON);
        assert_eq!(&body[1..], br#"{"a":1}"#);
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_oversized_or_empty_frames() {
        let mut huge = ((MAX_INBOUND_FRAME + 1) as u32).to_le_bytes().to_vec();
        huge.extend_from_slice(&[0; 8]);
        assert!(read_frame(&mut huge.as_slice()).is_err());
        let empty = 0u32.to_le_bytes();
        assert!(read_frame(&mut empty.as_slice()).is_err());
    }

    #[test]
    fn writes_video_frames() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &json!({"w": 2}), &[1, 2, 3, 4]).unwrap();
        let len = u32::from_le_bytes(buffer[0..4].try_into().unwrap()) as usize;
        assert_eq!(len, buffer.len() - 4);
        assert_eq!(buffer[4], KIND_FRAME);
        let header_len = u32::from_le_bytes(buffer[5..9].try_into().unwrap()) as usize;
        assert_eq!(&buffer[9..9 + header_len], br#"{"w":2}"#);
        assert_eq!(&buffer[9 + header_len..], &[1, 2, 3, 4]);
    }
}
