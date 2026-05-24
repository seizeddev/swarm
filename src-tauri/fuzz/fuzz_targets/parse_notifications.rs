// SPDX-License-Identifier: GPL-3.0-or-later
//! Fuzz target for the terminal OSC 9/99/777 notification parser.
//!
//! The parser scans raw PTY bytes (fully attacker-influenced: any program in the
//! terminal can emit OSC sequences), does UTF-8 slicing, base64 decoding, and
//! index arithmetic across chunk boundaries. This drives it with arbitrary input
//! to prove it never panics or over-reads. Run: `cargo fuzz run parse_notifications`.
//!
//! The pure parser module is included directly (not via the `swarm` crate, which
//! is a Tauri cdylib that can't link under the sanitizer build).
#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "../../src/osc.rs"]
mod osc;

fuzz_target!(|data: &[u8]| {
    let mut st = osc::NotifState::default();
    let _ = osc::parse_notifications(data, &mut st);
});
