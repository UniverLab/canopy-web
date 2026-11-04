// SPDX-License-Identifier: Apache-2.0
/**
 * The agent discovery files: llms.txt, sitemap, API catalogue, ARD
 * manifest and Agent Skills index, served from static text with no
 * upstream — plus the Link header and markdown negotiation on the SPA
 * fallback. Every catalogue URL is fetched back through the Worker, and
 * every digest is checked against the bytes actually served.
 */
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.js";
import { AGENT_LINK_HEADER } from "../src/agent-files.js";
import type { RoomNamespace, RoomStub } from "../src/ws.js";
import { FakeAssets } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";

class FakeNamespace implements RoomNamespace {
  idFromName(name: string): unknown {
    void name;
    return "room";
  }

  get(id: unknown): RoomStub {
    void id;
    return {
      fetch: (): Promise<Response> => Promise.resolve(new Response("forwarded")),
    };
  }
}

const env: Env = {
  USER_ROOM: new FakeNamespace(),
  ASSETS: new FakeAssets(),
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  TURN_KEY_ID: "turn-key-id",
  TURN_KEY_API_TOKEN: "turn-api-token",
};

function request(path: string, init: { method?: string; accept?: string } = {}): Request {
  const headers = new Headers();
  if (init.accept !== undefined) {
    headers.set("accept", init.accept);
  }
  return new Request(new URL(path, ORIGIN), { method: init.method ?? "GET", headers });
}

function expectSecurityHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

/** The lowercase hex SHA-256 of the served bytes, `sha256:`-prefixed. */
async function digestOf(body: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

describe("llms.txt", () => {
  it("describes the service, pairing and the end-to-end channel", async () => {
    const response = await worker.fetch(request("/llms.txt"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expectSecurityHeaders(response);
    const body = await response.text();
    for (const line of [
      "Canopy remote",
      "GitHub",
      "canopy remote pair",
      "/pair#<code>",
      "end to end",
      "/ws/device",
      "/ws/host",
      "/turn",
      "/.well-known/api-catalog",
    ]) {
      expect(body).toContain(line);
    }
  });
});

describe("sitemap.xml", () => {
  it("lists the public pages only", async () => {
    const response = await worker.fetch(request("/sitemap.xml"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expectSecurityHeaders(response);
    const body = await response.text();
    expect(body).toContain(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`);
    expect(body.match(/<loc>/g)).toHaveLength(4);
    for (const path of ["/", "/pair", "/editor", "/llms.txt"]) {
      expect(body).toContain(`<loc>${ORIGIN}${path}</loc>`);
    }
  });
});

describe("the API catalogue", () => {
  it("answers /.well-known/api-catalog with an RFC 9727 linkset", async () => {
    const response = await worker.fetch(request("/.well-known/api-catalog"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectSecurityHeaders(response);
    const body = (await response.json()) as {
      linkset: Array<{
        anchor: string;
        "service-desc"?: unknown;
        "service-doc": Array<{ href: string; type: string; title: string }>;
        status?: unknown;
      }>;
    };
    expect(body.linkset.map((entry) => entry.anchor)).toEqual([
      `${ORIGIN}/auth/`,
      "wss://remote.univerlab.org/ws/device",
      "wss://remote.univerlab.org/ws/host",
      `${ORIGIN}/turn`,
    ]);
    for (const entry of body.linkset) {
      expect(entry["service-doc"]).toHaveLength(1);
      expect(entry["service-doc"][0].href).toBe(`${ORIGIN}/llms.txt`);
      // No OpenAPI document and no health endpoint exist, so neither
      // relation is advertised.
      expect(entry["service-desc"]).toBeUndefined();
      expect(entry.status).toBeUndefined();
    }
  });

  it("points every service-doc at a URL the Worker serves", async () => {
    const body = (await (
      await worker.fetch(request("/.well-known/api-catalog"), env)
    ).json()) as { linkset: Array<{ "service-doc": Array<{ href: string }> }> };
    for (const entry of body.linkset) {
      for (const doc of entry["service-doc"]) {
        const served = await worker.fetch(request(new URL(doc.href).pathname), env);
        expect(served.status, doc.href).toBe(200);
      }
    }
  });
});

describe("the ARD manifest", () => {
  it("answers /.well-known/ai-catalog.json with the three resources", async () => {
    const response = await worker.fetch(request("/.well-known/ai-catalog.json"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectSecurityHeaders(response);
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
      displayName: "Canopy remote",
      identifier: "did:web:remote.univerlab.org",
    });
    expect(body.entries).toHaveLength(3);
    for (const entry of body.entries) {
      expect(entry.identifier).toMatch(/^urn:air:remote\.univerlab\.org:/);
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
        `${ORIGIN}/llms.txt`,
      ].sort(),
    );
  });

  it("points every entry url at a URL the Worker serves", async () => {
    const body = (await (
      await worker.fetch(request("/.well-known/ai-catalog.json"), env)
    ).json()) as { entries: Array<{ url?: string }> };
    for (const entry of body.entries) {
      const served = await worker.fetch(request(new URL(entry.url ?? "").pathname), env);
      expect(served.status, entry.url).toBe(200);
    }
  });
});

describe("the Agent Skills index", () => {
  it("indexes the canopy-remote skill with its digest", async () => {
    const response = await worker.fetch(request("/.well-known/agent-skills/index.json"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectSecurityHeaders(response);
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
    expect(body.skills).toHaveLength(1);
    const [skill] = body.skills;
    expect(skill.name).toBe("canopy-remote");
    expect(skill.type).toBe("skill-md");
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.url).toBe(`${ORIGIN}/.well-known/agent-skills/canopy-remote/SKILL.md`);
    expect(skill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("serves the skill at the indexed URL, digesting the bytes served", async () => {
    const index = (await (
      await worker.fetch(request("/.well-known/agent-skills/index.json"), env)
    ).json()) as { skills: Array<{ url: string; digest: string }> };
    const [skill] = index.skills;
    const response = await worker.fetch(request(new URL(skill.url).pathname), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectSecurityHeaders(response);
    const body = await response.text();
    expect(body).toContain("name: canopy-remote");
    expect(body).toContain("canopy remote pair");
    expect(await digestOf(body)).toBe(skill.digest);
  });

  it("answers unknown skills and files with a 404, never the SPA", async () => {
    for (const path of [
      "/.well-known/agent-skills",
      "/.well-known/agent-skills/",
      "/.well-known/agent-skills/other/SKILL.md",
      "/.well-known/agent-skills/canopy-remote/missing.md",
      "/.well-known/agent-skills/canopy-remote",
      "/.well-known/other",
      "/.well-known",
    ]) {
      const response = await worker.fetch(request(path), env);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: "not_found" });
    }
  });
});

describe("markdown negotiation", () => {
  it("answers / with the markdown summary when asked", async () => {
    const response = await worker.fetch(request("/", { accept: "text/markdown" }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")).toBe("Accept");
    expectSecurityHeaders(response);
    const body = await response.text();
    expect(body).toContain("Canopy remote");
    expect(body).toContain("pair");
    expect(body).toContain("end to end");
    // The summary is llms.txt's own text: one source, two content types.
    expect(body).toBe(await (await worker.fetch(request("/llms.txt"), env)).text());
  });

  it("answers a client route with markdown too, and HTML otherwise", async () => {
    const markdown = await worker.fetch(request("/pair", { accept: "text/html, text/markdown" }), env);
    expect(markdown.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const html = await worker.fetch(request("/pair"), env);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await html.text()).toContain('<div id="app">');
  });
});

describe("the Link header", () => {
  it("rides on every HTML fallback response", async () => {
    for (const path of ["/", "/pair", "/deep/link"]) {
      const response = await worker.fetch(request(path), env);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("link"), path).toBe(AGENT_LINK_HEADER);
      expect(response.headers.get("vary"), path).toBe("Accept");
    }
  });

  it("stays off file 404s and the markdown twin", async () => {
    for (const response of [
      await worker.fetch(request("/nope.css"), env),
      await worker.fetch(request("/", { accept: "text/markdown" }), env),
      await worker.fetch(request("/.well-known/other"), env),
    ]) {
      expect(response.headers.get("link")).toBeNull();
    }
  });
});

describe("methods and variants", () => {
  it("answers a POST to a discovery file with a 404, never the file", async () => {
    const response = await worker.fetch(request("/llms.txt", { method: "POST" }), env);
    expect(response.status).toBe(404);
  });

  it("keeps trailing-slash variants a 404", async () => {
    for (const path of ["/llms.txt/", "/sitemap.xml/"]) {
      const response = await worker.fetch(request(path), env);
      expect(response.status, path).toBe(404);
    }
  });
});
