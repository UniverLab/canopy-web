// SPDX-License-Identifier: Apache-2.0
// The preview decision is the host's sniffed mime: images in <img>,
// text-like types as text, everything else (HTML included) a card.

import { describe, expect, it } from "vitest";
import { extensionLabel, formatBytes, previewKind } from "../src/preview.js";

describe("preview kind", () => {
  it("renders images inside <img>", () => {
    expect(previewKind("image/png")).toBe("image");
    expect(previewKind("image/jpeg")).toBe("image");
    expect(previewKind("image/svg+xml")).toBe("image");
    expect(previewKind("IMAGE/PNG")).toBe("image");
  });

  it("renders text, code, json, markdown and csv as text", () => {
    expect(previewKind("text/plain")).toBe("text");
    expect(previewKind("text/markdown")).toBe("text");
    expect(previewKind("text/csv")).toBe("text");
    expect(previewKind("text/x-typescript")).toBe("text");
    expect(previewKind("application/json")).toBe("text");
    expect(previewKind("text/plain; charset=utf-8")).toBe("text");
  });

  it("never renders HTML outside the card", () => {
    expect(previewKind("text/html")).toBe("card");
    expect(previewKind("text/html; charset=utf-8")).toBe("card");
    expect(previewKind("application/xhtml+xml")).toBe("card");
  });

  it("renders pdf, zip and unknown types as a download card", () => {
    expect(previewKind("application/pdf")).toBe("card");
    expect(previewKind("application/zip")).toBe("card");
    expect(previewKind("application/octet-stream")).toBe("card");
    expect(previewKind("")).toBe("card");
  });
});

describe("preview labels", () => {
  it("names the extension and the size", () => {
    expect(extensionLabel("notes.txt")).toBe("txt");
    expect(extensionLabel("README")).toBe("file");
    expect(extensionLabel("archive.tar.gz")).toBe("gz");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
