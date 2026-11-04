// SPDX-License-Identifier: Apache-2.0
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["apps/graphs/test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Single-file Worker: the pool loads this config, so tests speak to
        // the same code and bindings `wrangler deploy` will ship. It is the
        // production file minus [assets] — the pool serves no static folder.
        wrangler: { configPath: "./wrangler.test.toml" },
      },
    },
  },
});
