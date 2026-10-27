// SPDX-License-Identifier: Apache-2.0
// Test environment: WebCrypto from Node (happy-dom has no subtle crypto)
// and an in-memory IndexedDB.
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";

Object.defineProperty(globalThis, "crypto", {
  value: webcrypto,
  configurable: true,
  writable: true,
});
