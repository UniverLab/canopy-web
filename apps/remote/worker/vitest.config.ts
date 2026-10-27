// SPDX-License-Identifier: Apache-2.0
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["apps/remote/worker/test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Single-file Worker: the pool loads this config, so tests speak to
        // the same code and bindings `wrangler deploy` will ship.
        wrangler: { configPath: "./wrangler.toml" },
        // The room's sqlite-backed class leaves -shm files behind that this
        // pool's isolated-storage copy chokes on; the live tests use unique
        // room names, so sharing one namespace is safe.
        isolatedStorage: false,
      },
    },
  },
});
