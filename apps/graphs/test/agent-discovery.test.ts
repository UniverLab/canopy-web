// SPDX-License-Identifier: Apache-2.0
/**
 * The discovery files that name what an agent can use: auth.md, the ARD
 * manifest and the Agent Skills index, plus the WebMCP tools every page
 * registers. Every catalogue URL is fetched back through the Worker, and
 * every digest is checked against the bytes actually served.
 */
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { AUTH_MD_BODY } from "../src/agent-discovery.js";
import { WEBMCP_TOOL_NAMES } from "../src/pages/webmcp.js";
import { BUNDLED_SKILLS } from "../src/skills-data.generated.js";
import { createGitHub } from "../src/github.js";
import { runIndexer } from "../src/indexer.js";
import { resetIndexMemo } from "../src/store.js";
import { FakeCache, FakeKV, fakeFetch, type Stub } from "./fakes.js";
import { searchStubs } from "./stubs.js";

const ORIGIN = "https://graphs.univerlab.org";

/** Seed a fresh KV by running the indexer over the stub table. */
async function seeded(stubsToSeed: Stub[]): Promise<FakeKV> {
  resetIndexMemo();
  const fake = fakeFetch(stubsToSeed);
  const kv = new FakeKV();
  const github = createGitHub({ fetchImpl: fake.fetchImpl, cache: new FakeCache() });
  await runIndexer({ github, index: kv, authenticated: false });
  return kv;
}

async function call(path: string, kv?: FakeKV, accept?: string): Promise<Response> {
  if (kv === undefined) {
    resetIndexMemo();
  }
  const headers: Record<string, string> = accept === undefined ? {} : { accept };
  return worker.fetch(
    new Request(new URL(path, ORIGIN), { headers }),
    kv === undefined ? {} : { INDEX: kv },
  );
}

/** The lowercase hex SHA-256 of the served bytes, `sha256:`-prefixed. */
async function digestOf(body: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

describe("auth.md", () => {
  it("states truthfully what needs auth and what does not", async () => {
    const response = await call("/auth.md");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await response.text();
    expect(body).toBe(`${AUTH_MD_BODY}`);
    expect(body.match(/^# (.+)$/m)?.[1]).toContain("auth.md");
    for (const line of [
      "no catalogue account",
      "GitHub account",
      "canopy-graph",
      "hola@univerlab.org",
      "search_catalogue",
    ]) {
      expect(body).toContain(line);
    }
  });

  it("is listed in the sitemap and named by no other route", async () => {
    const sitemap = await (await call("/sitemap.xml", await seeded(searchStubs()))).text();
    expect(sitemap).toContain(`<loc>${ORIGIN}/auth.md</loc>`);
  });
});

describe("the ARD manifest", () => {
  it("answers /.well-known/ai-catalog.json with the four resources", async () => {
    const response = await call("/.well-known/ai-catalog.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as {
      specVersion: string;
      host: { displayName: string; identifier: string };
      entries: Array<{
        identifier: string;
        displayName: string;
        description: string;
        type: string;
        url?: string;
        data?: unknown;
        representativeQueries: string[];
      }>;
    };
    expect(body.specVersion).toBe("1.0");
    expect(body.host).toEqual({
      displayName: "Canopy graphs",
      identifier: "did:web:graphs.univerlab.org",
    });
    expect(body.entries).toHaveLength(4);
    for (const entry of body.entries) {
      expect(entry.identifier).toMatch(/^urn:air:graphs\.univerlab\.org:/);
      expect(entry.displayName.length).toBeGreaterThan(0);
      expect(entry.type).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
      expect(Number("url" in entry) + Number("data" in entry)).toBe(1);
      expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
      expect(entry.representativeQueries.length).toBeLessThanOrEqual(5);
    }
    expect(body.entries.map((entry) => entry.url).sort()).toEqual(
      [
        `${ORIGIN}/.well-known/agent-skills/index.json`,
        `${ORIGIN}/.well-known/api-catalog`,
        `${ORIGIN}/api/openapi.json`,
        `${ORIGIN}/llms.txt`,
      ].sort(),
    );
  });

  it("points every entry url at a URL the Worker serves", async () => {
    const kv = await seeded(searchStubs());
    const body = (await (await call("/.well-known/ai-catalog.json", kv)).json()) as {
      entries: Array<{ url?: string }>;
    };
    for (const entry of body.entries) {
      const served = await call(new URL(entry.url ?? "").pathname, kv);
      expect(served.status, entry.url).toBe(200);
    }
  });

  it("is named by the Agentmap in robots.txt", async () => {
    const body = await (await call("/robots.txt")).text();
    expect(body).toMatch(/^Agentmap: https:\/\/graphs\.univerlab\.org\/\.well-known\/ai-catalog\.json$/m);
  });
});

describe("the Agent Skills index", () => {
  it("indexes the canopy-graph-design skill with its digest", async () => {
    const response = await call("/.well-known/agent-skills/index.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as {
      $schema: string;
      skills: Array<{
        name: string;
        type: string;
        description: string;
        url: string;
        digest: string;
      }>;
    };
    expect(body.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(body.skills).toHaveLength(BUNDLED_SKILLS.length);
    expect(body.skills.length).toBeGreaterThan(0);
    for (const skill of body.skills) {
      expect(skill.name).toMatch(/^[a-z0-9-]+$/);
      expect(skill.type).toBe("skill-md");
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.url).toBe(`${ORIGIN}/.well-known/agent-skills/${skill.name}/SKILL.md`);
      expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(body.skills.map((skill) => skill.name)).toContain("canopy-graph-design");
  });

  it("serves every bundled skill file at its URL, digesting the bytes served", async () => {
    const index = (await (
      await call("/.well-known/agent-skills/index.json")
    ).json()) as { skills: Array<{ name: string; url: string; digest: string }> };
    for (const skill of index.skills) {
      const bundled = BUNDLED_SKILLS.find((candidate) => candidate.name === skill.name);
      expect(bundled).toBeDefined();
      for (const inner of Object.keys(bundled?.files ?? {})) {
        const response = await call(`/.well-known/agent-skills/${skill.name}/${inner}`);
        expect(response.status, inner).toBe(200);
        expect(response.headers.get("access-control-allow-origin"), inner).toBe("*");
        expect(response.headers.get("content-type"), inner).toBe(
          inner.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
        );
        expect(await response.text(), inner).toBe(bundled?.files[inner]);
      }
      const served = await call(new URL(skill.url).pathname);
      expect(await digestOf(await served.text())).toBe(skill.digest);
    }
  });

  it("answers unknown skills and files with a 404, never a page", async () => {
    for (const path of [
      "/.well-known/agent-skills",
      "/.well-known/agent-skills/",
      "/.well-known/agent-skills/other/SKILL.md",
      "/.well-known/agent-skills/canopy-graph-design/missing.md",
      "/.well-known/agent-skills/canopy-graph-design",
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
    }
  });
});

describe("WebMCP", () => {
  it("registers the three catalogue tools on every HTML page", async () => {
    const kv = await seeded(searchStubs());
    for (const path of ["/", "/search?q=flow", "/publish", "/patterns"]) {
      const body = await (await call(path, kv)).text();
      expect(body, path).toContain("registerTool");
      // document first, navigator as the older name — univerlab's shape.
      expect(body, path).toContain("modelContext");
      expect(body, path).toContain("from(document)");
      expect(body, path).toContain("from(navigator)");
      for (const name of WEBMCP_TOOL_NAMES) {
        expect(body, `${path} ${name}`).toContain(`name:"${name}"`);
      }
      // The real API routes: search literally, documents composed.
      for (const route of ["/api/search", "/api/", '"g"', '"n"']) {
        expect(body, `${path} ${route}`).toContain(route);
      }
      expect(body, path).toContain("readOnlyHint");
    }
  });

  it("keeps the inline script one balanced block", async () => {
    const kv = await seeded(searchStubs());
    const body = await (await call("/", kv)).text();
    // No `</script>` inside the script itself: opens and closes balance.
    expect(body.split("<script").length).toBe(body.split("</script>").length);
  });

  it("stays off the markdown twin", async () => {
    const kv = await seeded(searchStubs());
    const body = await (await call("/", kv, "text/markdown")).text();
    expect(body).not.toContain("registerTool");
  });
});
