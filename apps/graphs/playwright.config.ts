// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { e2ePort } from "../../scripts/e2e-port.mjs";
// The catalogue's visual check: `wrangler dev` over the fixture Worker
// (test/e2e/worker.ts, the page tests' stub table) serving the real pages and
// the generated look kit (public/look, from `npm run build:look`). No live
// GitHub, no image baselines: the assertions read the computed surface, the
// loaded faces and the colophon, and the screenshots are attached for the
// operator's review. Run via `npm run test:graphs-visual`.
//
// The port spreads per checkout and per process (see scripts/e2e-port.mjs):
// sibling checkouts run this suite on the same machine at the same time,
// and one fixed value failed the second concurrent run with "already
// used". The base sits one window above the serve suite's, so the two
// wrangler suites never land on each other's port. The specs only use
// relative URLs off baseURL.
const port = e2ePort(9300, import.meta.dirname, "E2E_PORT_GRAPHS");

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: ["visual.spec.ts", "editor.spec.ts", "patterns.spec.ts", "performance.spec.ts", "plate.spec.ts"],
  timeout: 60_000,
  fullyParallel: false,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    command: `npx wrangler dev --config wrangler.e2e.toml --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    cwd: path.resolve(import.meta.dirname),
    // Always start our own server. A leftover one on the port can be wedged —
    // its health check then waits without ever answering, which is how a run
    // hangs instead of failing — and even a healthy one may serve assets older
    // than this run. With this false, a busy port is a one-second EADDRINUSE.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
