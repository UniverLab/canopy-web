// SPDX-License-Identifier: Apache-2.0
/**
 * WebMCP tools for a browser agent already on a remote.univerlab.org page.
 *
 * API shape matched to univerlab.org's own `src/lib/webmcp.ts`: `registerTool`
 * returns a Promise and rejects on a duplicate `name`; the tool's
 * `execute(inputObject, { signal })` result is JSON-serialized for the
 * caller. `document.modelContext` is the current surface and
 * `navigator.modelContext` the older name earlier trial builds shipped,
 * so the lookup tries both.
 *
 * The two tools are read-only, unauthenticated and pure: static text
 * about the public service, no fetch and no session handle. Nothing here
 * opens a socket, sends a pairing frame or reads a session; pairing and
 * sessions stay where they belong, behind the signed-in UI. Nothing runs
 * where the API is absent: `findModelContext()` returns null,
 * `initWebMcp()` returns before scheduling anything.
 */

const ORIGIN = "https://remote.univerlab.org";

/** What `registerTool` needs. Only the members the draft defines are declared. */
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute(input?: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<string>;
}

export interface ModelContextLike {
  registerTool(tool: McpTool, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** `document.modelContext` first, `navigator.modelContext` as the older name. */
export function findModelContext(): ModelContextLike | null {
  const from = (host: unknown): ModelContextLike | null => {
    const mc = (host as { modelContext?: ModelContextLike } | null | undefined)?.modelContext;
    return mc !== null && mc !== undefined && typeof mc.registerTool === "function" ? mc : null;
  };
  if (typeof document !== "undefined") {
    const doc = from(document);
    if (doc !== null) {
      return doc;
    }
  }
  return typeof navigator !== "undefined" ? from(navigator) : null;
}

/**
 * Deferred so registration never competes with first paint. `requestIdleCallback`
 * where it exists (Chrome ships it), `setTimeout` everywhere else.
 */
export function schedule(fn: () => void): void {
  const w = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
}

/** The public service, as static text: no fetch, no session. */
function remoteStatusText(): string {
  return (
    `Canopy remote (${ORIGIN}) is a private remote for signed-in users: a browser app ` +
    `plus a blind relay. Sign in with GitHub at /auth/login (identity only); the relay ` +
    `sockets are /ws/device and /ws/host; /turn mints TURN credentials for either end. ` +
    `Service summary: ${ORIGIN}/llms.txt; API catalogue: ${ORIGIN}/.well-known/api-catalog.`
  );
}

/** How pairing works, as static text: no fetch, no session. */
function howToPairText(): string {
  return (
    `To pair: sign in at ${ORIGIN}/auth/login, run \`canopy remote pair\` on the host, ` +
    `open ${ORIGIN}/pair#<code>. Browser and host derive the secret on both ends while ` +
    `the relay only forwards frames; after pairing the session channel is end-to-end ` +
    `and the relay cannot read it.`
  );
}

/** The two tools. Pure construction — no fetch, no session handle. */
export function buildTools(): McpTool[] {
  const status: McpTool = {
    name: "remote_status",
    title: "Canopy remote status",
    description:
      "The public Canopy remote service: sign-in, relay sockets, TURN, and where the " +
      "summary and catalogue live. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: () => Promise.resolve(remoteStatusText()),
  };
  const pairing: McpTool = {
    name: "how_to_pair",
    title: "How to pair",
    description:
      "How a browser pairs with a host: sign in, the code, the end-to-end " +
      "handshake. Guidance only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: () => Promise.resolve(howToPairText()),
  };
  return [status, pairing];
}

/**
 * Register the tools. A rejection (a duplicate name, say) is the caller's
 * to swallow: a failed registration must never break the page it loaded from.
 */
export async function registerRemoteTools(mc: ModelContextLike): Promise<void> {
  await Promise.all(buildTools().map((tool) => mc.registerTool(tool)));
}

/**
 * Boot: find the API, and if it is not there, do nothing at all.
 */
export function initWebMcp(): void {
  const mc = findModelContext();
  if (mc === null) {
    return;
  }
  schedule(() => {
    void registerRemoteTools(mc).catch(() => {});
  });
}

// The page imports this module for its side effect only.
if (typeof document !== "undefined") {
  initWebMcp();
}
