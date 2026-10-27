// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "smoke.spec.ts",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5199",
    viewport: { width: 360, height: 640 },
    channel: "chrome",
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  webServer: {
    command: "npx vite --config ./vite.config.ts --port 5199 --strictPort",
    url: "http://127.0.0.1:5199/fake.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
