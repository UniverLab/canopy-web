// SPDX-License-Identifier: Apache-2.0
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", "apps/remote/web/dist/", ".wrangler/", "coverage/", "**/.wrangler/", "apps/graphs/public/look/", "apps/graphs/public/editor/", "apps/remote/web/public/look/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
);
