// SPDX-License-Identifier: GPL-3.0-or-later
// Clipboard-image paste support. A PTY is a byte stream, so a pasted image can't
// travel through it raw — like cmux/WezTerm/iTerm2 we persist the image to a temp
// file (in the Rust core) and paste the file *path*, which CLI agents (Claude
// Code, Codex) then read off disk. Claude Code's own clipboard read can't help
// here: on macOS it grabs the legacy pasteboard type `«class PNGf»`, but WebKit
// (our WKWebView) places images as the modern UTI `public.png`, so that read finds
// nothing. The bytes we hand the core come straight from the WebKit paste event,
// which side-steps the pasteboard-type mismatch entirely.

// Map a clipboard image MIME type to a file extension. Unknown/missing → png, the
// dominant screenshot format and the safest default for an opaque image blob.
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
};

export function extFromMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase().split(";")[0].trim()] ?? "png";
}

// Base64-encode bytes for the IPC hop to the core. Chunked so a multi-MB
// screenshot doesn't overflow the argument limit of `String.fromCharCode(...)`.
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export interface ClipboardImage {
  file: File;
  ext: string;
}

// Pull the first image out of a paste/drop `DataTransfer`, or null if none. Tries
// `items` (the modern list, where a screenshot shows up as kind:"file") first and
// falls back to `files`. Callers should only reach for this when there is no
// usable text — text always wins (it's what the user means by "paste").
export function pickClipboardImage(data: DataTransfer): ClipboardImage | null {
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) return { file, ext: extFromMime(it.type) };
      }
    }
  }
  const files = data.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type.startsWith("image/")) return { file: f, ext: extFromMime(f.type) };
    }
  }
  return null;
}
