// SPDX-License-Identifier: Apache-2.0
/**
 * graphs.univerlab.org — the catalogue site: pages, API and install URLs.
 *
 *   curl -fsSL https://graphs.univerlab.org/i/graph/hello-graph
 *   canopy graph install hello-graph
 *
 * Three surfaces, one Worker: `/api/*` is the JSON API (api.ts), the
 * catalogue pages (/, /search, /g, /n, /llms.txt) are the HTML/markdown
 * renderer (pages/routes.ts), and everything else that is not an install
 * URL falls through to the redirector below, which answers with either a
 * 302 to the document on GitHub or a 400/404 explaining why not. The
 * Worker never fetches or proxies the document: GitHub stays the download
 * origin and the trust anchor, so this adds no supply-chain surface beyond
 * a redirect.
 *
 * It DOES record one aggregate data point per request (Analytics Engine):
 * which document, which kind of client, the Canopy version when there is one,
 * country and outcome. No IP, no full user-agent, no cookies, nothing
 * per-person. The write is fire-and-forget inside a try/catch — if analytics
 * is missing or broken, the redirect still happens.
 */
import {
  type Outcome,
  type Parts,
  USAGE,
  buildUrl,
  canopyVersion,
  clientClass,
  documentKey,
  indexKey,
  parseTarget,
} from "./lib.js";
import { handleApi, type ApiEnv } from "./api.js";
import { handlePage, NOT_PAGE } from "./pages/routes.js";
import { type CacheLike } from "./github.js";

/** The single Analytics Engine method this Worker uses. */
export interface DataPoint {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

export interface AnalyticsSink {
  writeDataPoint(point: DataPoint): void;
}

export interface Env extends ApiEnv {
  /** Optional: absent in local dev and in tests, and the Worker must still serve. */
  INSTALLS?: AnalyticsSink;
}

/** The Cache API when the runtime provides it, undefined otherwise. */
function defaultCache(): CacheLike | undefined {
  const runtime = globalThis as unknown as { caches?: { default?: CacheLike } };
  return runtime.caches?.default;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Country is set by Cloudflare's edge; a local request has none. */
function country(req: Request): string {
  return (req as { cf?: { country?: string } }).cf?.country ?? "";
}

/** One aggregate data point. Never allowed to change the answer. */
function record(env: Env, req: Request, parts: Parts, outcome: Outcome): void {
  try {
    const dataset = env?.INSTALLS;
    if (!dataset) {
      return;
    }
    const userAgent = req.headers.get("user-agent");
    dataset.writeDataPoint({
      indexes: [indexKey(parts)],
      blobs: [
        parts.kind,
        documentKey(parts),
        clientClass(userAgent),
        canopyVersion(userAgent),
        country(req),
        outcome,
      ],
      doubles: [1],
    });
  } catch {
    // Telemetry must never break an install.
  }
}

/** First path segment, without leading slashes. */
function firstSegment(pathname: string): string {
  return pathname.replace(/^\/+/, "").split("/")[0] ?? "";
}

/** The page routes: everything else stays the synchronous redirector. */
function isPagePath(pathname: string): boolean {
  const first = firstSegment(pathname);
  return first === "" || first === "search" || first === "llms.txt" || first === "g" || first === "n";
}

/** The injected transport and cache: production defaults, test overrides. */
export interface WorkerDeps {
  /** The upstream transport; the e2e fixtures inject a stub table. */
  fetchImpl?: typeof fetch;
  /** The Cache API stand-in; defaults to the runtime's `caches.default`. */
  cache?: CacheLike;
}

/** Answer one request: JSON API, catalogue pages, else the redirector. */
function answer(req: Request, env: Env, deps: WorkerDeps): Response | Promise<Response> {
  const url = new URL(req.url);
  const apiDeps = { cache: deps.cache ?? defaultCache(), fetchImpl: deps.fetchImpl };
  if (url.pathname.startsWith("/api")) {
    return handleApi(req, env, apiDeps).then(
      (result) => result === true ? install(req, env, url) : result,
    );
  }
  // The catalogue pages claim /, /search, /g, /n and /llms.txt; every
  // other path (the /i install routes above all) stays a redirect.
  if (isPagePath(url.pathname)) {
    return handlePage(req, env, apiDeps).then(
      (result) => result === NOT_PAGE ? install(req, env, url) : result,
    );
  }
  return install(req, env, url);
}

/**
 * Build the Worker over an injected transport. Production calls it with no
 * arguments (the default export below); the visual e2e fixture wires the
 * same `fakeFetch` table the page tests use, so no browser check reaches
 * live GitHub.
 */
export function createWorker(deps: WorkerDeps = {}) {
  return {
    fetch(req: Request, env: Env): Response | Promise<Response> {
      return answer(req, env, deps);
    },
  };
}

export default createWorker();

/** The install redirector: 302 to GitHub, or a 400/404 explaining why not. */
function install(req: Request, env: Env, url: URL): Response {
  const parsed = parseTarget(url.pathname, url.searchParams.get("ref"));

    if (!parsed.ok) {
      record(env, req, parsed.rejection, "bad-request");
      const body = parsed.rejection.status === 404 ? `${USAGE}\n` : `${parsed.rejection.reason}\n`;
      return textResponse(body, parsed.rejection.status);
    }

    record(env, req, parsed.target, "redirect");
    return Response.redirect(buildUrl(parsed.target), 302);
}
