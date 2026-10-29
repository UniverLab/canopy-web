// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: ["smoke.spec.ts", "graphs.spec.ts", "editor.spec.ts", "signout.spec.ts"],
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5199",
    viewport: { width: 360, height: 640 },
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    // build:look first: public/look is generated and gitignored, and the
    // smoke page wears the kit (tokens, fonts, colophon, honeycomb).
    command:
      "npm run build:look && npx vite --config ./vite.config.ts --port 5199 --strictPort",
    url: "http://127.0.0.1:5199/fake.html",
    // Own server only: see apps/graphs/playwright.config.ts — a reused server
    // can be wedged (the health check never answers) or out of date.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
