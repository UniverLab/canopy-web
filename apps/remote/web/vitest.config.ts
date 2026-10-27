// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/remote/web/test/**/*.test.ts"],
    environment: "happy-dom",
    setupFiles: ["apps/remote/web/test/setup.ts"],
  },
});
