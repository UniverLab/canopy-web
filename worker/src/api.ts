// SPDX-License-Identifier: Apache-2.0
/**
 * The JSON API for graphs.univerlab.org: the contract the pages and
 * third-party agents consume.
 *
 *   GET /api/official                        -> { graphs, nodes }
 *   GET /api/search?q=&sort=top|new&page=    -> { items, q, sort, page, total, truncated }
 *   GET /api/g/<owner>/<repo>/<slug>         -> one graph document
 *   GET /api/n/<owner>/<repo>/<slug>         -> one node document
 *
 * Every answer is CORS-open for GET, every error is a typed JSON body
 * (never an HTML stack trace, never a 500 the pages cannot show). `index.ts`
 * hands `/api/*` here first; the install redirector keeps its routes.
 */
import { attachDownloads, createAnalytics } from "./analytics.js";
import { createGitHub, isApiError, type ApiError, type CacheLike, type GitHub, type Log } from "./github.js";
import { SLUG_RE, OWNER_RE, REPO_RE, isOfficialRepo } from "./lib.js";
import { documentDirectory, loadDocument } from "./documents.js";
import { listOfficial, loadOfficialDocument } from "./official.js";
import { searchCommunity, type SearchSort } from "./search.js";

/** Environment the API reads: three optional values, no bindings here. */
export interface ApiEnv {
  GITHUB_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
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

function errorResponse(error: ApiError): Response {
  return jsonResponse(
    { kind: error.kind, message: error.message, status: error.status, retryAfter: error.retryAfter ?? undefined },
    error.status,
    60,
  );
}

/** A non-API request: index.ts keeps routing it to the redirector. */
export const NOT_API = true as const;

function badQuery(message: string): ApiError {
  return { kind: "invalid-query", message, status: 400 };
}

function invalidPath(message: string): ApiError {
  return { kind: "invalid-path", message, status: 400 };
}

/** Read `q`, `sort` and `page` out of a search request, 400s when malformed. */
function readSearchInput(url: URL): { input: { q: string; sort: SearchSort; page: number } } | ApiError {
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

async function singleDocument(
  github: GitHub,
  owner: string,
  repo: string,
  slug: string,
  log: Log,
): Promise<Response> {
  if (isOfficialRepo(owner, repo)) {
    const loaded = await loadOfficialDocument(github, slug, log);
    if (loaded.kind === "doc") {
      return jsonResponse(loaded.entry, 200, 300);
    }
    if (loaded.kind === "absent") {
      return errorResponse({
        kind: "invalid-document",
        message: `no official graph or node named ${slug}`,
        status: 404,
      });
    }
    return errorResponse(loaded);
  }
  for (const kind of ["graph", "node"] as const) {
    const source = {
      owner,
      repo,
      directory: documentDirectory(owner, repo, kind, slug),
      kind,
      slug,
      stars: null,
    };
    const loaded = await loadDocument(github, source, log);
    if (loaded.kind === "doc") {
      return jsonResponse(loaded.entry, 200, 300);
    }
    if (loaded.kind !== "absent") {
      return errorResponse(loaded);
    }
  }
  return errorResponse({
    kind: "invalid-document",
    message: `no graph or node named ${slug} in ${owner}/${repo}`,
    status: 404,
  });
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

  const github = createGitHub({
    fetchImpl: deps.fetchImpl,
    cache: deps.cache,
    token: env.GITHUB_TOKEN,
    log,
  });

  switch (route.verb) {

    case "official": {
      if (route.segments.length !== 0) {
        return errorResponse(invalidPath("usage: GET /api/official"));
      }
      const listing = await listOfficial(github, log);
      if (isApiError(listing)) {
        return errorResponse(listing);
      }
      const volumes = await createAnalytics({
        fetchImpl: deps.fetchImpl,
        cache: deps.cache,
        accountId: env.CF_ACCOUNT_ID,
        token: env.CF_ANALYTICS_TOKEN,
        log,
      }).volume();
      return jsonResponse(
        {
          graphs: attachDownloads(listing.graphs, volumes),
          nodes: attachDownloads(listing.nodes, volumes),
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
      const outcome = await searchCommunity(github, parsed.input, log);
      if (isApiError(outcome)) {
        return errorResponse(outcome);
      }
      const volumes = await createAnalytics({
        fetchImpl: deps.fetchImpl,
        cache: deps.cache,
        accountId: env.CF_ACCOUNT_ID,
        token: env.CF_ANALYTICS_TOKEN,
        log,
      }).volume();
      return jsonResponse(
        { ...outcome, items: attachDownloads(outcome.items, volumes) },
        200,
        60,
      );
    }
    case "g":
    case "n": {
      if (route.segments.length !== 3) {
        return errorResponse(invalidPath(`usage: GET /api/${route.verb}/<owner>/<repo>/<slug>`));
      }
      const [owner, repo, slug] = route.segments;
      const invalid = partsInvalid(owner, repo, slug);
      if (invalid !== null) {
        return errorResponse(invalidPath(invalid));
      }
      return singleDocument(github, owner, repo, slug, log);
    }
    default:
      return errorResponse(invalidPath("unknown API route"));
  }
}

