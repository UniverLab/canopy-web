// SPDX-License-Identifier: Apache-2.0
/**
 * graphs.univerlab.org — install-URL redirector for catalogue documents.
 *
 *   curl -fsSL https://graphs.univerlab.org/i/graph/hello-graph
 *   canopy graph install hello-graph
 *
 * It answers every request with either a 302 to the document on GitHub or a
 * 400/404 explaining why not. The Worker never fetches or proxies the
 * document: GitHub stays the download origin and the trust anchor, so this
 * adds no supply-chain surface beyond a redirect.
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

/** The single Analytics Engine method this Worker uses. */
export interface DataPoint {
  indexes?: string[];
  blobs?: string[];
  doubles?: number[];
}

export interface AnalyticsSink {
  writeDataPoint(point: DataPoint): void;
}

export interface Env {
  /** Optional: absent in local dev and in tests, and the Worker must still serve. */
  INSTALLS?: AnalyticsSink;
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

export default {
  fetch(req: Request, env: Env): Response {
    const url = new URL(req.url);
    const parsed = parseTarget(url.pathname, url.searchParams.get("ref"));

    if (!parsed.ok) {
      record(env, req, parsed.rejection, "bad-request");
      const body = parsed.rejection.status === 404 ? `${USAGE}\n` : `${parsed.rejection.reason}\n`;
      return textResponse(body, parsed.rejection.status);
    }

    record(env, req, parsed.target, "redirect");
    return Response.redirect(buildUrl(parsed.target), 302);
  },
};
