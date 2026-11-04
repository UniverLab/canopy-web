// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import {
  GUEST_DB_NAME,
  getGuestHost,
  guestHostKey,
  saveGuestHost,
} from "../src/guest-store.js";
import { getHost, saveHost } from "../src/store.js";

async function clearGuestDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = globalThis.indexedDB.deleteDatabase(GUEST_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
    req.onblocked = () => resolve();
  });
}

async function clearOwnerDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = globalThis.indexedDB.deleteDatabase("canopy-remote");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error("delete failed"));
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await clearGuestDb();
  await clearOwnerDb();
});

describe("guest host pins", () => {
  it("keys one pin per owner and host pair", () => {
    expect(guestHostKey(7, "0123456789abcdef")).toBe("7/0123456789abcdef");
  });

  it("misses before the first visit and round-trips after pinning", async () => {
    await expect(getGuestHost(7, "0123456789abcdef")).resolves.toBeNull();
    await saveGuestHost({
      key: guestHostKey(7, "0123456789abcdef"),
      owner_uid: 7,
      host_id: "0123456789abcdef",
      host_spki: "spki-1",
      label: "",
    });
    await expect(getGuestHost(7, "0123456789abcdef")).resolves.toEqual({
      key: "7/0123456789abcdef",
      owner_uid: 7,
      host_id: "0123456789abcdef",
      host_spki: "spki-1",
      label: "",
    });
  });

  it("keeps pins apart by owner and by host", async () => {
    await saveGuestHost({
      key: guestHostKey(7, "aaaaaaaaaaaaaaaa"),
      owner_uid: 7,
      host_id: "aaaaaaaaaaaaaaaa",
      host_spki: "spki-a",
      label: "",
    });
    await saveGuestHost({
      key: guestHostKey(8, "aaaaaaaaaaaaaaaa"),
      owner_uid: 8,
      host_id: "aaaaaaaaaaaaaaaa",
      host_spki: "spki-b",
      label: "",
    });
    // Same host id, other owner: another row, not an overwrite.
    expect((await getGuestHost(7, "aaaaaaaaaaaaaaaa"))?.host_spki).toBe("spki-a");
    expect((await getGuestHost(8, "aaaaaaaaaaaaaaaa"))?.host_spki).toBe("spki-b");
    await expect(getGuestHost(7, "bbbbbbbbbbbbbbbb")).resolves.toBeNull();
  });

  it("re-pins a rotated host key in place", async () => {
    await saveGuestHost({
      key: guestHostKey(7, "aaaaaaaaaaaaaaaa"),
      owner_uid: 7,
      host_id: "aaaaaaaaaaaaaaaa",
      host_spki: "spki-old",
      label: "",
    });
    await saveGuestHost({
      key: guestHostKey(7, "aaaaaaaaaaaaaaaa"),
      owner_uid: 7,
      host_id: "aaaaaaaaaaaaaaaa",
      host_spki: "spki-new",
      label: "",
    });
    expect((await getGuestHost(7, "aaaaaaaaaaaaaaaa"))?.host_spki).toBe("spki-new");
  });

  it("never shares rows with the owner's paired hosts", async () => {
    await saveHost({ host_id: "aaaaaaaaaaaaaaaa", host_spki: "paired-spki", label: "paired" });
    await saveGuestHost({
      key: guestHostKey(7, "aaaaaaaaaaaaaaaa"),
      owner_uid: 7,
      host_id: "aaaaaaaaaaaaaaaa",
      host_spki: "guest-spki",
      label: "",
    });
    // Same host id on both sides: each store keeps its own key.
    expect((await getHost("aaaaaaaaaaaaaaaa"))?.host_spki).toBe("paired-spki");
    expect((await getGuestHost(7, "aaaaaaaaaaaaaaaa"))?.host_spki).toBe("guest-spki");
  });
});
