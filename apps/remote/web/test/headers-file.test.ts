// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECURITY_HEADERS } from "../../worker/src/protocol.js";

/**
 * The static `_headers` file is the only thing decorating asset responses
 * (Cloudflare's assets binding honours it in dev and prod), so it must
 * carry exactly the same security headers as the Worker's own responses.
 * Single source of truth: the constants exported by worker/src/protocol.ts.
 */
describe("web/public/_headers", () => {
  const resolveFromRoot = (path: string): string =>
    isAbsolute(path) ? path : join(process.cwd(), path);

  const file = readFileSync(
    resolveFromRoot("apps/remote/web/public/_headers"),
    "utf8",
  );
  const lines = file.split("\n");

  it("routes every path", () => {
    expect(lines[0]).toBe("/*");
  });

  it("declares the exact CSP used by the Worker", () => {
    const csp = lines.find((line) =>
      line.trim().toLowerCase().startsWith("content-security-policy:"),
    );
    expect(csp?.slice("  Content-Security-Policy:".length).trim()).toBe(
      SECURITY_HEADERS["content-security-policy"],
    );
  });

  it("declares Referrer-Policy and X-Content-Type-Options", () => {
    const names = lines
      .filter((line) => line.startsWith("  "))
      .map((line) => line.trim().split(":")[0].toLowerCase());
    expect(names).toContain("referrer-policy");
    expect(names).toContain("x-content-type-options");
    expect(names).toHaveLength(3);
  });
});
