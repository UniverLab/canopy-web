// SPDX-License-Identifier: Apache-2.0
/**
 * Fakes the worker tests inject instead of stubbing globals.
 *
 * FakeCache is a Map-backed CacheLike; fakeFetch answers from a route
 * table and records every URL it was asked for. Tests wire them into
 * createGitHub/createAnalytics/handleApi, never into the runtime.
 */
import { type CacheLike } from "../src/github.js";

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

  match(request: Request): Promise<Response | undefined> {
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
}

/** One stubbed upstream answer. `body` is JSON-encoded, `text` stays raw. */
export interface Stub {
  /** Matched against the full request URL: exact string or part of it. */
  url: string;
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: string[];
  /** The raw body sent with each call, in the same order as `calls`. */
  bodies: string[];
  /** Intercept paths explicitly NOT stubbed (a miss). */
  missing: string[];
}

/** Build a substitutable fetch over a route table, longest URL first. */
export function fakeFetch(stubs: Stub[]): FakeFetch {
  const ordered = [...stubs].sort((a, b) => b.url.length - a.url.length);
  const calls: string[] = [];
  const bodies: string[] = [];
  const missing: string[] = [];
  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    bodies.push(typeof init?.body === "string" ? init.body : "");
    for (const stub of ordered) {
      if (!url.includes(stub.url)) {
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

/** Standard base64 of a text, the contents-API encoding. */
export function encoded(text: string): string {
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
