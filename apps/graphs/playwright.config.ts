// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { defineConfig } from "@playwright/test";
// The catalogue's visual check: `wrangler dev` over the fixture Worker
// (test/e2e/worker.ts, the page tests' stub table) serving the real pages and
// the generated look kit (public/look, from `npm run build:look`). No live
// GitHub, no image baselines: the assertions read the computed surface, the
// loaded faces and the colophon, and the screenshots are attached for the
// operator's review. Run via `npm run test:graphs-visual`.
export default defineConfig({
  testDir: "./test/e2e",
  testMatch: ["visual.spec.ts", "editor.spec.ts", "patterns.spec.ts"],
  timeout: 60_000,
  fullyParallel: false,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://127.0.0.1:8790",
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    command: "npx wrangler dev --config wrangler.e2e.toml --port 8790",
    url: "http://127.0.0.1:8790/",
    cwd: path.resolve(import.meta.dirname),
    // Always start our own server. A leftover one on the port can be wedged —
    // its health check then waits without ever answering, which is how a run
    // hangs instead of failing — and even a healthy one may serve assets older
    // than this run. With this false, a busy port is a one-second EADDRINUSE.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
