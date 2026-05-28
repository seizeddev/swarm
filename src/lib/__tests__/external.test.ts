// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

// Mock the Tauri invoke boundary: `openExternal` now goes through the
// `open_external_url` Rust command instead of the opener plugin directly, so
// the test asserts that the allowlist is enforced *before* the IPC trip.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { isOpenableUrl, openExternal } from "../external";

describe("isOpenableUrl", () => {
  it("accepts http and https", () => {
    expect(isOpenableUrl("https://github.com/o/r/pull/1")).toBe(true);
    expect(isOpenableUrl("http://example.com")).toBe(true);
  });

  it("rejects non-http(s) schemes and unparseable input", () => {
    expect(isOpenableUrl("file:///etc/passwd")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("data:text/html,<script>")).toBe(false);
    expect(isOpenableUrl("not a url")).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });
});

describe("openExternal", () => {
  it("hands an https URL to the Rust open_external_url command", async () => {
    invokeMock.mockClear();
    invokeMock.mockResolvedValue(undefined);
    await openExternal("https://github.com/o/r/pull/1");
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "https://github.com/o/r/pull/1",
    });
  });

  it("rejects and never invokes the Rust command for a disallowed scheme", async () => {
    invokeMock.mockClear();
    await expect(openExternal("file:///etc/passwd")).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("rejects javascript: before the IPC trip", async () => {
    invokeMock.mockClear();
    await expect(openExternal("javascript:alert(1)")).rejects.toThrow();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
