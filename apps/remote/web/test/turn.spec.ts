// SPDX-License-Identifier: Apache-2.0
import { createHmac, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

// Regression test for R1 (2026-11-01 audit, scenario 02a): no real browser
// could connect, because GET /turn rejected requests without an Origin
// header — which browsers never send on a same-origin GET. The worker must
// accept the proven same-origin browser fetch (Sec-Fetch-Site) and the
// session must open past /turn with zero forbidden_origin.
//
// Runs under playwright.serve.config.ts: the built app served from the real
// Worker (`wrangler dev`), driven in real Chromium. A signed session cookie
// stands in for the GitHub login; no host is online, so past the origin
// gate /turn answers no_host — that answer IS the proof the gate passed,
// since before the fix the same fetch answered forbidden_origin.

/** Must match the --var SESSION_SECRET in playwright.serve.config.ts. */
const SESSION_SECRET = "dev-serve-secret";
const UID = 1234567;
const LOGIN = "e2e-octocat";

/** Mint a cr_session cookie the Worker verifies, like signSession does. */
function mintSession(uid: number, login: string): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ uid, login, exp: nowSec + 43200, jti: randomBytes(16).toString("base64url") }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(payload).digest().toString("base64url");
  return `${payload}.${signature}`;
}

test("a real browser connects past /turn with no forbidden_origin", async ({ page, context }) => {
  // A real session carries both cookies: cr_session plus the readable
  // cr_hint=1 the worker sets beside it (the app's only readable signal).
  // By domain, never by URL: cookies ignore the port, and the serve
  // suite's port spreads per checkout and per process (see
  // scripts/e2e-port.mjs), so no spec may name it.
  await context.addCookies([
    { name: "cr_session", value: mintSession(UID, LOGIN), domain: "127.0.0.1", path: "/" },
    { name: "cr_hint", value: "1", domain: "127.0.0.1", path: "/" },
  ]);

  const turnBodies: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/turn") {
      return;
    }
    response.text().then(
      (body) => {
        turnBodies.push(body);
      },
      () => undefined,
    );
  });

  // Authenticated past the sign-in screen: a fresh profile holds no paired
  // hosts, so the app lands on the pair view.
  await page.goto("/");
  await expect(page.locator("#pair-form")).toBeVisible();

  const me = await page.evaluate(async (): Promise<{ status: number; body: unknown }> => {
    const res = await fetch("/auth/me");
    return { status: res.status, body: (await res.json()) as unknown };
  });
  expect(me.status).toBe(200);
  expect(me.body).toEqual({ login: LOGIN });

  // The audit's 02a fetch from the real browser: a same-origin GET sends no
  // Origin, but Sec-Fetch-Site: same-origin. No host is online, so no_host
  // proves the origin gate passed — pre-fix this was forbidden_origin.
  const turn = await page.evaluate(async (): Promise<{ status: number; body: unknown }> => {
    const res = await fetch("/turn");
    return { status: res.status, body: (await res.json()) as unknown };
  });
  expect(turn).toEqual({ status: 403, body: { error: "no_host" } });

  // The relay session opens over the same origin.
  const relayOpened = await page.evaluate(
    (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(`ws://${globalThis.location.host}/ws/device`);
        const done = (ok: boolean): void => {
          try {
            ws.close(1000);
          } catch {
            // Already closed.
          }
          resolve(ok);
        };
        ws.onopen = () => done(true);
        ws.onerror = () => done(false);
        globalThis.setTimeout(() => done(false), 10_000);
      }),
  );
  expect(relayOpened).toBe(true);

  await expect.poll(() => turnBodies.length, { timeout: 5_000 }).toBeGreaterThan(0);
  for (const body of turnBodies) {
    expect(body).not.toContain("forbidden_origin");
  }
});

test("raw /turn without fetch metadata stays rejected", async ({ request }) => {
  const response = await request.get("/turn", {
    headers: { cookie: `cr_session=${mintSession(UID, LOGIN)}` },
  });
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: "forbidden_origin" });
});
