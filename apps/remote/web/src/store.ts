// SPDX-License-Identifier: Apache-2.0
// IndexedDB persistence for the Canopy remote web app: the non-extractable
// device key (`keys` store) and paired hosts (`hosts` store).

import { b64decode, idFromSpki } from "./crypto.js";
import type { DeviceKey } from "./crypto.js";

export const DB_NAME = "canopy-remote";
export const KEYS_STORE = "keys";
export const HOSTS_STORE = "hosts";
const DEVICE_ROW_ID = "device";

export interface HostRecord {
  host_id: string;
  host_spki: string;
  label: string;
}

interface DeviceRow {
  id: string;
  privateKey: CryptoKey;
  spkiB64: string;
  deviceId: string;
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

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = idb().open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEYS_STORE)) {
        db.createObjectStore(KEYS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(HOSTS_STORE)) {
        db.createObjectStore(HOSTS_STORE, { keyPath: "host_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open IndexedDB"));
  });
}

async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = openDb();
  const database = await db;
  try {
    const tx = database.transaction(store, mode);
    const result = await run(tx.objectStore(store));
    if (mode !== "readonly") {
      await transactionDone(tx);
    }
    return result;
  } finally {
    database.close();
  }
}

export async function loadDeviceKey(): Promise<DeviceKey | null> {
  const row = await withStore(KEYS_STORE, "readonly", (s) =>
    request<DeviceRow | undefined>(s.get(DEVICE_ROW_ID) as IDBRequest<DeviceRow | undefined>),
  );
  if (!row) {
    return null;
  }
  const spki = b64decode(row.spkiB64);
  return { privateKey: row.privateKey, spki, spkiB64: row.spkiB64, deviceId: row.deviceId };
}

export async function saveDeviceKey(device: DeviceKey): Promise<void> {
  const row: DeviceRow = {
    id: DEVICE_ROW_ID,
    privateKey: device.privateKey,
    spkiB64: device.spkiB64,
    deviceId: device.deviceId,
  };
  await withStore(KEYS_STORE, "readwrite", (s) => {
    s.put(row);
  });
}

// Recompute the id from the stored SPKI so a stale row can never disagree
// with the key it carries.
export async function refreshDeviceId(device: DeviceKey): Promise<DeviceKey> {
  const deviceId = await idFromSpki(device.spki);
  if (deviceId === device.deviceId) {
    return device;
  }
  const fixed = { ...device, deviceId };
  await saveDeviceKey(fixed);
  return fixed;
}

export async function saveHost(host: HostRecord): Promise<void> {
  await withStore(HOSTS_STORE, "readwrite", (s) => {
    s.put(host);
  });
}

export async function getHost(hostId: string): Promise<HostRecord | null> {
  const row = await withStore(HOSTS_STORE, "readonly", (s) =>
    request<HostRecord | undefined>(s.get(hostId) as IDBRequest<HostRecord | undefined>),
  );
  return row ?? null;
}

export async function listHosts(): Promise<HostRecord[]> {
  return withStore(HOSTS_STORE, "readonly", (s) =>
    request<HostRecord[]>(s.getAll() as IDBRequest<HostRecord[]>),
  );
}

export async function deleteHost(hostId: string): Promise<void> {
  await withStore(HOSTS_STORE, "readwrite", (s) => {
    s.delete(hostId);
  });
}

// Forget this device: drop the device key and every paired host, so the
// browser holds nothing that only made sense signed in.
export async function clearDevice(): Promise<void> {
  await withStore(KEYS_STORE, "readwrite", (s) => {
    s.delete(DEVICE_ROW_ID);
  });
  await withStore(HOSTS_STORE, "readwrite", (s) => {
    s.clear();
  });
}
