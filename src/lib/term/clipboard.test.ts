// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { extFromMime, bytesToBase64, pickClipboardImage } from "./clipboard";

describe("extFromMime", () => {
  it("maps known image types", () => {
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/gif")).toBe("gif");
    expect(extFromMime("image/webp")).toBe("webp");
    expect(extFromMime("image/tiff")).toBe("tiff");
    expect(extFromMime("image/bmp")).toBe("bmp");
  });

  it("is case-insensitive and ignores parameters", () => {
    expect(extFromMime("IMAGE/PNG")).toBe("png");
    expect(extFromMime("image/jpeg; charset=binary")).toBe("jpg");
  });

  it("defaults unknown/empty types to png", () => {
    expect(extFromMime("application/octet-stream")).toBe("png");
    expect(extFromMime("")).toBe("png");
  });
});

describe("bytesToBase64", () => {
  it("round-trips through atob", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 65, 66, 67]);
    const decoded = atob(bytesToBase64(bytes));
    expect(decoded.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) expect(decoded.charCodeAt(i)).toBe(bytes[i]);
  });

  it("encodes an empty buffer to an empty string", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  it("handles buffers larger than the 0x8000 chunk without corruption", () => {
    const n = 0x8000 * 2 + 123;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = i & 0xff;
    const decoded = atob(bytesToBase64(bytes));
    expect(decoded.length).toBe(n);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(n - 1)).toBe((n - 1) & 0xff);
  });
});

// A minimal DataTransfer stand-in: the node test env has no DOM DataTransfer, so
// we hand pickClipboardImage plain objects shaped like the bits it reads.
function dt(parts: {
  items?: { kind: string; type: string; file?: File }[];
  files?: File[];
}): DataTransfer {
  const items = parts.items?.map((p) => ({
    kind: p.kind,
    type: p.type,
    getAsFile: () => p.file ?? null,
  }));
  return {
    items: items as unknown as DataTransferItemList,
    files: parts.files as unknown as FileList,
  } as unknown as DataTransfer;
}

const png = () => new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });

describe("pickClipboardImage", () => {
  it("returns the first image item with its extension", () => {
    const f = png();
    const got = pickClipboardImage(dt({ items: [{ kind: "file", type: "image/png", file: f }] }));
    expect(got?.file).toBe(f);
    expect(got?.ext).toBe("png");
  });

  it("skips non-file and non-image items", () => {
    const f = png();
    const got = pickClipboardImage(
      dt({
        items: [
          { kind: "string", type: "text/plain" },
          { kind: "file", type: "application/pdf" },
          { kind: "file", type: "image/png", file: f },
        ],
      }),
    );
    expect(got?.file).toBe(f);
  });

  it("falls back to files when items has no usable image", () => {
    const f = new File([new Uint8Array([9])], "y.jpg", { type: "image/jpeg" });
    const got = pickClipboardImage(dt({ items: [{ kind: "string", type: "text/plain" }], files: [f] }));
    expect(got?.file).toBe(f);
    expect(got?.ext).toBe("jpg");
  });

  it("ignores a file item whose getAsFile returns null", () => {
    const f = png();
    const got = pickClipboardImage(
      dt({ items: [{ kind: "file", type: "image/png" }], files: [f] }),
    );
    // items yielded nothing usable (null file) → fell back to files
    expect(got?.file).toBe(f);
  });

  it("returns null when there is no image", () => {
    expect(pickClipboardImage(dt({ items: [{ kind: "string", type: "text/plain" }] }))).toBeNull();
    expect(pickClipboardImage(dt({}))).toBeNull();
  });
});
