// SPDX-License-Identifier: Apache-2.0
/**
 * The JSON API for graphs.univerlab.org: the contract the pages and
 * third-party agents consume.
 *
 *   GET /api/official                        -> { graphs, nodes }
 *   GET /api/search?q=&sort=top|new&page=    -> { items, q, sort, page, total, truncated }
 *   GET /api/g/<owner>/<repo>/<slug>         -> one graph document
 *   GET /api/n/<owner>/<repo>/<slug>         -> one node document
 *   GET /api/index-status                    -> the last index run's accounting
 *
 * Every answer is read from the scheduled index in KV (store.ts): no API
 * call reaches GitHub, so traffic never spends quota. Before the first
 * scheduled run builds the index, data routes answer 503
 * `{ error: "indexing" }`. Every answer is CORS-open for GET, every error
 * is a typed JSON body (never an HTML stack trace, never a 500 the pages
 * cannot show). `index.ts` hands `/api/*` here first; the install
 * redirector keeps its routes.
 */
import { attachDownloads, createAnalytics } from "./analytics.js";
import { type CacheLike, type Log } from "./github.js";
import type { DocumentKind } from "../../../src/schema.js";
import { SLUG_RE, OWNER_RE, REPO_RE } from "./lib.js";
import { createStore, type BlockedEntry, type KV } from "./store.js";
import { documentFromStored, entryFor, officialFromIndex, searchFromIndex } from "./catalog.js";
import { type SearchSort } from "./search.js";

/** Environment the API reads: analytics config plus the index binding. */
export interface ApiEnv {
  GITHUB_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  INDEX?: KV;
}

/** Dependency injection for tests; production defaults. */
export interface ApiDeps {
  fetchImpl?: typeof fetch;
  cache?: CacheLike;
  log?: Log;
}

const NO_LOG: Log = () => undefined;

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
  };
}

function jsonResponse(payload: unknown, status: number, maxAge: number): Response {
  return new Response(JSON.stringify(payload, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
      ...corsHeaders(),
    },
  });
}

interface ApiErrorBody {
  kind: string;
  message: string;
  status: number;
}

function errorResponse(error: ApiErrorBody): Response {
  return jsonResponse(
    { kind: error.kind, message: error.message, status: error.status },
    error.status,
    60,
  );
}

/**
 * A document removed after a community report: 410, with the reason and the
 * issue the maintainer decided on. `canopy graph install` prints both.
 */
function blockedResponse(blocked: BlockedEntry): Response {
  return jsonResponse(
    { error: "blocked", reason: blocked.reason, issue: blocked.issue },
    410,
    60,
  );
}

/** The cold start: no index yet, the first scheduled run is still ahead. */
function indexingResponse(): Response {
  return new Response(`${JSON.stringify({ error: "indexing" })}\n`, {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "120",
      ...corsHeaders(),
    },
  });
}

/** A non-API request: index.ts keeps routing it to the redirector. */
export const NOT_API = true as const;

function badQuery(message: string): ApiErrorBody {
  return { kind: "invalid-query", message, status: 400 };
}

function invalidPath(message: string): ApiErrorBody {
  return { kind: "invalid-path", message, status: 400 };
}

/** Read `q`, `sort` and `page` out of a search request, 400s when malformed. */
function readSearchInput(url: URL): { input: { q: string; sort: SearchSort; page: number } } | ApiErrorBody {
  const q = url.searchParams.get("q") ?? "";
  if (q.length > 256) {
    return badQuery("q must be at most 256 characters");
  }
  const sortParam = url.searchParams.get("sort") ?? "top";
  if (sortParam !== "top" && sortParam !== "new") {
    return badQuery("sort must be top or new");
  }
  const pageParam = url.searchParams.get("page") ?? "1";
  const page = Number.parseInt(pageParam, 10);
  if (!Number.isInteger(page) || page < 1) {
    return badQuery("page must be a positive integer");
  }
  return { input: { q, sort: sortParam, page } };
}

/** Parse `/api/<verb>/<...segments>`; null when the path is not a known route. */
function readRoute(pathname: string): { verb: string; segments: string[] } | null {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "api") {
    return null;
  }
  return { verb: parts[1] ?? "", segments: parts.slice(2) };
}

/** True when owner/repo/slug all follow the rules the URLs promise. */
function partsInvalid(owner: string, repo: string, slug: string): string | null {
  if (!OWNER_RE.test(owner)) {
    return "owner must follow GitHub rules";
  }
  if (!REPO_RE.test(repo)) {
    return "repo must follow GitHub rules";
  }
  if (!SLUG_RE.test(slug)) {
    return "slug must be 1-48 characters of a-z, 0-9 or -";
  }
  return null;
}

/**
 * The API router. Returns NOT_API for paths outside `/api/*` so index.ts
 * keeps its redirect routes untouched, a JSON answer for every API request,
 * and typed errors everywhere.
 */
export async function handleApi(
  request: Request,
  env: ApiEnv,
  deps: ApiDeps = {},
): Promise<Response | typeof NOT_API> {
  const url = new URL(request.url);
  const route = readRoute(url.pathname);
  const log = deps.log ?? NO_LOG;

  if (route === null || route.verb === "") {
    return NOT_API;
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET") {
    return errorResponse({ kind: "invalid-path", message: "only GET is supported", status: 400 });
  }

  const store = createStore(env.INDEX);
  const volumes = async () =>
    createAnalytics({
      fetchImpl: deps.fetchImpl,
      cache: deps.cache,
      accountId: env.CF_ACCOUNT_ID,
      token: env.CF_ANALYTICS_TOKEN,
      log,
    }).volume();

  switch (route.verb) {

    case "official": {
      if (route.segments.length !== 0) {
        return errorResponse(invalidPath("usage: GET /api/official"));
      }
      const index = await store.getIndex();
      if (index === null) {
        return indexingResponse();
      }
      const listing = officialFromIndex(index);
      const counts = await volumes();
      return jsonResponse(
        {
          graphs: attachDownloads(listing.graphs, counts),
          nodes: attachDownloads(listing.nodes, counts),
        },
        200,
        300,
      );
    }
    case "search": {
      if (route.segments.length !== 0) {
        return errorResponse(invalidPath("usage: GET /api/search?q=&sort=top|new&page="));
      }
      const parsed = readSearchInput(url);
      if ("kind" in parsed) {
        return errorResponse(parsed);
      }
      const index = await store.getIndex();
      if (index === null) {
        return indexingResponse();
      }
      const outcome = searchFromIndex(index, parsed.input);
      const counts = await volumes();
      return jsonResponse(
        { ...outcome, items: attachDownloads(outcome.items, counts) },
        200,
        60,
      );
    }
    case "g":
    case "n": {
      if (route.segments.length !== 3) {
        return errorResponse(invalidPath(`usage: GET /api/${route.verb}/<owner>/<repo>/<slug>`));
      }
      const [owner, repo, slug] = route.segments as [string, string, string];
      const invalid = partsInvalid(owner, repo, slug);
      if (invalid !== null) {
        return errorResponse(invalidPath(invalid));
      }
      const kind: DocumentKind = route.verb === "g" ? "graph" : "node";
      // Before the index: a block outlives whatever the last run wrote.
      const blocked = await store.getBlocked(kind, owner, repo, slug);
      if (blocked !== null) {
        return blockedResponse(blocked);
      }
      const index = await store.getIndex();
      if (index === null) {
        return indexingResponse();
      }
      // One document, of the kind the route names: `GET /api/g` answers a
      // graph or nothing, `GET /api/n` a node or nothing. `document` is the
      // validated JSON itself, for the pages' renderer.
      const entry = entryFor(index, kind, owner, repo, slug);
      if (entry === null) {
        return errorResponse({
          kind: "invalid-document",
          message: `no ${kind} named ${slug} in ${owner}/${repo}`,
          status: 404,
        });
      }
      const stored = await store.getDoc(kind, owner, repo, slug);
      if (stored === null) {
        return errorResponse({
          kind: "invalid-document",
          message: `no ${kind} named ${slug} in ${owner}/${repo}`,
          status: 404,
        });
      }
      return jsonResponse(documentFromStored(entry, stored), 200, 300);
    }
    case "index-status": {
      if (route.segments.length !== 0) {
        return errorResponse(invalidPath("usage: GET /api/index-status"));
      }
      const meta = await store.getMeta();
      if (meta === null) {
        return indexingResponse();
      }
      const { invalid, ...rest } = meta;
      return jsonResponse({ ...rest, invalid: invalid.slice(0, 20) }, 200, 60);
    }
    default:
      return errorResponse(invalidPath("unknown API route"));
  }
}
