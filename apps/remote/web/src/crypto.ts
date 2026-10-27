// SPDX-License-Identifier: Apache-2.0
// Device identity and pairing cryptography for the Canopy remote web app.
// WebCrypto only. Base64 is standard with padding.

export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 10;
export const NONCE_BYTES = 16;
export const PAIR_ITERATIONS = 600000;

const PAIR_SALT_PREFIX = "canopy-remote/v1/pair\n";
const PAIR_INIT_PREFIX = "canopy-remote/v1/pair-init\n";
const PAIR_OK_PREFIX = "canopy-remote/v1/pair-ok\n";
const OFFER_PREFIX = "canopy-remote/v1/offer\n";
const ANSWER_PREFIX = "canopy-remote/v1/answer\n";

export interface DeviceKey {
  privateKey: CryptoKey;
  spki: Uint8Array;
  spkiB64: string;
  deviceId: string;
}

export function b64encode(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function b64decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function utf8(message: string): Uint8Array {
  return new TextEncoder().encode(message);
}

// Copy into a fresh ArrayBuffer-backed view for the WebCrypto typed-array
// generics (Uint8Array<ArrayBufferLike> is not a BufferSource).
function view(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle;
}

// Uppercase, drop `-` and whitespace, fold lookalikes, then require 10
// Crockford base32 chars.
export function normalizeCode(input: string): string {
  const code = input
    .toUpperCase()
    .replace(/[-\s]/g, "")
    .replace(/I/g, "1")
    .replace(/L/g, "1")
    .replace(/O/g, "0");
  if (code.length !== CODE_LENGTH || ![...code].every((c) => CODE_ALPHABET.includes(c))) {
    throw new Error("Invalid pairing code");
  }
  return code;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", view(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// device_id / host_id: first 16 hex chars of SHA-256 over the SPKI DER.
export async function idFromSpki(spkiDer: Uint8Array): Promise<string> {
  return (await sha256Hex(spkiDer)).slice(0, 16);
}

export function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export async function generateDeviceKey(): Promise<DeviceKey> {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
  const spkiB64 = b64encode(spki);
  const deviceId = await idFromSpki(spki);
  return { privateKey: pair.privateKey, spki, spkiB64, deviceId };
}

export async function importSpkiVerifyKey(spkiDer: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("spki", view(spkiDer), { name: "ECDSA", namedCurve: "P-256" }, true, [
    "verify",
  ]);
}

// K_pair = PBKDF2-SHA256(code, salt, 600000, 256 bits) as an HMAC-SHA256 key.
export async function derivePairKey(codeNormalized: string, hostId: string): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", view(utf8(codeNormalized)), "PBKDF2", false, [
    "deriveKey",
  ]);
  return subtle().deriveKey(
    {
      name: "PBKDF2",
      salt: view(utf8(PAIR_SALT_PREFIX + hostId)),
      iterations: PAIR_ITERATIONS,
      hash: "SHA-256",
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

async function hmacB64(key: CryptoKey, message: string): Promise<string> {
  const mac = await subtle().sign("HMAC", key, view(utf8(message)));
  return b64encode(new Uint8Array(mac));
}

export function pairInitMac(key: CryptoKey, deviceSpkiB64: string, nonceBB64: string): Promise<string> {
  return hmacB64(key, `${PAIR_INIT_PREFIX}${deviceSpkiB64}\n${nonceBB64}`);
}

export function pairOkMac(
  key: CryptoKey,
  hostSpkiB64: string,
  deviceSpkiB64: string,
  nonceBB64: string,
  nonceHB64: string,
): Promise<string> {
  return hmacB64(
    key,
    `${PAIR_OK_PREFIX}${hostSpkiB64}\n${deviceSpkiB64}\n${nonceBB64}\n${nonceHB64}`,
  );
}

export function macEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Offer signature: ECDSA P-256 / SHA-256, P1363 (r||s) output, base64.
export async function signOffer(
  devicePrivateKey: CryptoKey,
  hostId: string,
  ts: string,
  sdp: string,
): Promise<string> {
  const sig = await subtle().sign(
    { name: "ECDSA", hash: "SHA-256" },
    devicePrivateKey,
    view(utf8(`${OFFER_PREFIX}${hostId}\n${ts}\n${sdp}`)),
  );
  return b64encode(new Uint8Array(sig));
}

export async function verifyAnswer(
  hostPublicKey: CryptoKey,
  deviceId: string,
  offerSigB64: string,
  sdp: string,
  answerSigB64: string,
): Promise<boolean> {
  return subtle().verify(
    { name: "ECDSA", hash: "SHA-256" },
    hostPublicKey,
    view(b64decode(answerSigB64)),
    view(utf8(`${ANSWER_PREFIX}${deviceId}\n${offerSigB64}\n${sdp}`)),
  );
}
