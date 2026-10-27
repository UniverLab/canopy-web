// SPDX-License-Identifier: Apache-2.0
// Pairing: the code-authenticated key exchange with a host through the relay.
// The code never leaves the page: it is derived into K_pair locally and is
// never sent, logged, or stored.

import {
  NONCE_BYTES,
  b64decode,
  b64encode,
  derivePairKey,
  idFromSpki,
  macEqual,
  normalizeCode,
  pairInitMac,
  pairOkMac,
  randomBytes,
} from "./crypto.js";
import type { DeviceKey } from "./crypto.js";
import type { RelayFrame, RelaySocket } from "./relay.js";
import type { HostRecord } from "./store.js";

const PAIR_TIMEOUT_MS = 60000;

export function pairFailMessage(reason: string): string {
  if (reason === "no_code") {
    return "No pairing code is open on this host";
  }
  if (reason === "expired") {
    return "The code expired; create a new one in canopy";
  }
  if (reason === "bad_code") {
    return "Wrong code";
  }
  return `Pairing failed (${reason})`;
}

export function defaultDeviceLabel(): string {
  const nav = globalThis.navigator;
  const ua = nav.userAgent;
  let browser = "Browser";
  if (/Firefox\//.test(ua)) {
    browser = "Firefox";
  } else if (/Edg\//.test(ua)) {
    browser = "Edge";
  } else if (/Chrome\//.test(ua)) {
    browser = "Chrome";
  } else if (/Safari\//.test(ua)) {
    browser = "Safari";
  }
  const data = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? nav.platform ?? "";
  return `${browser} on ${platform === "" ? "unknown" : platform}`;
}

export interface PairingDeps {
  relay: RelaySocket;
  hostId: string;
  hostLabel: string;
  code: string;
  deviceLabel: string;
  device: DeviceKey;
  saveHost: (host: HostRecord) => Promise<void>;
  randomNonce?: () => Uint8Array;
  timeoutMs?: number;
}

interface PairOkBody {
  host_spki: string;
  nonce_h: string;
  mac: string;
}

function asPairOk(body: unknown): PairOkBody | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const row = body as Record<string, unknown>;
  if (row.t !== "pair_ok") {
    return null;
  }
  if (typeof row.host_spki !== "string" || typeof row.nonce_h !== "string" || typeof row.mac !== "string") {
    return null;
  }
  return { host_spki: row.host_spki, nonce_h: row.nonce_h, mac: row.mac };
}

function asPairFail(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const row = body as Record<string, unknown>;
  if (row.t !== "pair_fail" || typeof row.reason !== "string") {
    return null;
  }
  return row.reason;
}

export async function runPairing(deps: PairingDeps): Promise<HostRecord> {
  const code = normalizeCode(deps.code);
  const pairKey = await derivePairKey(code, deps.hostId);
  const nonceB = deps.randomNonce ? deps.randomNonce() : randomBytes(NONCE_BYTES);
  const nonceBB64 = b64encode(nonceB);
  const mac = await pairInitMac(pairKey, deps.device.spkiB64, nonceBB64);

  deps.relay.send(`h:${deps.hostId}`, {
    t: "pair_init",
    device_spki: deps.device.spkiB64,
    device_label: deps.deviceLabel,
    nonce_b: nonceBB64,
    mac,
  });

  const fromHost = `h:${deps.hostId}`;
  const reply = await new Promise<PairOkBody>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Pairing timed out"));
    }, deps.timeoutMs ?? PAIR_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    const unsubscribe = deps.relay.onFrame((frame: RelayFrame) => {
      if (frame.from !== fromHost) {
        return;
      }
      const failReason = asPairFail(frame.body);
      if (failReason !== null) {
        cleanup();
        reject(new Error(pairFailMessage(failReason)));
        return;
      }
      const ok = asPairOk(frame.body);
      if (ok !== null) {
        cleanup();
        resolve(ok);
      }
    });
  });

  const expected = await pairOkMac(
    pairKey,
    reply.host_spki,
    deps.device.spkiB64,
    nonceBB64,
    reply.nonce_h,
  );
  if (!macEqual(expected, reply.mac)) {
    throw new Error("Host identity check failed");
  }
  const spkiId = await idFromSpki(b64decode(reply.host_spki));
  if (!spkiId.startsWith(deps.hostId)) {
    throw new Error("Host identity check failed");
  }

  const host: HostRecord = { host_id: deps.hostId, host_spki: reply.host_spki, label: deps.hostLabel };
  await deps.saveHost(host);
  return host;
}
