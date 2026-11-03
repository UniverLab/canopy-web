// SPDX-License-Identifier: Apache-2.0
// How a shelf file is shown, decided by the host-provided sniffed mime:
// an image renders inside <img>, text-like types render as plain text,
// and everything else is a download card. HTML never leaves the card
// path, and SVG only ever renders inside <img> — never as markup.

export type PreviewKind = "image" | "text" | "card";

const TEXT_APPLICATION = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/javascript",
  "application/x-javascript",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
]);

const CARD_MIMES = new Set(["text/html", "application/xhtml+xml", "application/xhtml"]);

function normalizeMime(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The rendering a sniffed mime earns. An unknown or empty type is a card. */
export function previewKind(mime: string): PreviewKind {
  const type = normalizeMime(mime);
  if (type === "" || CARD_MIMES.has(type)) {
    return "card";
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("text/") || TEXT_APPLICATION.has(type)) {
    return "text";
  }
  return "card";
}

/** The extension shown in a cell before (or instead of) a thumbnail. */
export function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
  return ext === "" ? "file" : ext;
}

/** A short byte size for the download card. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) {
    return "0 B";
  }
  if (size < 1024) {
    return `${Math.floor(size)} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} kB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
