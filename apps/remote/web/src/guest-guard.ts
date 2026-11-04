// SPDX-License-Identifier: Apache-2.0
// The guest's outbound allowlist: a guest browser may list the granted
// sessions, attach and detach from them, type into them, and send plain
// text prompts — the shared stream of v1. Everything else (spawning,
// composing, the catalog, the shelf, graphs, metrics) never leaves the
// browser: the hub enforces the grant, and this enforces the UI's promise
// that no guest control sends anything beyond the stream.

const ALLOWED = new Set(["list", "attach", "detach", "input", "prompt"]);

/** True when the raw outbound frame is a guest's stream frame. */
export function isGuestFrameAllowed(data: string): boolean {
  let frame: unknown;
  try {
    frame = JSON.parse(data);
  } catch {
    return false;
  }
  if (typeof frame !== "object" || frame === null) {
    return false;
  }
  const row = frame as Record<string, unknown>;
  if (typeof row.t !== "string" || !ALLOWED.has(row.t)) {
    return false;
  }
  // Text prompts only: the draft form is the Prompt Builder's, which
  // guests are not offered, so a draft never leaves a guest browser.
  if (row.t === "prompt" && (typeof row.text !== "string" || "draft" in row)) {
    return false;
  }
  return true;
}

/** A send function that drops whatever the guest may not send. */
export function guardGuestSend(send: (data: string) => boolean): (data: string) => boolean {
  return (data: string) => {
    if (!isGuestFrameAllowed(data)) {
      return false;
    }
    return send(data);
  };
}
