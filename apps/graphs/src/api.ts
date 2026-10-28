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
 *   POST /api/drafts                         -> store an unreviewed draft (201)
 *   GET /api/drafts/<id>                     -> the stored draft, never consumed
 *
 * Every answer is read from the scheduled index in KV (store.ts): no API
 * call reaches GitHub, so traffic never spends quota. Before the first
 * scheduled run builds the index, data routes answer 503
 * `{ error: "indexing" }`. Every answer is CORS-open for GET, every error
 * is a typed JSON body (never an HTML stack trace, never a 500 the pages
 * cannot show). The drafts routes are the one write surface: they store in
 * their own KV namespace for 30 minutes (drafts.ts), are rate limited by
 * client IP when the Workers binding is present, and never reach GitHub.
 * `index.ts` hands `/api/*` here first; the install redirector keeps its
 * routes.
 */
import { attachDownloads, createAnalytics } from "./analytics.js";
import { type CacheLike, type Log } from "./github.js";
import type { DocumentKind, JsonValue } from "../../../src/schema.js";
import { SLUG_RE, OWNER_RE, REPO_RE } from "./lib.js";
import { createStore, type BlockedEntry, type KV } from "./store.js";
import { documentFromStored, entryFor, officialFromIndex, searchFromIndex } from "./catalog.js";
import { type SearchSort } from "./search.js";
import {
  DRAFT_MAX_BYTES,
  type DraftKV,
  createDraft,
  draftName,
  draftPagePath,
  draftProblems,
  readDraft,
} from "./drafts.js";
import { SITE_NAME, installCommand } from "./pages/copy.js";
import { isRecord } from "./json.js";

/** Environment the API reads: analytics config plus the index binding. */
export interface ApiEnv {
  GITHUB_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  INDEX?: KV;
  /** The draft namespace; absent in dev and where drafting is off. */
  DRAFTS?: DraftKV;
  /** The Workers rate-limiting binding; absent in tests and dev, so drafts stay unlimited. */
  DRAFT_LIMIT?: RateLimiter;
}

/** The one Workers rate-limiting method the drafts route uses. */
export interface RateLimitResult {
  success: boolean;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<RateLimitResult>;
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

/** `maxAge` null asks for `no-store`: the answer is a draft, not cached data. */
function jsonResponse(payload: unknown, status: number, maxAge: number | null): Response {
  return new Response(JSON.stringify(payload, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge === null ? "no-store" : `public, max-age=${maxAge}`,
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

/** The edge sets this header on every request; the limiter keys on it. */
const CLIENT_IP_HEADER = "cf-connecting-ip";

/** How many drafts one client may create in a minute. */
const DRAFT_LIMIT_PER_MINUTE = 10;

/** A typed drafts error: nothing here is ever cached. */
function draftError(kind: string, message: string, status: number): Response {
  return jsonResponse({ kind, message, status }, status, null);
}

/**
 * True when the client may create another draft. The binding is absent in
 * dev and in the tests, where drafts are deliberately unlimited.
 */
async function draftAllowed(request: Request, env: ApiEnv): Promise<boolean> {
  const limiter = env.DRAFT_LIMIT;
  if (limiter === undefined) {
    return true;
  }
  const ip = request.headers.get(CLIENT_IP_HEADER) ?? "";
  try {
    return (await limiter.limit({ key: `draft:${ip}` })).success;
  } catch {
    // A broken limiter never withholds a draft.
    return true;
  }
}

/** `{ kind, document }` from the request body, or the 413/400 that refuses it. */
async function readDraftRequest(
  request: Request,
): Promise<{ kind: DocumentKind; document: JsonValue } | Response> {
  const tooLarge = draftError("too-large", "a draft body is at most 256 KiB", 413);
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > DRAFT_MAX_BYTES) {
    return tooLarge;
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return draftError("invalid-body", "the body is not readable", 400);
  }
  // The header is advisory: measure the bytes the Worker actually received.
  if (new TextEncoder().encode(text).length > DRAFT_MAX_BYTES) {
    return tooLarge;
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return draftError("invalid-body", "the body must be JSON", 400);
  }
  if (!isRecord(body)) {
    return draftError("invalid-body", "the body must be { kind, document }", 400);
  }
  const kind = body["kind"];
  if (kind !== "graph" && kind !== "node") {
    return draftError("invalid-body", "kind must be graph or node", 400);
  }
  const document = body["document"];
  if (!isRecord(document)) {
    return draftError("invalid-body", "document must be an object", 400);
  }
  return { kind, document };
}

/** `POST /api/drafts`: rate limit, validate, store for 30 minutes, 201. */
async function createDraftResponse(request: Request, env: ApiEnv): Promise<Response> {
  if (!(await draftAllowed(request, env))) {
    const refused = draftError(
      "rate-limited",
      `at most ${DRAFT_LIMIT_PER_MINUTE} drafts per minute per client`,
      429,
    );
    const headers = new Headers(refused.headers);
    headers.set("retry-after", "60");
    return new Response(refused.body, { status: 429, headers });
  }
  const kv = env.DRAFTS;
  if (kv === undefined) {
    return draftError("unavailable", "drafts are unavailable", 503);
  }
  const parsed = await readDraftRequest(request);
  if (parsed instanceof Response) {
    return parsed;
  }
  const problems = draftProblems(parsed.kind, parsed.document);
  if (problems.length > 0) {
    return jsonResponse(
      {
        kind: "invalid-document",
        message: "the draft document did not validate",
        status: 400,
        problems: problems.slice(0, 20),
        total: problems.length,
      },
      400,
      null,
    );
  }
  const created = await createDraft(kv, parsed.kind, parsed.document);
  return jsonResponse(
    {
      id: created.id,
      kind: parsed.kind,
      name: draftName(parsed.document),
      expires_at: created.expires_at,
      page_url: `https://${SITE_NAME}${draftPagePath(created.id)}`,
      install: installCommand(parsed.kind, `draft:${created.id}`),
    },
    201,
    null,
  );
}

/** `GET /api/drafts/<id>`: the stored draft as-is, so the editor can reopen it. */
async function readDraftResponse(env: ApiEnv, id: string): Promise<Response> {
  const kv = env.DRAFTS;
  if (kv === undefined) {
    return draftError("unavailable", "drafts are unavailable", 503);
  }
  const record = await readDraft(kv, id);
  if (record === null) {
    return draftError("invalid-document", `no draft named ${id}`, 404);
  }
  return jsonResponse(
    { kind: record.kind, document: record.document, expires_at: record.expires_at },
    200,
    null,
  );
}

/** The drafts routes: POST creates, GET reads, and only those. */
async function handleDrafts(
  request: Request,
  env: ApiEnv,
  segments: string[],
): Promise<Response> {
  if (segments.length === 0) {
    return request.method === "POST"
      ? createDraftResponse(request, env)
      : draftError("invalid-path", "usage: POST /api/drafts", 400);
  }
  if (segments.length === 1) {
    return request.method === "GET"
      ? readDraftResponse(env, segments[0] ?? "")
      : draftError("invalid-path", "usage: GET /api/drafts/<id>", 400);
  }
  return draftError("invalid-path", "usage: POST /api/drafts, GET /api/drafts/<id>", 400);
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
  // Drafts are the one write surface, and they carry their own method rules;
  // every other route is read-only.
  if (route.verb === "drafts") {
    return handleDrafts(request, env, route.segments);
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
