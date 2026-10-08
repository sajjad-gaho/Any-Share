//! Kestrel Remote Windows helper.
//!
//! Spawned by the Electron main process for the duration of a remote session
//! and driven over its stdin/stdout only (see `protocol`). It has no network
//! access, opens no listening sockets or pipes, installs nothing, and exits
//! as soon as its parent closes stdin. It runs in the signed-in user's session
//! with the user's own privileges.

mod helper;
mod keymap;
mod platform;
mod protocol;

use helper::{Helper, SharedWriter};
use std::io::{self, BufReader, BufWriter};
use std::sync::{Arc, Mutex};

fn main() {
    platform::init_process();
    let stdout: SharedWriter = Arc::new(Mutex::new(Box::new(BufWriter::new(io::stdout()))));
    let mut helper = Helper::new(platform::NativePlatform, stdout, platform::capture_loop);
    let mut stdin = BufReader::new(io::stdin().lock());
    let code = match helper.run(&mut stdin) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("kestrel-helper: {error}");
            1
        }
    };
    std::process::exit(code);
}
