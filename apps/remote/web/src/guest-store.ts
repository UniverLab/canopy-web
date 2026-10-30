// SPDX-License-Identifier: Apache-2.0
// Guest host pins: the TOFU trust store for hosts a guest browser visits.
// A separate IndexedDB database from the owner's paired hosts, so a guest
// pin can never be mistaken for a pairing — and clearing the device never
// touches it, nor it the device.

export const GUEST_DB_NAME = "canopy-remote-guests";
export const GUEST_HOSTS_STORE = "guest_hosts";

export interface GuestHostRecord {
  /** `${owner_uid}/${host_id}`: one pin per owner and host pair. */
  key: string;
  owner_uid: number;
  host_id: string;
  host_spki: string;
  label: string;
}

export function guestHostKey(ownerUid: number, hostId: string): string {
  return `${ownerUid}/${hostId}`;
}

function idb(): IDBFactory {
  return globalThis.indexedDB;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export function openGuestDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb().open(GUEST_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(GUEST_HOSTS_STORE)) {
        db.createObjectStore(GUEST_HOSTS_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open IndexedDB"));
  });
}

async function withGuestStore<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const database = await openGuestDb();
  try {
    const tx = database.transaction(GUEST_HOSTS_STORE, mode);
    const result = await run(tx.objectStore(GUEST_HOSTS_STORE));
    if (mode !== "readonly") {
      await transactionDone(tx);
    }
    return result;
  } finally {
    database.close();
  }
}

/** The pinned host key for one owner and host pair, or null on first visit. */
export async function getGuestHost(ownerUid: number, hostId: string): Promise<GuestHostRecord | null> {
  const row = await withGuestStore("readonly", (s) =>
    request<GuestHostRecord | undefined>(
      s.get(guestHostKey(ownerUid, hostId)) as IDBRequest<GuestHostRecord | undefined>,
    ),
  );
  return row ?? null;
}

/** Pin (or re-pin, after an explicit owner-side rotation) a host key. */
export async function saveGuestHost(host: GuestHostRecord): Promise<void> {
  await withGuestStore("readwrite", (s) => {
    s.put(host);
  });
}
