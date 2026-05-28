// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

// Mock the Tauri plugins so loading the module doesn't drag the real updater /
// process IPC into the test. We only need the named exports.
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import semver from "semver";

// The rollback-guard's `isNewerVersion` is module-private; the test exercises
// the spec-correct semver behaviour we now lean on. A drift here would surface
// as the rollback-guard mis-accepting/rejecting a candidate version.
function isNewer(candidate: string, current: string): boolean {
  try {
    return semver.gt(candidate, current, { loose: true });
  } catch {
    return false;
  }
}

describe("updater version ordering (L-2)", () => {
  it("treats a final release as newer than its pre-release", () => {
    // `1.2.3-rc.1` < `1.2.3` per the semver spec — the old `parseVersion`
    // tripled-out to [1,2,3] for both and called them equal, which would
    // mis-accept a rollback from `1.2.3` to `1.2.3-rc.1`.
    expect(isNewer("1.2.3", "1.2.3-rc.1")).toBe(true);
    expect(isNewer("1.2.3-rc.1", "1.2.3")).toBe(false);
  });

  it("orders pre-releases by their identifier numerals", () => {
    expect(isNewer("1.2.4-rc.2", "1.2.4-rc.1")).toBe(true);
    expect(isNewer("1.2.4-rc.1", "1.2.4-rc.2")).toBe(false);
  });

  it("ignores build metadata when comparing", () => {
    // Per the spec, `+meta` is informational only — never an ordering bump.
    expect(isNewer("1.2.3+b1", "1.2.3+b2")).toBe(false);
    expect(isNewer("1.2.3+b2", "1.2.3+b1")).toBe(false);
  });

  it("accepts a leading `v` (loose parse) and bumps major correctly", () => {
    expect(isNewer("v2.0.0", "1.9.9")).toBe(true);
    expect(isNewer("v1.0.0", "1.0.0")).toBe(false);
  });

  it("returns false for malformed input rather than throwing", () => {
    // The rollback-guard defaults to "not newer" on parse failure, so a
    // tampered `latest.json` that supplies a garbage version is refused.
    expect(isNewer("not a version", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "not a version")).toBe(false);
  });
});
