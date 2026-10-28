// SPDX-License-Identifier: Apache-2.0
// The New dialog's directory memory: the last directory used per host and
// the last 8 directories used from this browser, both in localStorage.
// Every access is guarded: a browser that denies storage must not break
// the dialog. The host validates the path; the browser only remembers.

export const RECENT_DIRS_KEY = "canopy.remote.dirs.recent.v1";
export const RECENT_DIRS_LIMIT = 8;

export function lastDirKey(hostId: string): string {
  return `canopy.remote.dir.${hostId}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function cleanDir(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function readLastDir(hostId: string): string | null {
  if (hostId === "") {
    return null;
  }
  try {
    return cleanDir(storage()?.getItem(lastDirKey(hostId)));
  } catch {
    return null;
  }
}

export function writeLastDir(hostId: string, dir: string): void {
  if (hostId === "") {
    return;
  }
  const clean = cleanDir(dir);
  if (clean === null) {
    return;
  }
  try {
    storage()?.setItem(lastDirKey(hostId), clean);
  } catch {
    // A dialog that cannot remember still spawns.
  }
}

export function readRecentDirs(): string[] {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(RECENT_DIRS_KEY) ?? null;
  } catch {
    return [];
  }
  if (raw === null || raw === "") {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const clean = cleanDir(item);
    if (clean !== null && !out.includes(clean)) {
      out.push(clean);
    }
    if (out.length >= RECENT_DIRS_LIMIT) {
      break;
    }
  }
  return out;
}

// Newest first, de-duplicated, capped at 8. Returns what was stored.
export function pushRecentDir(dir: string): string[] {
  const clean = cleanDir(dir);
  const current = readRecentDirs();
  if (clean === null) {
    return current;
  }
  const next = [clean, ...current.filter((item) => item !== clean)].slice(0, RECENT_DIRS_LIMIT);
  try {
    storage()?.setItem(RECENT_DIRS_KEY, JSON.stringify(next));
  } catch {
    // A dialog that cannot remember still spawns.
  }
  return next;
}

// The datalist, first-seen wins: catalog project directories, the host's
// current session workdirs, then the browser's recent directories.
export function buildDirectorySuggestions(args: {
  catalogPaths: string[];
  sessionWorkdirs: string[];
  recent: string[];
}): string[] {
  const out: string[] = [];
  for (const list of [args.catalogPaths, args.sessionWorkdirs, args.recent]) {
    for (const item of list) {
      const clean = cleanDir(item);
      if (clean !== null && !out.includes(clean)) {
        out.push(clean);
      }
    }
  }
  return out;
}
