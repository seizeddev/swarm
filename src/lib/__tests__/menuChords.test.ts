// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { menuChordCommand, type ChordEvent } from "../menuChords";

const ev = (over: Partial<ChordEvent>): ChordEvent => ({
  code: "",
  key: "",
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

const ctrlShift = (code: string) => ev({ code, ctrlKey: true, shiftKey: true });
const ctrlAlt = (code: string) => ev({ code, ctrlKey: true, altKey: true });
const ctrl = (code: string) => ev({ code, ctrlKey: true });

describe("menuChordCommand", () => {
  it("mirrors the native Ctrl+Shift accelerators", () => {
    expect(menuChordCommand(ctrlShift("KeyC"))).toBe("term_copy");
    expect(menuChordCommand(ctrlShift("KeyV"))).toBe("term_paste");
    expect(menuChordCommand(ctrlShift("KeyT"))).toBe("new_terminal");
    expect(menuChordCommand(ctrlShift("KeyW"))).toBe("close_pane");
    expect(menuChordCommand(ctrlShift("KeyD"))).toBe("split_right");
    expect(menuChordCommand(ctrlShift("KeyB"))).toBe("toggle_sidebar");
    expect(menuChordCommand(ctrlShift("KeyG"))).toBe("panel_scm");
    expect(menuChordCommand(ctrlShift("KeyI"))).toBe("panel_notifications");
    expect(menuChordCommand(ctrlShift("KeyN"))).toBe("new_workspace");
    expect(menuChordCommand(ctrlShift("BracketRight"))).toBe("ws_next");
    expect(menuChordCommand(ctrlShift("BracketLeft"))).toBe("ws_prev");
    expect(menuChordCommand(ctrlShift("Equal"))).toBe("zoom_in");
  });

  it("mirrors the native Ctrl+Alt accelerators", () => {
    expect(menuChordCommand(ctrlAlt("KeyD"))).toBe("split_down");
    expect(menuChordCommand(ctrlAlt("KeyW"))).toBe("close_workspace");
  });

  it("mirrors the bare-Ctrl accelerators", () => {
    expect(menuChordCommand(ctrl("Comma"))).toBe("settings");
    expect(menuChordCommand(ctrl("Minus"))).toBe("zoom_out");
    expect(menuChordCommand(ctrl("Digit0"))).toBe("zoom_reset");
    expect(menuChordCommand(ctrl("Digit1"))).toBe("ws_1");
    expect(menuChordCommand(ctrl("Digit9"))).toBe("ws_9");
  });

  it("maps bare F11 to fullscreen", () => {
    expect(menuChordCommand(ev({ key: "F11" }))).toBe("toggle_fullscreen");
    expect(menuChordCommand(ev({ key: "F11", ctrlKey: true }))).toBeNull();
  });

  it("never claims the terminal's control bytes", () => {
    // Plain Ctrl+letter chords are PTY traffic (Ctrl+C interrupt, Ctrl+D EOF,
    // tmux's Ctrl+B) — the whole reason the app shortcuts carry Shift/Alt.
    for (const code of ["KeyC", "KeyD", "KeyW", "KeyT", "KeyB", "KeyN", "KeyI"]) {
      expect(menuChordCommand(ctrl(code))).toBeNull();
    }
  });

  it("ignores meta chords and unclaimed AltGr combos", () => {
    expect(menuChordCommand(ev({ code: "KeyC", ctrlKey: true, metaKey: true }))).toBeNull();
    // AltGr on Windows arrives as ctrl+alt; only D and W are claimed.
    expect(menuChordCommand(ctrlAlt("KeyE"))).toBeNull();
    expect(menuChordCommand(ctrlAlt("KeyQ"))).toBeNull();
    // Ctrl+Shift+Alt is nothing of ours.
    expect(
      menuChordCommand(ev({ code: "KeyD", ctrlKey: true, shiftKey: true, altKey: true })),
    ).toBeNull();
  });
});
