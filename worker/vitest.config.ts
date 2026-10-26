// SPDX-License-Identifier: Apache-2.0
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["worker/test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Single-file Worker: the pool loads this config, so tests speak to
        // the same code and bindings `wrangler deploy` will ship.
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
