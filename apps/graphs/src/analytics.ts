// SPDX-License-Identifier: Apache-2.0
/**
 * Install counts from Cloudflare's Analytics Engine for the catalogue.
 *
 * The install redirector writes one aggregate data point per install; this
 * module reads them back with the Analytics Engine SQL API and returns a
 * map of `owner/repo/kind/slug` to the 90-day count. Without
 * `CF_ACCOUNT_ID` and `CF_ANALYTICS_TOKEN` there is simply no data: the
 * map is null and documents carry no `downloads` field, never a zero. The
 * SQL call is a POST, but its result is cached under a synthetic GET key
 * for 60 minutes like every other upstream answer.
 */
import { TTL, type Log, type CacheLike } from "./github.js";
import type { Doc } from "./documents.js";
import { isNumber, isRecord, isString } from "./json.js";

/** How far back install counts reach. */
export const DOWNLOAD_WINDOW_DAYS = 90;

/** The synthetic GET key the SQL result is cached under. */
export const ANALYTICS_CACHE_URL =
  "https://canopy-graphs.analytics.internal/install-counts-90d";

export interface AnalyticsOptions {
  fetchImpl?: typeof fetch;
  cache?: CacheLike;
  accountId?: string;
  token?: string;
  log?: Log;
}

export type Downloads = Map<string, number>;

export interface AnalyticsVolume {
  /** The 90-day install counts, or null when analytics is not configured. */
  volume(): Promise<Downloads | null>;
}

interface Rows {
  data?: unknown;
  result?: unknown;
}

/** Parse whatever rows shape the SQL API handed back into key/count pairs. */
function rowsOf(body: unknown): Array<{ key: string; count: number }> {
  const rows: unknown[] = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray((body as Rows).data)
      ? ((body as Rows).data as unknown[])
      : isRecord(body) && Array.isArray((body as Rows).result)
        ? ((body as Rows).result as unknown[])
        : [];
  return rows.flatMap((row) => {
    if (!isRecord(row)) {
      return [];
    }
    const key = row["index"] ?? row["k"] ?? row["_index"];
    const count = row["count"] ?? row["n"] ?? row["_sample_interval_sum"];
    if (!isString(key) || !isNumber(count) || !Number.isFinite(count)) {
      return [];
    }
    return [{ key, count }];
  });
}

const QUERY =
  `SELECT index1 AS index, SUM(_sample_interval) AS count ` +
  `FROM canopy_graph_installs ` +
  `WHERE timestamp > NOW() - INTERVAL '${DOWNLOAD_WINDOW_DAYS}' DAY GROUP BY index1 ORDER BY count DESC`;

/** Build the collector. Always returns a handle; config decides if it has data. */
export function createAnalytics(options: AnalyticsOptions): AnalyticsVolume {
  const log: Log = options.log ?? (() => undefined);
  const configured =
    options.accountId !== undefined && options.accountId !== "" &&
    options.token !== undefined && options.token !== "";

  async function volume(): Promise<Downloads | null> {
    if (!configured) {
      return null;
    }
    const cache: CacheLike | undefined = options.cache ?? maybeDefaultCache();
    const request = new Request(ANALYTICS_CACHE_URL, { method: "GET" });
    if (cache !== undefined) {
      try {
        const cached = await cache.match(request);
        if (cached !== undefined) {
          const pairs = volumesFromCacheBody(await cached.json() as unknown);
          if (pairs !== null) {
            return pairs;
          }
          log("analytics: unreadable cache entry, refreshing");
        }
      } catch {
        // an unreadable cache falls through to the SQL call
      }
    }

    const map = await sqlVolume(options, log);
    if (map === null) {
      return null;
    }
    if (cache !== undefined) {
      try {
        const stored = new Response(JSON.stringify(Array.from(map.entries())), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${TTL.analytics}`,
          },
        });
        await cache.put(request, stored);
      } catch {
        // caching is an optimisation, never the answer
      }
    }
    return map;
  }

  return { volume };
}

/** The one SQL call, POSTed to the Analytics Engine SQL API. */
async function sqlVolume(
  options: AnalyticsOptions,
  log: Log,
): Promise<Downloads | null> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${options.token}`,
          "content-type": "text/plain",
        },
        body: QUERY,
      },
    );
  } catch (error) {
    log(`analytics: sql call failed: ${String(error)}`);
    return null;
  }
  if (!response.ok) {
    log(`analytics: sql answered ${response.status}`);
    return null;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    log("analytics: sql answered unreadable json");
    return null;
  }
  return mapOf(body);
}

/** `caches.default` when the runtime has one, undefined otherwise. */
function maybeDefaultCache(): CacheLike | undefined {
  const runtime = globalThis as unknown as { caches?: { default?: CacheLike } };
  return runtime.caches?.default;
}

function mapOf(body: unknown): Downloads {
  const map = new Map<string, number>();
  for (const { key, count } of rowsOf(body)) {
    map.set(key, count);
  }
  return map;
}

/** The key one install was indexed under: `owner/repo/kind/slug`. */
export function downloadKey(doc: Doc): string {
  return `${doc.repo}/${doc.kind}/${doc.slug}`;
}

/**
 * Attach 90-day install counts to documents. Absent analytics (or a
 * document nobody installed) leave `downloads` off the document entirely;
 * counts are never zero-filled.
 */
export function attachDownloads(docs: Doc[], volumes: Downloads | null): Doc[] {
  if (volumes === null) {
    return docs;
  }
  return docs.map((doc) => {
    const downloads = volumes.get(downloadKey(doc));
    if (downloads === undefined) {
      return doc;
    }
    return { ...doc, downloads };
  });
}

/**
 * Read the cached volumes back: the collector stores a JSON array of
 * `[key, count]` pairs, so a cache hit round-trips without a SQL call.
 */
export function volumesFromCacheBody(value: unknown): Downloads | null {
  if (!Array.isArray(value)) {
    return null;
  }
  let ok = true;
  const map = new Map<string, number>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isString(entry[0]) || !isNumber(entry[1])) {
      ok = false;
      continue;
    }
    map.set(entry[0], entry[1]);
  }
  if (!ok) {
    return null;
  }
  return map;
}
