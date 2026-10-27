// SPDX-License-Identifier: Apache-2.0
// The sample images the fake host keeps on the shelves: one PNG, one
// SVG and one JPEG for the smoke session, one PNG for the host's own
// shelf and one more PNG the host pushes two seconds after attach.
// Everything is generated here — a hand-rolled stored-deflate PNG
// encoder (no compressor needed, so the files land well over one 12 KiB
// transfer part), the SVG as text, and the JPEG through a detached
// canvas. Nothing is fetched: the smoke run has no network.

export interface ShelfImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
  caption: string;
}

const TEXT = new TextEncoder();

function concat(pieces: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const piece of pieces) {
    total += piece.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(piece, offset);
    offset += piece.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

const CRC_TABLE = ((): Int32Array => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = TEXT.encode(type);
  const body = concat([typeBytes, data]);
  return concat([u32(data.length), body, u32(crc32(body))]);
}

// A zlib stream of stored (uncompressed) deflate blocks: the rows are
// already in the file's final form, so a compressor would only cost
// CPU, and every browser decodes this like any other PNG.
function storedZlib(data: Uint8Array): Uint8Array {
  const BLOCK = 65535;
  const count = Math.max(1, Math.ceil(data.length / BLOCK));
  const pieces: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let index = 0; index < count; index += 1) {
    const start = index * BLOCK;
    const slice = data.subarray(start, Math.min(data.length, start + BLOCK));
    const length = slice.length;
    const header = new Uint8Array([
      index === count - 1 ? 1 : 0,
      length & 0xff,
      (length >>> 8) & 0xff,
      ~length & 0xff,
      (~length >>> 8) & 0xff,
    ]);
    pieces.push(header, slice);
  }
  pieces.push(u32(adler32(data)));
  return concat(pieces);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + stride);
    raw[row] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), row + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", storedZlib(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** A deterministic two-tone wash, so every run ships the same bytes. */
function wash(width: number, height: number, seed: number): ImageDataLike {
  const data = new Uint8Array(width * height * 4);
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const t = (x * 0.7 + y * 0.3) / (width + height);
      const grain = (next() % 13) - 6;
      data[i] = clamp(18 + 214 * t + grain);
      data[i + 1] = clamp(150 - 90 * t + grain);
      data[i + 2] = clamp(176 - 40 * t + grain);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8Array;
}

export function smokeShelfImages(): ShelfImage[] {
  const width = 320;
  const height = 200;
  const wash1 = wash(width, height, 7);
  return [
    {
      name: "gradient.png",
      mime: "image/png",
      caption: "colour wash from the run",
      bytes: encodePng(width, height, wash1.data),
    },
    {
      name: "layout.svg",
      mime: "image/svg+xml",
      caption: "layout sketch",
      bytes: TEXT.encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">` +
          `<rect width="320" height="200" fill="#012624"/>` +
          `<circle cx="88" cy="104" r="58" fill="#3fb8b0"/>` +
          `<rect x="164" y="46" width="116" height="116" rx="14" fill="#e09a2b"/>` +
          `<path d="M24 176 L160 44 L296 176 Z" fill="none" stroke="#e08086" stroke-width="7" ` +
          `stroke-linejoin="round"/>` +
          `<text x="24" y="32" font-family="monospace" font-size="18" fill="#d8e6e2">shelf</text>` +
          `</svg>`,
      ),
    },
    {
      name: "capture.jpg",
      mime: "image/jpeg",
      caption: "capture from the smoke run",
      bytes: jpegBytes(480, 320),
    },
  ];
}

export function hostShelfImage(): ShelfImage {
  const size = 160;
  const wash2 = wash(size, size, 23);
  return {
    name: "host-mark.png",
    mime: "image/png",
    caption: "host mark",
    bytes: encodePng(size, size, wash2.data),
  };
}

export function pushedShelfImage(): ShelfImage {
  const wash3 = wash(240, 160, 41);
  return {
    name: "pushed.png",
    mime: "image/png",
    caption: "arrived while you were here",
    bytes: encodePng(240, 160, wash3.data),
  };
}

/** The JPEG goes through a detached canvas: only the browser can do it. */
function jpegBytes(width: number, height: number): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("no 2d context for the shelf fixture");
  }
  const wash4 = wash(width, height, 11);
  const image = ctx.createImageData(width, height);
  image.data.set(wash4.data);
  ctx.putImageData(image, 0, 0);
  // Shapes over the wash keep the JPEG interesting to look at.
  ctx.fillStyle = "rgba(1, 38, 36, 0.82)";
  ctx.fillRect(0, height - 78, width, 78);
  ctx.fillStyle = "#3fb8b0";
  ctx.beginPath();
  ctx.arc(width * 0.28, height * 0.42, height * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e09a2b";
  ctx.fillRect(width * 0.52, height * 0.2, width * 0.3, height * 0.44);
  ctx.fillStyle = "#012624";
  ctx.font = "26px monospace";
  ctx.fillText("canopy remote", 20, height - 30);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
