// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

// Mock the OS opener so the allowlist is tested without a real Tauri backend.
const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: openUrlMock }));

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
  it("hands an https URL to the system opener", async () => {
    openUrlMock.mockClear();
    await openExternal("https://github.com/o/r/pull/1");
    expect(openUrlMock).toHaveBeenCalledWith("https://github.com/o/r/pull/1");
  });

  it("rejects and never calls the opener for a disallowed scheme", async () => {
    openUrlMock.mockClear();
    await expect(openExternal("file:///etc/passwd")).rejects.toThrow();
    expect(openUrlMock).not.toHaveBeenCalled();
  });
});
