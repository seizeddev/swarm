// SPDX-License-Identifier: GPL-3.0-or-later

// Extensions the commit view can render inline via a data: URI. SVG is
// included: it usually arrives as a *text* diff (which wins), but a
// binary-attribute'd or freshly added SVG still gets a preview.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/** MIME type for a renderable image path, or null for everything else. */
export function imageMime(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null;
}

/** Human byte size: 0 B, 512 B, 1.5 KB, 2.3 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
}
