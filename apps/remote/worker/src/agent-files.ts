// SPDX-License-Identifier: Apache-2.0
/**
 * The agent discovery files of remote.univerlab.org: the service summary,
 * sitemap, API catalogue, ARD manifest and Agent Skills index.
 *
 *   GET /llms.txt                              what remote is, in plain text
 *   GET /sitemap.xml                           the public pages only
 *   GET /.well-known/api-catalog                RFC 9727 linkset over the relay endpoints
 *   GET /.well-known/ai-catalog.json            ARD manifest: what an agent can use here
 *   GET /.well-known/agent-skills/index.json    the skills index (RFC v0.2.0)
 *   GET /.well-known/agent-skills/<name>/*      the skill files themselves
 *
 * `fetch()` in index.ts checks this module first, before the routes: the
 * discovery files never reach the auth or relay handlers. Everything is
 * static text — the skill bytes come from the generated module the build
 * validated — and every response carries the relay's security headers.
 * Like graphs' agent files, everything here describes something that
 * really exists: there is no MCP card (canopy mcp is a local stdio
 * server, and a card needs a remote URL) and no status relation (no
 * health endpoint exists). `robots.txt` stays the static file it is:
 * this remote is private to signed-in users, and the file says so.
 */
import { applySecurityHeaders } from "./protocol.js";
import { BUNDLED_SKILLS } from "./skills-data.generated.js";

/** A non-agent-file request: index.ts keeps routing it as before. */
export const NOT_AGENT_FILE = true as const;

/**
 * The Link header every HTML fallback response carries (set in the SPA
 * fallback): the plain-text service summary and the API catalogue, in
 * univerlab.org's own shape.
 */
export const AGENT_LINK_HEADER =
  `</llms.txt>; rel="describedby"; type="text/plain", ` +
  `</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`;

/** The Agent Skills Discovery schema the index declares. */
const SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** The relay origin, for absolute sitemap URLs and linkset hrefs. */
const ORIGIN = "https://remote.univerlab.org";

/** True when the request prefers markdown over the SPA shell. */
export function wantsMarkdown(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return accept.includes("text/markdown");
}

/**
 * The service summary: what remote is, how pairing works, and that the
 * session channel is end-to-end between browser and host. Served as
 * `text/plain` at `/llms.txt` and as `text/markdown` when the SPA
 * fallback is asked for markdown — one text, two content types.
 */
export const REMOTE_ABOUT = [
  "# Canopy remote",
  "",
  "Canopy remote is a private remote for signed-in Canopy users: a browser",
  "app plus a blind signaling relay at `https://remote.univerlab.org`. The",
  "browser signs in with GitHub, pairs with a host, and then drives that",
  "host's Canopy sessions from the page.",
  "",
  "## How pairing works",
  "",
  "- The browser opens `/auth/login` and signs in with GitHub: identity",
  "  only, no scope. It keeps an HMAC-signed `cr_session` cookie (12 hours).",
  "- The host links with `canopy remote link`, which prints a short pairing",
  "  code. The browser opens `/pair#<code>`.",
  "- Browser and host run the pairing handshake through the relay. The",
  "  pairing secret is derived on both ends; the relay only forwards frames.",
  "- Paired hosts reconnect on later visits without a new code, until the",
  "  device forgets them.",
  "",
  "## The session channel",
  "",
  "After pairing, the browser and the host talk end to end: terminal bytes,",
  "session snapshots, file-shelf transfers and graph state flow over a",
  "channel the relay cannot read. The relay proves both ends belong to the",
  "same GitHub account and forwards opaque envelopes, storing nothing.",
  "",
  "## Endpoints",
  "",
  "- `GET /auth/login` — start the GitHub sign-in.",
  "- `GET /auth/callback` — the OAuth landing; sets `cr_session`.",
  "- `POST /auth/logout` — clear the session.",
  "- `GET /auth/me` — the signed-in identity, or 401.",
  "- `GET /ws/device` — the browser's relay socket (session cookie).",
  "- `GET /ws/host` — the host's relay socket (host bearer).",
  "- `GET /turn` — TURN credentials for either end (either credential).",
  "",
  "## For agents",
  "",
  "- Service summary: https://remote.univerlab.org/llms.txt",
  "- API catalogue: https://remote.univerlab.org/.well-known/api-catalog",
  "- ARD manifest: https://remote.univerlab.org/.well-known/ai-catalog.json",
  "- Agent Skills: https://remote.univerlab.org/.well-known/agent-skills/index.json",
  "",
].join("\n");

/** The public pages: the app, the pair landing and the graph editor. */
const SITEMAP_PATHS = ["/", "/pair", "/editor", "/llms.txt"];

/** The sitemap: the four public page URLs, nothing signed-in. */
function sitemapBody(): string {
  const items = SITEMAP_PATHS.map((path) => `  <url><loc>${ORIGIN}${path}</loc></url>`);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...items,
    `</urlset>`,
    ``,
  ].join("\n");
}

/**
 * The RFC 9727 linkset: one entry per relay surface — the auth prefix,
 * the two relay sockets and TURN — each pointing at the service summary
 * that documents it. There is no service-desc (no OpenAPI document
 * exists) and no status relation (no health endpoint exists).
 */
function apiCatalogBody(): string {
  const doc = (title: string): Record<string, string> => ({
    href: `${ORIGIN}/llms.txt`,
    type: "text/plain",
    title,
  });
  return (
    JSON.stringify(
      {
        linkset: [
          {
            anchor: `${ORIGIN}/auth/`,
            "service-doc": [doc("Sign-in and session — GitHub OAuth, the session cookie, /auth/me")],
          },
          {
            anchor: `wss://remote.univerlab.org/ws/device`,
            "service-doc": [doc("The browser's relay socket — opaque envelopes over wss")],
          },
          {
            anchor: `wss://remote.univerlab.org/ws/host`,
            "service-doc": [doc("The host's relay socket — opaque envelopes over wss")],
          },
          {
            anchor: `${ORIGIN}/turn`,
            "service-doc": [doc("TURN credentials for either end — session cookie or host bearer")],
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * The ARD / AI Catalog manifest (specVersion 1.0): the API catalogue,
 * the Agent Skills index and the service summary. The shape mirrors
 * univerlab.org's own ai-catalog, minus the MCP entry — there is no
 * remote MCP server here to describe.
 */
function aiCatalogBody(): string {
  return (
    JSON.stringify(
      {
        specVersion: "1.0",
        host: {
          displayName: "Canopy remote",
          identifier: "did:web:remote.univerlab.org",
        },
        entries: [
          {
            identifier: "urn:air:remote.univerlab.org:catalog:api",
            displayName: "Canopy remote API catalog",
            description:
              "The RFC 9727 linkset for the relay endpoints — GitHub auth, the two relay " +
              "sockets and TURN — pointing at the service summary that documents them.",
            type: "application/linkset+json",
            url: `${ORIGIN}/.well-known/api-catalog`,
            representativeQueries: [
              "how do I sign in to canopy remote",
              "what are the canopy remote relay endpoints",
              "where are the canopy remote TURN credentials",
            ],
          },
          {
            identifier: "urn:air:remote.univerlab.org:skills:index",
            displayName: "Canopy remote Agent Skills index",
            description:
              "The Agent Skills Discovery index (RFC v0.2.0): the canopy-remote skill, " +
              "with its URL and a SHA-256 digest of the bytes actually served.",
            type: "application/json",
            url: `${ORIGIN}/.well-known/agent-skills/index.json`,
            representativeQueries: [
              "which agent skills does canopy remote publish",
              "how do I pair a device with canopy remote",
              "what can an agent do with canopy remote",
            ],
          },
          {
            identifier: "urn:air:remote.univerlab.org:docs:llms",
            displayName: "Canopy remote llms.txt",
            description:
              "The plain-language summary of the service: what it is, how pairing works, " +
              "and that the session channel is end-to-end between browser and host.",
            type: "text/plain",
            url: `${ORIGIN}/llms.txt`,
            representativeQueries: [
              "what is canopy remote",
              "how does canopy remote pairing work",
              "is the canopy remote session channel end to end",
            ],
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

/** The skills index: one entry per bundled skill, digests included. */
function skillsIndexBody(): string {
  return (
    JSON.stringify(
      {
        $schema: SKILLS_SCHEMA,
        skills: BUNDLED_SKILLS.map((skill) => ({
          name: skill.name,
          type: "skill-md",
          description: skill.description,
          url: `${ORIGIN}/.well-known/agent-skills/${skill.name}/SKILL.md`,
          digest: skill.digest,
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

/** A skill file's bytes, by name and inner path — or null when unknown. */
function skillFile(name: string, inner: string): string | null {
  const skill = BUNDLED_SKILLS.find((candidate) => candidate.name === name);
  if (skill === undefined) {
    return null;
  }
  return skill.files[inner] ?? null;
}

/** A markdown file answers as markdown; anything else as plain text. */
function skillContentType(inner: string): string {
  return inner.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
}

function fileResponse(body: string, contentType: string, cors: boolean): Response {
  const headers = applySecurityHeaders(
    new Headers({
      "content-type": contentType,
      "cache-control": "public, max-age=300",
    }),
  );
  if (cors) {
    headers.set("access-control-allow-origin", "*");
  }
  return new Response(body, { status: 200, headers });
}

/**
 * The agent-file router. A Response for the discovery files, NOT_AGENT_FILE
 * for anything else so `fetch()` keeps routing as before. GET only, and
 * exact paths only: a trailing slash stays a 404, like every other
 * `/.well-known/*` path no skill holds.
 */
export function handleAgentFiles(req: Request): Response | typeof NOT_AGENT_FILE {
  if (req.method !== "GET") {
    return NOT_AGENT_FILE;
  }
  const pathname = new URL(req.url).pathname;
  if (pathname === "/llms.txt") {
    return fileResponse(REMOTE_ABOUT, "text/plain; charset=utf-8", false);
  }
  if (pathname === "/sitemap.xml") {
    return fileResponse(sitemapBody(), "application/xml; charset=utf-8", false);
  }
  if (pathname === "/.well-known/api-catalog") {
    return fileResponse(apiCatalogBody(), "application/linkset+json", true);
  }
  if (pathname === "/.well-known/ai-catalog.json") {
    return fileResponse(aiCatalogBody(), "application/json", true);
  }
  if (pathname === "/.well-known/agent-skills/index.json") {
    return fileResponse(skillsIndexBody(), "application/json; charset=utf-8", true);
  }
  const prefix = "/.well-known/agent-skills/";
  if (pathname.startsWith(prefix)) {
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      return NOT_AGENT_FILE;
    }
    const body = skillFile(rest.slice(0, slash), rest.slice(slash + 1));
    if (body === null) {
      return NOT_AGENT_FILE;
    }
    return fileResponse(body, skillContentType(rest.slice(slash + 1)), true);
  }
  return NOT_AGENT_FILE;
}
