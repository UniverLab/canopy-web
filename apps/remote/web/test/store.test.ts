// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { generateDeviceKey, signOffer } from "../src/crypto.js";
import {
  deleteHost,
  getHost,
  listHosts,
  loadDeviceKey,
  refreshDeviceId,
  saveDeviceKey,
  saveHost,
} from "../src/store.js";

async function clearDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = globalThis.indexedDB.deleteDatabase("canopy-remote");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
    req.onblocked = () => resolve();
  });
}

beforeEach(clearDb);

describe("device key storage", () => {
  it("loads nothing when empty", async () => {
    await expect(loadDeviceKey()).resolves.toBeNull();
  });

  it("round-trips a non-extractable key that still signs", async () => {
    const device = await generateDeviceKey();
    await saveDeviceKey(device);
    const loaded = await loadDeviceKey();
    expect(loaded?.deviceId).toBe(device.deviceId);
    expect(loaded?.spkiB64).toBe(device.spkiB64);
    expect(loaded?.spki).toEqual(device.spki);
    expect(loaded?.privateKey.extractable).toBe(false);
    if (!loaded) {
      throw new Error("expected a stored device key");
    }
    const sig = await signOffer(loaded.privateKey, "host", "1", "sdp");
    expect(sig).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it("refreshes a stale device id from the stored SPKI", async () => {
    const device = await generateDeviceKey();
    await saveDeviceKey(device);
    const stale = { ...device, deviceId: "0000000000000000" };
    const fixed = await refreshDeviceId(stale);
    expect(fixed.deviceId).toBe(device.deviceId);
    expect((await loadDeviceKey())?.deviceId).toBe(device.deviceId);
  });
});

describe("host storage", () => {
  it("saves, gets, lists, and deletes hosts", async () => {
    await expect(getHost("nope")).resolves.toBeNull();
    await saveHost({ host_id: "a", host_spki: "spki-a", label: "A" });
    await saveHost({ host_id: "b", host_spki: "spki-b", label: "B" });
    expect(await getHost("a")).toEqual({ host_id: "a", host_spki: "spki-a", label: "A" });
    expect(await listHosts()).toHaveLength(2);
    await deleteHost("a");
    expect(await getHost("a")).toBeNull();
    expect(await listHosts()).toEqual([{ host_id: "b", host_spki: "spki-b", label: "B" }]);
  });

  it("overwrites a re-paired host", async () => {
    await saveHost({ host_id: "a", host_spki: "old", label: "Old" });
    await saveHost({ host_id: "a", host_spki: "new", label: "New" });
    expect(await getHost("a")).toEqual({ host_id: "a", host_spki: "new", label: "New" });
  });
});
