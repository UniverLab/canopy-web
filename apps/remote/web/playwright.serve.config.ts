// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test";

// Serves the built web app from the Workers runtime (`wrangler dev` with the
// production wrangler.toml, assets binding included) and asserts the join:
// the Worker on `/` (Link header, markdown negotiation), SPA fallback on
// `/pair`, Worker-only answers on `/auth/*`, and the shared security
// headers. Kept next to playwright.config.ts, which it mirrors; run via
// `npm run test:remote-serve`.
export default defineConfig({
  testDir: "./test",
  testMatch: ["serve.spec.ts", "turn.spec.ts"],
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:8787",
    viewport: { width: 360, height: 640 },
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    // SESSION_SECRET is a Worker secret in prod; locally --var provides the
    // minimum env /auth/me needs, so it answers its real 401 (no cookie).
    // TURN_KEY_ID and TURN_KEY_API_TOKEN carry /turn past its misconfigured
    // guard (the turn.spec.ts room holds no host, so the fake keys are never
    // dialed). ALLOWED_ORIGINS names the serve origin, so the browser's
    // Origin on /ws/device upgrades passes like production's does — and
    // --infer-origin-from-routes=false keeps it that way: by default
    // wrangler rewrites an Origin matching the dev server to the route
    // origin (http://remote.univerlab.org), failing the allowlist.
    // build:look first: the app links /look/tokens.css and the generated
    // public/look is gitignored, so without it the serve run would test a
    // bare unstyled build (and still pass).
    command:
      "npm run build:look && npm run build:remote-web && npx wrangler dev --config ../worker/wrangler.toml --port 8787 --infer-origin-from-routes=false --var SESSION_SECRET:dev-serve-secret --var TURN_KEY_ID:e2e-turn-key --var TURN_KEY_API_TOKEN:e2e-turn-token --var ALLOWED_ORIGINS:http://127.0.0.1:8787",
    url: "http://127.0.0.1:8787/",
    // Own server only: see apps/graphs/playwright.config.ts — a reused server
    // can be wedged (the health check never answers) or out of date.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
