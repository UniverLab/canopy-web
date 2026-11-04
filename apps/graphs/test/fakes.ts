// SPDX-License-Identifier: Apache-2.0
/**
 * Fakes the worker tests inject instead of stubbing globals.
 *
 * FakeCache is a Map-backed CacheLike; fakeFetch answers from a route
 * table and records every URL it was asked for. Tests wire them into
 * createGitHub/createAnalytics/handleApi, never into the runtime.
 * SubrequestMeter is the Workers Free plan's subrequest limit: it counts
 * every fetch and every cache operation and throws on the 51st.
 */
import { type CacheLike } from "../src/github.js";
import { type KV } from "../src/store.js";

/** How many subrequests one Workers Free plan invocation may spend. */
export const SUBREQUEST_LIMIT = 50;

/**
 * Counts outbound subrequests the way the runtime does — fetches and Cache
 * API operations alike — and throws past the free plan's 50, with the message
 * the real runtime uses. A run that trips it is a run the plan would refuse.
 */
export class SubrequestMeter {
  fetches = 0;
  cacheOps = 0;
  readonly limit: number;

  constructor(limit: number = SUBREQUEST_LIMIT) {
    this.limit = limit;
  }

  /** Every outbound call the run has made so far. */
  get total(): number {
    return this.fetches + this.cacheOps;
  }

  /** Count one call, or refuse it once the plan's limit is spent. */
  spend(kind: "fetch" | "cache"): void {
    if (this.total >= this.limit) {
      throw new Error("Too many subrequests");
    }
    if (kind === "fetch") {
      this.fetches += 1;
    } else {
      this.cacheOps += 1;
    }
  }
}

interface Stored {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** A Map-backed cache that counts what it served and stored. */
export class FakeCache implements CacheLike {
  private entries = new Map<string, Stored>();
  misses = 0;
  puts = 0;
  private readonly meter?: SubrequestMeter;

  constructor(meter?: SubrequestMeter) {
    this.meter = meter;
  }

  match(request: Request): Promise<Response | undefined> {
    this.meter?.spend("cache");
    const found = this.entries.get(request.url);
    if (found === undefined) {
      this.misses += 1;
      return Promise.resolve(undefined);
    }
    // The real Cache API hands out a fresh copy per match; so does the fake.
    return Promise.resolve(
      new Response(found.text, {
        status: found.status,
        headers: new Headers(found.headers),
      }),
    );
  }

  async put(request: Request, response: Response): Promise<void> {
    this.meter?.spend("cache");
    this.puts += 1;
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const text = await response.clone().text();
    this.entries.set(request.url, { status: response.status, headers, text });
  }

  /** True when a URL is stored (a warm entry, even after it "expires"). */
  has(url: string): boolean {
    return this.entries.has(url);
  }

  /** Every cache operation made, match and put alike. */
  get ops(): number {
    return this.misses + this.puts;
  }
}

/** One stubbed upstream answer. `body` is JSON-encoded, `text` stays raw. */
export interface Stub {
  /** Matched against the full request URL: exact string or part of it. */
  url: string;
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /**
   * Only match when the request body carries this text. Two GraphQL calls
   * share one URL, so a stub per repository narrows on its owner.
   */
  bodyIncludes?: string;
}

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: string[];
  /** The raw body sent with each call, in the same order as `calls`. */
  bodies: string[];
  /** Intercept paths explicitly NOT stubbed (a miss). */
  missing: string[];
}

/** The body a call carried, whether it was passed as a Request or as init. */
async function bodyOf(input: URL | Request | string, init?: RequestInit): Promise<string> {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (input instanceof Request && input.method !== "GET" && input.method !== "HEAD") {
    try {
      return await input.clone().text();
    } catch {
      return "";
    }
  }
  return "";
}

/** Build a substitutable fetch over a route table, longest URL first. */
export function fakeFetch(stubs: Stub[]): FakeFetch {
  const ordered = [...stubs].sort((a, b) => b.url.length - a.url.length);
  const calls: string[] = [];
  const bodies: string[] = [];
  const missing: string[] = [];
  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const sent = await bodyOf(input, init);
    calls.push(url);
    bodies.push(sent);
    for (const stub of ordered) {
      if (!url.includes(stub.url)) {
        continue;
      }
      if (stub.bodyIncludes !== undefined && !sent.includes(stub.bodyIncludes)) {
        continue;
      }
      const headers = new Headers({ "content-type": "application/json", ...stub.headers });
      // `text` is a raw body (HTML, empty); `body` is JSON-encoded; absent both is "".
      const payload = stub.text ?? (stub.body === undefined ? "" : JSON.stringify(stub.body));
      return new Response(payload, {
        status: stub.status,
        headers,
      });
    }
    missing.push(url);
    return new Response("{}", { status: 404, headers: new Headers() });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, bodies, missing };
}

/** The fake fetch, counting each call against the free plan's meter. */
export function meteredFetch(fake: FakeFetch, meter: SubrequestMeter): typeof fetch {
  return (async (input: URL | Request | string, init?: RequestInit) => {
    meter.spend("fetch");
    return fake.fetchImpl(input, init);
  }) as typeof fetch;
}

/** A Map-backed KV namespace: the index binding the tests seed. */
export class FakeKV implements KV {
  private entries = new Map<string, string>();

  /** Every `put` the code made, with the TTL it asked for. */
  putOptions: Array<{ key: string; expirationTtl?: number }> = [];

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.entries.set(key, value);
    this.putOptions.push(
      options?.expirationTtl === undefined
        ? { key }
        : { key, expirationTtl: options.expirationTtl },
    );
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    const after = options?.cursor ?? "";
    const names = [...this.entries.keys()]
      .filter((name) => name.startsWith(prefix) && (after === "" || name > after))
      .sort();
    return Promise.resolve({ keys: names.map((name) => ({ name })), list_complete: true });
  }

  /** True when a key is stored. */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Every stored key, for vanished-key assertions. */
  storedKeys(): string[] {
    return [...this.entries.keys()].sort();
  }
}

/**
 * A rate-limiting binding stand-in: the same `{ success }` answer the
 * Workers binding gives, and every key it was asked about. `allowed` is how
 * many calls succeed; the rest are refused, which is the 429 path.
 */
export class FakeRateLimit {
  readonly keys: string[] = [];
  private remaining: number;

  constructor(allowed: number = Number.POSITIVE_INFINITY) {
    this.remaining = allowed;
  }

  limit(options: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(options.key);
    const success = this.remaining > 0;
    if (success) {
      this.remaining -= 1;
    }
    return Promise.resolve({ success });
  }
}

/** Standard base64 of a text, the contents-API encoding. */export function encoded(text: string): string {
  return btoa(text);
}

/** A contents-API file body carrying the text inline. */
export function fileBody(path: string, text: string): Record<string, unknown> {
  return {
    name: path.split("/").pop(),
    path,
    type: "file",
    size: text.length,
    content: encoded(text),
    encoding: "base64",
  };
}

/** A contents-API directory body holding these file names. */
export function dirBody(entries: Array<{ name: string; type: string }>): unknown[] {
  return entries.map((entry) => ({
    name: entry.name,
    path: entry.name,
    type: entry.type,
    size: 0,
  }));
}
