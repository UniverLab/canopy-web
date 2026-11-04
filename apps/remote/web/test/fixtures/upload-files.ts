// SPDX-License-Identifier: Apache-2.0
// The upload fixtures the Playwright suite sends: a text file, a small
// PDF and a ZIP big enough to cross the 12 KiB part boundary. Generated
// here, never fetched, so the round-trip proves these exact bytes.

export interface UploadFixture {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export function textFixture(): UploadFixture {
  const lines: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    lines.push(`line ${String(i).padStart(2, "0")} — the host keeps these bytes`);
  }
  return {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
  };
}

export function pdfFixture(): UploadFixture {
  const body = [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [] /Count 0 >>",
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");
  return { name: "sheet.pdf", mimeType: "application/pdf", buffer: Buffer.from(body, "utf8") };
}

export function zipFixture(): UploadFixture {
  const buffer = Buffer.alloc(150 * 1024);
  buffer.write("PK\u0003\u0004", 0, "latin1");
  for (let i = 4; i < buffer.length; i += 1) {
    buffer[i] = (i * 37 + 11) % 256;
  }
  return { name: "bundle.zip", mimeType: "application/zip", buffer };
}
