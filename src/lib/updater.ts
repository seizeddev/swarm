// SPDX-License-Identifier: GPL-3.0-or-later
// Thin wrapper over tauri-plugin-updater + tauri-plugin-process. The live
// `Update` handle (a class instance with download/install methods) is kept in
// module scope so the store only ever holds serializable status — never a
// non-serializable object that would leak into the persisted session.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import semver from "semver";

let pending: Update | null = null;

export interface UpdateMeta {
  version: string;
  currentVersion: string;
  notes?: string;
  date?: string;
}

/**
 * True iff `candidate` is a strictly higher version than `current`. Uses the
 * canonical `semver` library so pre-release ordering, build metadata, and
 * loose-form (`v`-prefixed) inputs all behave per the spec:
 *
 *   - `1.2.3-rc.1 < 1.2.3` (a final release supersedes its rc)
 *   - `1.2.3+meta == 1.2.3` (build metadata is *not* part of ordering)
 *   - `1.2.4-rc.1 < 1.2.4-rc.2`
 *
 * Anything that fails to parse (truly malformed input) is treated as "not
 * newer" — the rollback-guard defaults to refusing the update.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  try {
    return semver.gt(candidate, current, { loose: true });
  } catch {
    return false;
  }
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
