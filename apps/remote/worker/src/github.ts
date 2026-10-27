// SPDX-License-Identifier: Apache-2.0
/**
 * The relay's only two GitHub calls: exchanging an OAuth code and proving
 * a host bearer token belongs to a GitHub user. Host verifications are
 * cached per isolate, keyed by the token's SHA-256 — the token itself is
 * never stored.
 */
import { HOST_CACHE_TTL_S } from "./protocol.js";

/** A GitHub user, as far as the relay cares. */
export interface GitHubUser {
  id: number;
  login: string;
}

/** The OAuth app credentials the code exchange needs. */
export interface GitHubOAuthEnv {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

interface CacheEntry {
  user: GitHubUser;
  expiresAt: number;
}

/** Verified host tokens, keyed by SHA-256 hex of the token. Isolate memory only. */
const hostCache = new Map<string, CacheEntry>();

/** Test-only: drop every cached verification. */
export function __clearHostCache(): void {
  hostCache.clear();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Exchange an OAuth code for a token, or null when GitHub refuses. */
export async function exchangeCode(
  code: string,
  env: GitHubOAuthEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  const token = (parsed as Record<string, unknown>)?.["access_token"];
  return typeof token === "string" && token !== "" ? token : null;
}

/** Who a GitHub token belongs to, or null on any non-200. */
export async function fetchUser(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubUser | null> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "canopy-remote",
      },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record?.["id"] !== "number" || typeof record?.["login"] !== "string") {
    return null;
  }
  return { id: record["id"] as number, login: record["login"] as string };
}

/**
 * Verify a host bearer token, caching the answer 5 minutes by SHA-256 of
 * the token. Failures are never cached.
 */
export async function verifyHostToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubUser | null> {
  const key = await sha256Hex(token);
  const now = Date.now();
  const cached = hostCache.get(key);
  if (cached !== undefined && cached.expiresAt > now) {
    return cached.user;
  }
  if (cached !== undefined) {
    hostCache.delete(key);
  }
  const user = await fetchUser(token, fetchImpl);
  if (user === null) {
    return null;
  }
  if (hostCache.size > 1000) {
    for (const [entryKey, entry] of hostCache) {
      if (entry.expiresAt <= now) {
        hostCache.delete(entryKey);
      }
    }
  }
  hostCache.set(key, { user, expiresAt: now + HOST_CACHE_TTL_S * 1000 });
  return user;
}
