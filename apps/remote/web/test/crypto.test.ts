// SPDX-License-Identifier: Apache-2.0
// Contract tests: the d4eb8558 vectors plus code normalisation.

import { beforeAll, describe, expect, it } from "vitest";
import {
  b64decode,
  b64encode,
  derivePairKey,
  generateDeviceKey,
  idFromSpki,
  importSpkiVerifyKey,
  normalizeCode,
  pairInitMac,
  pairOkMac,
  sha256Hex,
  verifyAnswer,
} from "../src/crypto.js";

import {
  ANSWER_SDP,
  ANSWER_SIG,
  CODE,
  CODE_NORMALIZED,
  DEVICE_ID,
  DEVICE_SPKI_B64,
  HOST_ID,
  HOST_SPKI_B64,
  MAC_INIT,
  MAC_OK,
  OFFER_SIG,
  nonceB,
  nonceH,
} from "./vectors.js";

describe("normalizeCode", () => {
  it("keeps a canonical code", () => {
    expect(normalizeCode(CODE)).toBe(CODE_NORMALIZED);
  });

  it("uppercases and drops hyphens and spaces", () => {
    expect(normalizeCode("7k3qh m9p2x")).toBe(CODE_NORMALIZED);
    expect(normalizeCode(" 7K3QH-M9P2X ")).toBe(CODE_NORMALIZED);
  });

  it("folds I/L to 1 and O to 0", () => {
    expect(normalizeCode("IIIIOOOOOO")).toBe("1111000000");
    expect(normalizeCode("llllllllll")).toBe("1111111111");
  });

  it("rejects the wrong length", () => {
    expect(() => normalizeCode("7K3QH-M9P")).toThrow("Invalid pairing code");
    expect(() => normalizeCode("7K3QH-M9P2XX")).toThrow("Invalid pairing code");
    expect(() => normalizeCode("")).toThrow("Invalid pairing code");
  });

  it("rejects characters outside the alphabet", () => {
    expect(() => normalizeCode("7K3QH-M9P2U")).toThrow("Invalid pairing code");
    expect(() => normalizeCode("7K3QH-M9P2!")).toThrow("Invalid pairing code");
  });
});

describe("base64 and hashing", () => {
  it("round-trips bytes with padding", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255]);
    expect(b64decode(b64encode(bytes))).toEqual(bytes);
    expect(b64encode(new Uint8Array([0]))).toBe("AA==");
  });

  it("hashes with SHA-256", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("derives the vector device and host ids from the SPKIs", async () => {
    expect(await idFromSpki(b64decode(DEVICE_SPKI_B64))).toBe(DEVICE_ID);
    expect(await idFromSpki(b64decode(HOST_SPKI_B64))).toBe(HOST_ID);
  });
});

describe("pairing MACs", () => {
  let pairKey: CryptoKey;

  beforeAll(async () => {
    pairKey = await derivePairKey(CODE_NORMALIZED, HOST_ID);
  });

  it("matches mac_init", async () => {
    await expect(pairInitMac(pairKey, DEVICE_SPKI_B64, b64encode(nonceB()))).resolves.toBe(MAC_INIT);
  });

  it("matches mac_ok", async () => {
    await expect(
      pairOkMac(pairKey, HOST_SPKI_B64, DEVICE_SPKI_B64, b64encode(nonceB()), b64encode(nonceH())),
    ).resolves.toBe(MAC_OK);
  });

  it("changes when any input changes", async () => {
    const other = await pairInitMac(pairKey, DEVICE_SPKI_B64, b64encode(nonceH()));
    expect(other).not.toBe(MAC_INIT);
  });
});

describe("answer signatures", () => {
  it("verifies the vector answer signature with the host SPKI", async () => {
    const hostKey = await importSpkiVerifyKey(b64decode(HOST_SPKI_B64));
    await expect(verifyAnswer(hostKey, DEVICE_ID, OFFER_SIG, ANSWER_SDP, ANSWER_SIG)).resolves.toBe(
      true,
    );
  });

  it("refuses a tampered answer signature", async () => {
    const hostKey = await importSpkiVerifyKey(b64decode(HOST_SPKI_B64));
    const forged = `${ANSWER_SIG.slice(0, -4)}MA==`;
    await expect(verifyAnswer(hostKey, DEVICE_ID, OFFER_SIG, ANSWER_SDP, forged)).resolves.toBe(
      false,
    );
  });
});

describe("generateDeviceKey", () => {
  it("creates a non-extractable signing key with a matching id", async () => {
    const device = await generateDeviceKey();
    expect(device.privateKey.extractable).toBe(false);
    expect(device.deviceId).toBe(await idFromSpki(device.spki));
    expect(b64encode(device.spki)).toBe(device.spkiB64);
  });
});
