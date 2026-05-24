// SPDX-License-Identifier: GPL-3.0-or-later
//! Fuzz target for the terminal OSC 9/99/777 notification parser.
//!
//! The parser scans raw PTY bytes (fully attacker-influenced: any program in the
//! terminal can emit OSC sequences), does UTF-8 slicing, base64 decoding, and
//! index arithmetic across chunk boundaries. This drives it with arbitrary input
//! to prove it never panics or over-reads. Run: `cargo fuzz run parse_notifications`.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    swarm_lib::__fuzz_parse_notifications(data);
});
