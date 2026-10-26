// SPDX-License-Identifier: Apache-2.0
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type DataPoint, type Env } from "../src/index.js";
import { SLUG_PATTERN, SLUG_RE } from "../src/lib.js";

const ORIGIN = "https://graphs.univerlab.org";

const official = (kind: string, slug: string, ref = "HEAD"): string =>
  `https://raw.githubusercontent.com/UniverLab/graphs/${ref}/registry/${kind}s/${slug}/${kind}.json`;

const community = (owner: string, repo: string, kind: string, slug: string, ref = "HEAD"): string =>
  `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${kind}s/${slug}/${kind}.json`;

interface Options {
  ua?: string | null;
  country?: string;
  env?: Env;
}

function request(path: string, options: Options = {}): Request {
  const headers = new Headers();
  if (options.ua !== null) {
    headers.set("user-agent", options.ua ?? "curl/8.5.0");
  }
  const req = new Request(new URL(path, ORIGIN), { headers });
  if (options.country) {
    Object.defineProperty(req, "cf", { value: { country: options.country }, configurable: true });
  }
  return req;
}

function call(path: string, options: Options = {}): Response {
  return worker.fetch(request(path, options), options.env ?? {});
}

/** An env whose Analytics Engine binding records what the Worker sends it. */
function counting(points: DataPoint[]): Env {
  return {
    INSTALLS: {
      writeDataPoint: (point: DataPoint): void => {
        points.push(point);
      },
    },
  };
}

describe("redirects", () => {
  it("sends an official graph to the registry layout on GitHub", () => {
    const response = call("/i/graph/hello-graph");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("sends an official node to the registry layout on GitHub", () => {
    const response = call("/i/node/hello-node");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("node", "hello-node"));
  });

  it("serves the same redirect through the deployed Worker", async () => {
    const response = await SELF.fetch(`${ORIGIN}/i/graph/hello-graph`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("sends a community node to the repository without the registry prefix", () => {
    const response = call("/i/acme/things/node/cool-node");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(community("acme", "things", "node", "cool-node"));
  });

  it("sends a community graph to the repository without the registry prefix", () => {
    const response = call("/i/acme/things/graph/flow");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(community("acme", "things", "graph", "flow"));
  });

  it("honours ?ref= for a tag", () => {
    const response = call("/i/graph/hello-graph?ref=v1.2.0");
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph", "v1.2.0"));
  });

  it("honours ?ref= for a branch containing a slash", () => {
    const response = call("/i/acme/things/node/cool-node?ref=release/1.x");
    expect(response.headers.get("location")).toBe(
      community("acme", "things", "node", "cool-node", "release/1.x"),
    );
  });

  it("tolerates a trailing slash", () => {
    const response = call("/i/graph/hello-graph/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("never returns the document itself", () => {
    const response = call("/i/graph/hello-graph");
    expect(response.body).toBeNull();
    expect(response.headers.get("content-type")).toBeNull();
  });
});

describe("bad requests", () => {
  const cases: Array<{ path: string; reason: string }> = [
    { path: "/i/preset/hello-graph", reason: "kind must be graph or node" },
    { path: "/i/graph/Hello", reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: "/i/graph/hello_node", reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: `/i/graph/${"a".repeat(49)}`, reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: "/i/graph", reason: "unknown route" },
    { path: "/i/a/b/c", reason: "unknown route" },
    { path: "/i/graph/hello-graph/extra/route/more", reason: "unknown route" },
    { path: "/health", reason: "unknown route" },
    { path: "/i/-acme/things/graph/flow", reason: "owner must follow GitHub rules" },
    { path: "/i/acme/re@po/graph/flow", reason: "repo must follow GitHub rules" },
    { path: "/i/acme/things/preset/flow", reason: "kind must be graph or node" },
    { path: "/i/acme/things/graph/Flow", reason: "slug must be 1-48 characters of a-z, 0-9 or -" },
    { path: "/i/graph/hello-graph?ref=", reason: "ref must be a branch, tag or commit sha" },
    { path: "/i/graph/hello-graph?ref=-main", reason: "ref must be a branch, tag or commit sha" },
    {
      path: `/i/graph/hello-graph?ref=${"x".repeat(129)}`,
      reason: "ref must be a branch, tag or commit sha",
    },
  ];

  it("rejects every invalid shape with a 400 and a one-line reason", async () => {
    for (const { path, reason } of cases) {
      const response = call(path);
      expect(response.status, path).toBe(400);
      expect(response.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      const text = await response.text();
      expect(text, path).toContain(reason);
      expect(text.trimEnd().split("\n"), path).toHaveLength(1);
    }
  });

  it("rejects through the deployed Worker too", async () => {
    const response = await SELF.fetch(`${ORIGIN}/i/preset/hello-graph`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("kind must be graph or node");
  });
});

describe("bare install path", () => {
  it.each(["/i/", "/i"])("answers %s with a 404 and the usage text", async (path) => {
    const response = call(path);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain("/i/<kind>/<slug>");
    expect(text).toContain("/i/<owner>/<repo>/<kind>/<slug>");
    expect(text).toContain("graph or node");
  });
});

describe("counting", () => {
  it("writes one point for a redirect", () => {
    const points: DataPoint[] = [];
    const response = call("/i/graph/hello-graph", { ua: "curl/8.5.0", env: counting(points) });
    expect(response.status).toBe(302);
    expect(points).toHaveLength(1);
    expect(points[0]).toEqual({
      indexes: ["UniverLab/graphs/graph/hello-graph"],
      blobs: ["graph", "UniverLab/graphs/hello-graph", "curl", "", "", "redirect"],
      doubles: [1],
    });
  });

  it("records the Canopy version and country without the raw user-agent", () => {
    const points: DataPoint[] = [];
    call("/i/node/hello-node", {
      ua: `canopy/1.7.2 ${"x".repeat(200)}`,
      country: "CO",
      env: counting(points),
    });
    expect(points).toHaveLength(1);
    const blobs = points[0]?.blobs ?? [];
    expect(blobs[2]).toBe("canopy");
    expect(blobs[3]).toBe("1.7.2");
    expect(blobs[4]).toBe("CO");
    expect(blobs.join(" ")).not.toContain("x".repeat(10));
  });

  it("tells browsers and unknown clients from scripts", () => {
    const cases: Array<[string | null, string]> = [
      ["Mozilla/5.0 (Macintosh) Safari/605", "browser"],
      ["wget/1.21", "other"],
      [null, "other"],
    ];
    for (const [ua, client] of cases) {
      const points: DataPoint[] = [];
      call("/i/graph/hello-graph", { ua, env: counting(points) });
      expect(points[0]?.blobs?.[2], String(ua)).toBe(client);
      expect(points[0]?.blobs?.[3], String(ua)).toBe("");
    }
  });

  it("writes a bad-request point with the parts it could read", () => {
    const points: DataPoint[] = [];
    const response = call("/i/graph/Not_A_Slug", { env: counting(points) });
    expect(response.status).toBe(400);
    expect(points).toEqual([
      {
        indexes: ["UniverLab/graphs/graph/?"],
        blobs: ["graph", "UniverLab/graphs/?", "curl", "", "", "bad-request"],
        doubles: [1],
      },
    ]);
  });

  it("writes a bad-request point for the bare /i/", () => {
    const points: DataPoint[] = [];
    const response = call("/i/", { env: counting(points) });
    expect(response.status).toBe(404);
    expect(points).toEqual([
      { indexes: ["?/?/?/?"], blobs: ["?", "?/?/?", "curl", "", "", "bad-request"], doubles: [1] },
    ]);
  });

  it("writes one point per request, never two", () => {
    const points: DataPoint[] = [];
    for (const path of ["/i/graph/hello-graph", "/i/graph/hello-graph?ref=main", "/health"]) {
      call(path, { env: counting(points) });
    }
    expect(points).toHaveLength(3);
  });
});

describe("analytics never changes the answer", () => {
  it("still redirects when the binding throws", () => {
    const env: Env = {
      INSTALLS: {
        writeDataPoint: (): void => {
          throw new Error("analytics engine is down");
        },
      },
    };
    const response = call("/i/graph/hello-graph", { env });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("still redirects when the binding is missing", () => {
    const response = call("/i/graph/hello-graph", { env: {} });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(official("graph", "hello-graph"));
  });

  it("still answers bad requests when the binding throws", async () => {
    const env: Env = {
      INSTALLS: {
        writeDataPoint: (): void => {
          throw new Error("analytics engine is down");
        },
      },
    };
    const response = call("/i/preset/hello-graph", { env });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("kind must be graph or node");
  });
});

describe("slug rule", () => {
  it("matches the literal pattern copied from src/slug.ts", () => {
    expect(SLUG_RE.source).toBe(SLUG_PATTERN);
    expect(SLUG_RE.test("hello-graph")).toBe(true);
    expect(SLUG_RE.test("hello_graph")).toBe(false);
    expect(SLUG_RE.test("Hello")).toBe(false);
  });
});
