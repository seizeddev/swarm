// SPDX-License-Identifier: GPL-3.0-or-later
// Thin wrapper over tauri-plugin-updater + tauri-plugin-process. The live
// `Update` handle (a class instance with download/install methods) is kept in
// module scope so the store only ever holds serializable status — never a
// non-serializable object that would leak into the persisted session.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pending: Update | null = null;

export interface UpdateMeta {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}

// Parse a semver core ("v1.2.3-rc1+build" → [1,2,3]); ignores pre-release and
// build metadata. Missing/garbage components read as 0. Tiny on purpose — no dep.
function parseVersion(v: string): [number, number, number] {
  const core = v.trim().replace(/^v/, "").split("+")[0].split("-")[0];
  const parts = core.split(".").map((p) => parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** True iff `candidate` is a strictly higher version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export const updater = {
  /** Hit the release endpoint. Returns metadata when a newer version exists, else null. */
  async check(): Promise<UpdateMeta | null> {
    const update = await check();
    // Rollback guard (defence-in-depth against a tampered latest.json): only
    // accept a strictly newer version. The plugin verifies the signature, but a
    // valid signature on an *older* build would otherwise let an attacker force a
    // downgrade to a known-vulnerable release. Refuse anything not newer.
    if (!update || !isNewerVersion(update.version, update.currentVersion)) {
      await pending?.close().catch(() => {});
      pending = null;
      return null;
    }
    pending = update;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      notes: update.body,
      date: update.date,
    };
  },

  /** Download + install the pending update, reporting byte progress. Does NOT relaunch. */
  async downloadAndInstall(
    onProgress: (downloaded: number, total: number | null) => void,
  ): Promise<void> {
    if (!pending) throw new Error("no pending update to install");
    let downloaded = 0;
    let total: number | null = null;
    await pending.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? null;
          onProgress(0, total);
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onProgress(downloaded, total);
          break;
        case "Finished":
          onProgress(total ?? downloaded, total);
          break;
      }
    });
  },

  /** Restart into the freshly installed version. */
  relaunch,
};
