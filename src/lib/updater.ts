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

export const updater = {
  /** Hit the release endpoint. Returns metadata when a newer version exists, else null. */
  async check(): Promise<UpdateMeta | null> {
    const update = await check();
    if (!update) {
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
