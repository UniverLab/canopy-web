// SPDX-License-Identifier: Apache-2.0
/**
 * The agent discovery files of graphs.univerlab.org that name what an
 * agent can use: the ARD manifest, the Agent Skills index and auth.md.
 *
 *   GET /auth.md                                  what needs auth, truthfully
 *   GET /.well-known/ai-catalog.json              ARD manifest over the catalogue API
 *   GET /.well-known/agent-skills/index.json      the skills index (RFC v0.2.0)
 *   GET /.well-known/agent-skills/<name>/*        the skill files themselves
 *
 * `answer()` in index.ts checks this module after the agent files
 * (robots, sitemap, API catalogue, OpenAPI) and before `/api`. Like
 * those, everything is static text — the skill bytes come from the
 * generated module the build validated — and everything describes
 * something that really exists: there is no MCP card (canopy mcp is a
 * local stdio server, and a card needs a remote URL).
 */
import { SITE_NAME } from "./pages/copy.js";
import { BUNDLED_SKILLS } from "./skills-data.generated.js";

/** A non-discovery request: index.ts keeps routing it as before. */
export const NOT_DISCOVERY = true as const;

/** The Agent Skills Discovery schema the index declares. */
const SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/** The catalogue origin, for absolute linkset hrefs and index URLs. */
function origin(): string {
  return `https://${SITE_NAME}`;
}

/**
 * What needs auth on this catalogue, and what does not. Reads need
 * nothing; publishing and reporting ride on a GitHub account, never on
 * a catalogue credential — there is no account here to register for.
 */
export const AUTH_MD_BODY = [
  "# graphs.univerlab.org auth.md",
  "",
  "Everything a machine can read at graphs.univerlab.org is public and",
  "read-only. There is no catalogue account, no API key and no registration:",
  "this file says what needs nothing and what rides on a GitHub account.",
  "",
  "## Needs nothing",
  "",
  "Anonymous and read-only, no credential of any kind:",
  "",
  "- the catalogue pages and their markdown twins (`Accept: text/markdown`);",
  "- `llms.txt`, the one-line-per-document index;",
  "- the JSON API — every `GET /api/*` route listed in",
  "  `/.well-known/api-catalog`;",
  "- the install redirects (`/i/...` answer 302 to the document on GitHub);",
  "- drafts: `POST /api/drafts` is public (10 per minute per IP) and a",
  "  draft installs once within 30 minutes, no account either way;",
  "- the WebMCP tools every page registers (`search_catalogue`, `get_graph`,",
  "  `get_node`) — they call the public `GET /api/*` routes only.",
  "",
  "## Needs a GitHub account",
  "",
  "Publishing is pushing to GitHub. A repository that carries the",
  "`canopy-graph` topic and a `graphs/` or `nodes/` document folder is",
  "listed by the scheduled index; the official listing additionally needs",
  "a merged pull request to the official repository. No catalogue token is",
  "issued, requested or accepted anywhere in that flow.",
  "",
  "Reporting is a GitHub issue: the Report link on every document page",
  "pre-fills an issue in the official catalogue repository, and a",
  "maintainer decides by pull request. Filing one needs a GitHub account;",
  "reading the catalogue never does.",
  "",
  "## There is nothing to obtain",
  "",
  "No registration endpoint, no OAuth client, no token: nothing here",
  "behaves differently depending on who is asking, and no discovery",
  "document describes how to ask for a credential, because none is issued.",
  "",
  "## Contact",
  "",
  "Jheison Martinez Bolivar — `hola@univerlab.org`, the address published on",
  "univerlab.org. Write for a question, a correction, or an integration this",
  "file does not cover.",
  "",
].join("\n");

/**
 * The ARD / AI Catalog manifest (specVersion 1.0): the API catalogue,
 * the Agent Skills index, llms.txt and the OpenAPI description. The shape
 * mirrors univerlab.org's own ai-catalog, with the OpenAPI document where
 * univerlab.org lists its MCP server — there is no remote MCP server here
 * to describe.
 */
function aiCatalogBody(): string {
  return (
    JSON.stringify(
      {
        specVersion: "1.0",
        host: {
          displayName: "Canopy graphs",
          identifier: "did:web:graphs.univerlab.org",
        },
        entries: [
          {
            identifier: "urn:air:graphs.univerlab.org:catalog:api",
            displayName: "Canopy graphs API catalog",
            description:
              "The RFC 9727 linkset for the catalogue API — pointing at its OpenAPI " +
              "description, the publish guide and the index status.",
            type: "application/linkset+json",
            url: `${origin()}/.well-known/api-catalog`,
            representativeQueries: [
              "is there a public API for the canopy graph catalogue",
              "where is the openapi description of the graphs catalogue",
              "how do I search the canopy catalogue from a script",
            ],
          },
          {
            identifier: "urn:air:graphs.univerlab.org:skills:index",
            displayName: "Canopy graphs Agent Skills index",
            description:
              "The Agent Skills Discovery index (RFC v0.2.0): the canopy-graph-design " +
              "skill, with its URL and a SHA-256 digest of the bytes actually served.",
            type: "application/json",
            url: `${origin()}/.well-known/agent-skills/index.json`,
            representativeQueries: [
              "which agent skills does the graphs catalogue publish",
              "how do I design a reusable canopy graph",
              "where is the canopy graph design skill",
            ],
          },
          {
            identifier: "urn:air:graphs.univerlab.org:docs:llms",
            displayName: "Canopy graphs llms.txt",
            description:
              "The plain-text index of the catalogue: one tab-separated line per official " +
              "document and pattern, with name, description and install ref.",
            type: "text/plain",
            url: `${origin()}/llms.txt`,
            representativeQueries: [
              "which graphs are in the canopy catalogue",
              "what canopy nodes can I install",
              "where is the catalogue's llms.txt",
            ],
          },
          {
            identifier: "urn:air:graphs.univerlab.org:catalog:openapi",
            displayName: "Canopy graphs OpenAPI description",
            description:
              "The OpenAPI 3.1 description of the read-only catalogue API: official " +
              "listing, search, single documents, index status and drafts.",
            type: "application/openapi+json",
            url: `${origin()}/api/openapi.json`,
            representativeQueries: [
              "what does the catalogue search API return",
              "how do I fetch one graph document as JSON",
              "what is the shape of a catalogue API error",
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
          url: `${origin()}/.well-known/agent-skills/${skill.name}/SKILL.md`,
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
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=300",
  });
  if (cors) {
    headers.set("access-control-allow-origin", "*");
  }
  return new Response(body, { status: 200, headers });
}

/**
 * The discovery router. A Response for the four files, NOT_DISCOVERY for
 * anything else so `answer()` keeps routing as before. GET only, and
 * exact paths only: a trailing slash stays a 404, like every other
 * `/.well-known/*` path no skill holds.
 */
export function handleDiscoveryFiles(req: Request): Response | typeof NOT_DISCOVERY {
  if (req.method !== "GET") {
    return NOT_DISCOVERY;
  }
  const pathname = new URL(req.url).pathname;
  if (pathname === "/auth.md") {
    return fileResponse(AUTH_MD_BODY, "text/markdown; charset=utf-8", false);
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
      return NOT_DISCOVERY;
    }
    const body = skillFile(rest.slice(0, slash), rest.slice(slash + 1));
    if (body === null) {
      return NOT_DISCOVERY;
    }
    return fileResponse(body, skillContentType(rest.slice(slash + 1)), true);
  }
  return NOT_DISCOVERY;
}
