// SPDX-License-Identifier: Apache-2.0
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    include: ["apps/remote/worker/test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Test-only config without the [assets] binding: unit tests never
        // need a built ../web/dist. See wrangler.test.toml.
        wrangler: { configPath: "./wrangler.test.toml" },
        // The room's sqlite-backed class leaves -shm files behind that this
        // pool's isolated-storage copy chokes on; the live tests use unique
        // room names, so sharing one namespace is safe.
        isolatedStorage: false,
      },
    },
  },
});
