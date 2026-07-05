// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { formatBytes, imageMime } from "../media";

describe("imageMime", () => {
  it("maps renderable image extensions to their MIME type", () => {
    expect(imageMime("docs/logo.png")).toBe("image/png");
    expect(imageMime("photo.JPG")).toBe("image/jpeg");
    expect(imageMime("a/b/pic.jpeg")).toBe("image/jpeg");
    expect(imageMime("anim.gif")).toBe("image/gif");
    expect(imageMime("modern.webp")).toBe("image/webp");
    expect(imageMime("icon.svg")).toBe("image/svg+xml");
    expect(imageMime("fav.ico")).toBe("image/x-icon");
    expect(imageMime("new.avif")).toBe("image/avif");
  });

  it("returns null for non-images and extension-less paths", () => {
    expect(imageMime("src/main.rs")).toBeNull();
    expect(imageMime("archive.tar.gz")).toBeNull();
    expect(imageMime("Makefile")).toBeNull();
    expect(imageMime("weird.")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats across unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(2.3 * 1024 * 1024)).toBe("2.3 MB");
    expect(formatBytes(200 * 1024 * 1024)).toBe("200 MB");
  });
});
