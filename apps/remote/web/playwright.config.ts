// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test";
import { e2ePort } from "../../../scripts/e2e-port.mjs";

// Sibling checkouts run this suite on the same machine at the same time,
// so the server port spreads per checkout and per process (see
// scripts/e2e-port.mjs) instead of pinning one fixed value, which failed
// the second concurrent run with "already used". The specs only use
// relative URLs off baseURL, plus baseURL itself in csp.spec.ts.
const port = e2ePort(5199, import.meta.dirname, "E2E_PORT_SMOKE");

export default defineConfig({
  testDir: "./test",
  testMatch: ["smoke.spec.ts", "terminal-symbols.spec.ts", "terminal-autofit.spec.ts", "terminal-alt-screen.spec.ts", "terminal-dpr1.spec.ts", "terminal-touch-scroll.spec.ts", "graphs.spec.ts", "editor.spec.ts", "signout.spec.ts", "csp.spec.ts", "metrics.spec.ts", "guest.spec.ts", "footer.spec.ts", "fondo.spec.ts", "touch-targets.spec.ts", "account-chip.spec.ts", "upload.spec.ts", "control-size.spec.ts", "schedule.spec.ts", "latch-keyboard.spec.ts", "keyboard-viewport.spec.ts", "copy.spec.ts", "long-snapshot.spec.ts", "session-close.spec.ts", "resume.spec.ts"],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 360, height: 640 },
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    // build:look first: public/look is generated and gitignored, and the
    // smoke page wears the kit (tokens, fonts, colophon, honeycomb).
    command:
      `npm run build:look && npx vite --config ./vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/fake.html`,
    // Own server only: see apps/graphs/playwright.config.ts — a reused server
    // can be wedged (the health check never answers) or out of date.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
