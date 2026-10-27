// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test";

// Serves the built web app from the Workers runtime (`wrangler dev` with the
// production wrangler.toml, assets binding included) and asserts the join:
// assets on `/`, SPA fallback on `/pair`, Worker-only answers on `/auth/*`,
// and the shared security headers. Kept next to playwright.config.ts, which
// it mirrors; run via `npm run test:remote-serve`.
export default defineConfig({
  testDir: "./test",
  testMatch: "serve.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:8787",
    viewport: { width: 360, height: 640 },
    channel: "chrome",
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    // SESSION_SECRET is a Worker secret in prod; locally --var provides the
    // minimum env /auth/me needs, so it answers its real 401 (no cookie).
    command:
      "npm run build:remote-web && npx wrangler dev --config ../worker/wrangler.toml --port 8787 --var SESSION_SECRET:dev-serve-secret",
    url: "http://127.0.0.1:8787/",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
