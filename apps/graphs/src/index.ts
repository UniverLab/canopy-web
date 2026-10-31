// SPDX-License-Identifier: Apache-2.0
/**
 * graphs.univerlab.org — the catalogue site: pages, API and install URLs.
 *
 *   curl -fsSL https://graphs.univerlab.org/i/graph/hello-graph
 *   canopy graph install hello-graph
 *
 * Three surfaces, one Worker: `/api/*` is the JSON API (api.ts), the
 * catalogue pages (/, /search, /g, /n, /llms.txt, /publish, /patterns, /editor) are the
 * HTML/markdown renderer (pages/routes.ts), and everything else that
 * is not an install URL falls through to the redirector below, which
 * verifies the document against the scheduled index and answers with
 * either a 302 to the document on GitHub or a 400/404 explaining why
 * not. The Worker never fetches or proxies the document: GitHub stays
 * the download origin and the trust anchor, so this adds no
 * supply-chain surface beyond a redirect. There are three deliberate
 * exceptions, all of them the same live fetch-and-validate: an explicit
 * `?ref=`, a pinned ref is not in the index, so the Worker fetches that
 * ref live through the cached client and validates it before
 * redirecting; an install URL the index has no entry for, which gets
 * the same treatment at the default branch, so knowing the ref is
 * enough; and `GET /i/draft/<id>`, a draft the
 * Worker itself stored for 30 minutes (drafts.ts) that is served once
 * and deleted, because a draft has no repository to redirect to.
 *
 * A Cron Trigger also wakes the Worker every 15 minutes to rebuild the
 * index into KV (indexer.ts). Until the first run lands, data routes
 * answer 503 and ask the client to retry.
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
  type Target,
  USAGE,
  buildUrl,
  canopyVersion,
  clientClass,
  documentKey,
  indexKey,
  parseTarget,
} from "./lib.js";
import { handleAgentFiles, NOT_AGENT_FILE } from "./agent-files.js";
import { handleDiscoveryFiles, NOT_DISCOVERY } from "./agent-discovery.js";
import { handleApi, type ApiEnv } from "./api.js";
import { handlePage, NOT_PAGE } from "./pages/routes.js";
import { createGitHub, type CacheLike } from "./github.js";
import { consumeDraft } from "./drafts.js";
import { documentDirectory, loadDocument } from "./documents.js";
import { entryFor } from "./catalog.js";
import { runIndexer } from "./indexer.js";
import { createStore, type BlockedEntry } from "./store.js";
import { INDEXING_BODY } from "./pages/copy.js";
import { bundledPatterns } from "./patterns-bundled.js";
import { REVIEW_DEFAULT_CAP, runReview, type ReviewProvider } from "./review.js";
import { CLAUDE_DEFAULT_MODEL, createClaudeProvider } from "./review-claude.js";

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

/**
 * An install of a removed document: 410 and a JSON body naming the reason
 * and the issue, so `canopy graph install` can print why it will not run.
 */
function blockedResponse(blocked: BlockedEntry): Response {
  return new Response(
    `${JSON.stringify(
      { error: "blocked", reason: blocked.reason, issue: blocked.issue },
      null,
      2,
    )}\n`,
    {
      status: 410,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

/** The cold start: the index does not exist yet, back in a few minutes. */
function indexingResponse(): Response {
  return new Response(`${INDEXING_BODY}\n`, {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "120",
    },
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

/** The catalogue pages claim /, /search, /g, /n, /llms.txt, /publish, /patterns, /editor and /transparency;
 * every other path (the /i install routes above all) stays a redirect. */
function isPagePath(pathname: string): boolean {
  const first = firstSegment(pathname);
  return first === "" || first === "search" || first === "llms.txt" || first === "g" || first === "n" ||
    first === "d" || first === "publish" || first === "publish.md" || first === "patterns" ||
    first === "editor" || first === "transparency";
}

/** The injected transport and cache: production defaults, test overrides. */
export interface WorkerDeps {
  /** The upstream transport; the e2e fixtures inject a stub table. */
  fetchImpl?: typeof fetch;
  /** The Cache API stand-in; defaults to the runtime's `caches.default`. */
  cache?: CacheLike;
}

/** The scheduled event the Cron Trigger wakes the Worker with. */
export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

/** The execution context the scheduler passes; only `waitUntil` matters. */
export interface ScheduledContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Answer one request: agent files, JSON API, catalogue pages, else the redirector. */
async function answer(req: Request, env: Env, deps: WorkerDeps): Promise<Response> {
  const url = new URL(req.url);
  const apiDeps = { cache: deps.cache ?? defaultCache(), fetchImpl: deps.fetchImpl };
  // The discovery files come first, before /api: /api/openapi.json is a
  // static document here, never an API route.
  const agentFile = await handleAgentFiles(req, env);
  if (agentFile !== NOT_AGENT_FILE) {
    return agentFile;
  }
  const discoveryFile = handleDiscoveryFiles(req);
  if (discoveryFile !== NOT_DISCOVERY) {
    return discoveryFile;
  }
  if (url.pathname.startsWith("/api")) {
    const result = await handleApi(req, env, apiDeps);
    return result === true ? install(req, env, url, deps) : result;
  }
  // The catalogue pages claim /, /search, /g, /n, /llms.txt, /publish and /patterns;
  // every other path (the /i install routes above all) stays a redirect.
  if (isPagePath(url.pathname)) {
    const result = await handlePage(req, env, apiDeps);
    return result === NOT_PAGE ? install(req, env, url, deps) : result;
  }
  return install(req, env, url, deps);
}

/**
 * Build the Worker over an injected transport. Production calls it with no
 * arguments (the default export below); the visual e2e fixture seeds the
 * index through the indexer and serves it from an in-memory KV, so no
 * browser check reaches live GitHub.
 */
export function createWorker(deps: WorkerDeps = {}) {
  return {
    fetch(req: Request, env: Env): Promise<Response> {
      return answer(req, env, deps);
    },
    scheduled(event: ScheduledEvent, env: Env, ctx?: ScheduledContext): Promise<void> {
      void event;
      const kv = env.INDEX;
      if (kv === undefined) {
        return Promise.resolve();
      }
      // No Cache API on the cron path: every lookup and store is one of the
      // free plan's 50 subrequests, so the run spends them on GitHub instead.
      const github = createGitHub({
        fetchImpl: deps.fetchImpl,
        cache: null,
        token: env.GITHUB_TOKEN,
        log: () => undefined,
      });
      const run = (async (): Promise<void> => {
        await runIndexer({
          github,
          index: kv,
          authenticated: (env.GITHUB_TOKEN ?? "") !== "",
        });
        // The review pass hooks in after the index writes landed, so it
        // never blocks them; `off` (or a missing key) skips it entirely.
        try {
          const provider = await reviewProviderFromEnv(env, deps);
          const slugs = await reviewSlugs();
          await runReview({ index: kv, provider, patternSlugs: slugs, cap: reviewCap(env) });
        } catch {
          // A review failure never fails the scheduled run.
        }
      })();
      if (ctx !== undefined) {
        ctx.waitUntil(run);
      }
      return run.then(() => undefined);
    },
  };
}

export default createWorker();

/** The bundled pattern slugs the review may name; empty when unparsable. */
async function reviewSlugs(): Promise<string[]> {
  try {
    const bundled = await bundledPatterns();
    return bundled.entries.map((entry) => entry.slug);
  } catch {
    return [];
  }
}

/** The per-run scan cap from config, clamped to 1..50. */
function reviewCap(env: Env): number {
  const parsed = Number.parseInt(env.REVIEW_SCAN_CAP ?? "", 10);
  if (!Number.isInteger(parsed)) {
    return REVIEW_DEFAULT_CAP;
  }
  return Math.min(50, Math.max(1, parsed));
}

/**
 * The configured review provider, or null when the pass is off. `Muse`
 * without a key is off too: documents stay `unreviewed` with no calls.
 */
async function reviewProviderFromEnv(env: Env, deps: WorkerDeps): Promise<ReviewProvider | null> {
  if ((env.REVIEW_PROVIDER ?? "off").toLowerCase() !== "claude") {
    return null;
  }
  const apiKey = env.CLAUDE_API_KEY ?? "";
  if (apiKey === "") {
    return null;
  }
  const model = env.REVIEW_MODEL ?? CLAUDE_DEFAULT_MODEL;
  return createClaudeProvider({
    apiKey,
    model: model === "" ? CLAUDE_DEFAULT_MODEL : model,
    patternSlugs: await reviewSlugs(),
    fetchImpl: deps.fetchImpl,
  });
}

/**
 * The live fetch behind both live installs: one document ref through the
 * cached GitHub client, validated exactly as the `?ref=` path validates,
 * then a 302 to the document on GitHub. `ref` names what GitHub is asked
 * to read — "" for the default branch, else the branch, tag or commit;
 * `Target.ref`, always non-empty (`HEAD` when the request pinned nothing),
 * is what the redirect URL carries — for the unpinned fallback "" is
 * fetched and `HEAD` redirected, the pair meaning the same thing. Nothing
 * redirects without validation: a load that dropped answers 404 with a
 * one-line reason ("at ref <ref>" only when pinned), and a typed GitHub
 * error keeps its shape — 429 on the rate limit, 502 unreachable.
 */
async function installLive(
  req: Request,
  env: Env,
  deps: WorkerDeps,
  target: Target,
  ref: string,
): Promise<Response> {
  const github = createGitHub({
    fetchImpl: deps.fetchImpl,
    cache: deps.cache ?? defaultCache(),
    token: env.GITHUB_TOKEN,
    log: () => undefined,
  });
  const loaded = await loadDocument(
    github,
    {
      owner: target.owner,
      repo: target.repo,
      directory: documentDirectory(target.kind, target.slug),
      kind: target.kind,
      slug: target.slug,
      stars: null,
      // "" reads the default branch; the pinned ref is exactly what was sent.
      ref,
    },
    () => undefined,
  );
  if (loaded.kind === "doc") {
    record(env, req, target, "redirect");
    return Response.redirect(buildUrl(target), 302);
  }
  record(env, req, target, "bad-request");
  if (loaded.kind !== "absent") {
    if (loaded.kind === "rate-limit") {
      const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
      if (loaded.retryAfter !== undefined) {
        headers["retry-after"] = String(loaded.retryAfter);
      }
      return new Response("GitHub rate limit reached; try again in a moment.\n", {
        status: 429,
        headers,
      });
    }
    return textResponse("GitHub is unreachable right now; try again in a moment.\n", 502);
  }
  // The unpinned fallback keeps the index-miss wording (no ref to name);
  // a pinned miss says which ref it read.
  const atRef = ref === "" ? "" : ` at ref ${ref}`;
  return textResponse(
    `no ${target.kind} named ${target.slug} in ${target.owner}/${target.repo}${atRef}\n`,
    404,
  );
}

/** An explicit `?ref=`: fetch that ref live, validate it, redirect to it. */
async function installAtRef(
  req: Request,
  env: Env,
  deps: WorkerDeps,
  parsed: Extract<ReturnType<typeof parseTarget>, { ok: true }>,
): Promise<Response> {
  return installLive(req, env, deps, parsed.target, parsed.target.ref);
}

/**
 * The countable parts of a draft install. A draft has no owner, repository or
 * slug, so it uses the same `?` placeholders a rejected request carries; the
 * kind is the one fact the analytics needs: `draft`.
 */
function draftParts(id: string): Parts {
  return { kind: "draft", owner: "?", repo: "?", slug: id };
}

/**
 * `/i/draft/<id>`: the one-use download. Claimed at the top of `install()`
 * because `parseTarget` would read `draft` as a kind and answer 400. The
 * draft is read, deleted (best effort — KV deletes are eventually
 * consistent) and answered as the document JSON, `no-store`.
 */
async function installDraft(req: Request, env: Env, url: URL): Promise<Response | null> {
  const segments = url.pathname.replace(/^\/+/, "").split("/");
  if (segments[0] !== "i" || segments[1] !== "draft") {
    return null;
  }
  const id = segments.length === 3 ? segments[2] ?? "" : "";
  const kv = env.DRAFTS;
  if (kv === undefined) {
    return textResponse("drafts are unavailable\n", 503);
  }
  if (segments.length !== 3) {
    return textResponse("no draft; a draft lasts 30 minutes or one install\n", 404);
  }
  const draft = await consumeDraft(kv, id);
  if (draft === null) {
    record(env, req, draftParts(id), "bad-request");
    return textResponse(`no draft named ${id}; a draft lasts 30 minutes or one install\n`, 404);
  }
  record(env, req, draftParts(id), "redirect");
  return new Response(`${JSON.stringify(draft.document, null, 2)}\n`, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * The install redirector: the index verifies the document exists, then a
 * 302 to the document on GitHub, or a 400/404 explaining why not. An
 * explicit `?ref=` is not in the index, so it is fetched live instead;
 * an install the index has no entry for gets the same live treatment —
 * the 404 the index-miss wording keeps is only for what GitHub does
 * not list either.
 */
async function install(req: Request, env: Env, url: URL, deps: WorkerDeps): Promise<Response> {
  const draft = await installDraft(req, env, url);
  if (draft !== null) {
    return draft;
  }
  const parsed = parseTarget(url.pathname, url.searchParams.get("ref"));

  if (!parsed.ok) {
    record(env, req, parsed.rejection, "bad-request");
    // Only the bare /i/ gets the full usage text; every other rejection
    // — a malformed install's 400, an unknown path's 404 — carries its
    // one-line reason.
    const body = parsed.rejection.reason === "no install target" ? `${USAGE}\n` : `${parsed.rejection.reason}\n`;
    return textResponse(body, parsed.rejection.status);
  }

  const target = parsed.target;
  const store = createStore(env.INDEX);
  // Before the index and before a pinned ref is fetched: a removed
  // document stays removed, whatever the last run left behind.
  const blocked = await store.getBlocked(target.kind, target.owner, target.repo, target.slug);
  if (blocked !== null) {
    record(env, req, target, "bad-request");
    return blockedResponse(blocked);
  }

  if (url.searchParams.has("ref")) {
    return installAtRef(req, env, deps, parsed);
  }

  const index = await store.getIndex();
  if (index === null) {
    record(env, req, target, "bad-request");
    return indexingResponse();
  }
  const entry = entryFor(index, target.kind, target.owner, target.repo, target.slug);
  const stored = entry === null
    ? null
    : await store.getDoc(target.kind, target.owner, target.repo, target.slug);
  if (entry === null || stored === null) {
    // No index entry is not proof the document is gone: the unindexed
    // fallback asks GitHub the same way a `?ref=` install does, reading
    // the default branch. A validated document redirects; a fetch or
    // validation miss keeps the very wording the index-miss path had
    // (nothing pinned, so no "at ref" suffix), so callers that already
    // treat a miss as a miss keep doing exactly that.
    return installLive(req, env, deps, target, "");
  }

  record(env, req, target, "redirect");
  return Response.redirect(buildUrl(target), 302);
}
