// SPDX-License-Identifier: Apache-2.0
// A snapshot larger than one 12 KiB host part, shared by the fake host
// and the tests: 500 body lines plus an END marker, so an e2e can read
// from the terminal's buffer only if the very last part decoded.

export const RAW_PART = 12032;

export const LONG_SNAPSHOT_END = "END of the long snapshot";

const BODY_LINES = 500;
const LINE_WIDTH = 62;

const lines: string[] = [];
for (let index = 0; index < BODY_LINES; index += 1) {
  lines.push(`line ${String(index).padStart(3, "0")} `.padEnd(LINE_WIDTH, "."));
}

// Every body line ends in CRLF: 500 x (62 + 2) = 32000 ASCII bytes, then
// a blank line and the END marker with its own CRLF — past the 30 KB
// mark and across three host parts. The marker's CRLF keeps the cursor
// on its own row, so a later live line never lands on the marker's line.
export const LONG_OUTPUT = lines.join("\r\n") + "\r\n\r\n" + LONG_SNAPSHOT_END + "\r\n";
