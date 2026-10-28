// SPDX-License-Identifier: Apache-2.0
/**
 * The agent discovery files of graphs.univerlab.org: robots, sitemap,
 * API catalogue and OpenAPI description.
 *
 *   GET /robots.txt                  who may crawl, and the sitemap address
 *   GET /sitemap.xml                 every page URL, from the scheduled index
 *   GET /.well-known/api-catalog      RFC 9727 linkset over the JSON API
 *   GET /api/openapi.json            OpenAPI 3.1 description of the JSON API
 *
 * `answer()` in index.ts checks this module first, before `/api`: the
 * OpenAPI document never reaches the API router. Every other
 * `/.well-known/*` path falls through to the install redirector's 404.
 * Like the pages and the API, everything reads the scheduled index in
 * KV (store.ts) and never calls GitHub.
 *
 * This module is deliberately not `discovery.ts`: that name already holds
 * per-repository document discovery (the git-trees walk the indexer runs).
 */
import { SITE_NAME } from "./pages/copy.js";
import { pagePath, pageRef } from "./pages/ref.js";
import { createStore, type KV } from "./store.js";

/** A non-agent-file request: index.ts keeps routing it as before. */
export const NOT_AGENT_FILE = true as const;

/** The environment the agent files read: the index binding alone. */
export interface AgentEnv {
  INDEX?: KV;
}

/**
 * The Link header every HTML page carries (set in `page()`): the
 * plain-text site summary and the API catalogue, in univerlab.org's own
 * shape (`public/_headers` in the sibling univerlab repo).
 */
export const AGENT_LINK_HEADER =
  `</llms.txt>; rel="describedby"; type="text/plain", ` +
  `</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`;

/**
 * The catalogue is a public index agents should read: crawl everything
 * but the install redirects, which are not content. Training is not
 * granted — the documents are authored by third parties on GitHub.
 */
export const ROBOTS_BODY = [
  "# graphs.univerlab.org — the Canopy graph and node catalogue. Everything here is meant to be",
  "# read, indexed, and cited. LLM-friendly index: https://graphs.univerlab.org/llms.txt",
  "User-agent: *",
  "Allow: /",
  "Disallow: /i/",
  "# Training is not granted: the documents are authored by third parties on GitHub.",
  "Content-Signal: search=yes, ai-input=yes, ai-train=no",
  "Sitemap: https://graphs.univerlab.org/sitemap.xml",
  "",
].join("\n");

/** The fixed sitemap entries: present even with an empty or missing index. */
const SITEMAP_FIXED_PATHS = ["/", "/search", "/publish", "/llms.txt"];

/** The catalogue origin, for absolute sitemap URLs and linkset hrefs. */
function origin(): string {
  return `https://${SITE_NAME}`;
}

/** Escape one sitemap text node: URLs carry `&` in query strings. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The sitemap: the four fixed URLs plus the page URL of every graph and
 * node in the index, each with `lastmod` when the index entry carries an
 * `updated` date. It reads the index the pages already read and makes no
 * GitHub call; an empty or missing index still lists the fixed four.
 */
async function sitemapBody(env: AgentEnv): Promise<string> {
  const urls: Array<{ loc: string; lastmod: string | null }> = SITEMAP_FIXED_PATHS.map((path) => ({
    loc: `${origin()}${path}`,
    lastmod: null,
  }));
  const index = await createStore(env.INDEX).getIndex();
  for (const entry of index?.entries ?? []) {
    const ref = pageRef(entry.kind, entry.owner, entry.repo, entry.slug);
    urls.push({
      loc: `${origin()}${pagePath(ref)}`,
      lastmod: entry.updated === null || entry.updated === "" ? null : entry.updated,
    });
  }
  const items = urls.map(({ loc, lastmod }) =>
    lastmod === null
      ? `  <url><loc>${escapeXml(loc)}</loc></url>`
      : `  <url><loc>${escapeXml(loc)}</loc><lastmod>${escapeXml(lastmod)}</lastmod></url>`
  );
  return [`<?xml version="1.0" encoding="UTF-8"?>`, `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`, ...items, `</urlset>`, ``].join("\n");
}

/**
 * The RFC 9727 linkset: one entry anchored at the API root, naming the
 * machine-readable description, the human documentation and the index
 * status. The shape mirrors univerlab.org's own api-catalog.
 */
function apiCatalogBody(): string {
  return (
    JSON.stringify(
      {
        linkset: [
          {
            anchor: `${origin()}/api/`,
            "service-desc": [
              {
                href: `${origin()}/api/openapi.json`,
                type: "application/openapi+json",
                title: "OpenAPI 3.1 description of the graphs catalogue API",
              },
            ],
            "service-doc": [
              {
                href: `${origin()}/publish`,
                type: "text/html",
                title: "Publish — how to list a graph or node in the catalogue",
              },
            ],
            status: [
              {
                href: `${origin()}/api/index-status`,
                type: "application/json",
                title: "Catalogue index status — the last scheduled run's accounting",
              },
            ],
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

/** The typed error body the API answers 400s and 404s with. */
function errorRef(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Error" },
      },
    },
  };
}

/** The cold-start body every data route answers before the first run. */
function indexingRef(): Record<string, unknown> {
  return {
    description: "The first scheduled index run has not landed yet; retry shortly.",
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/Indexing" },
      },
    },
  };
}

/**
 * The OpenAPI 3.1 description of exactly the routes `api.ts` documents in
 * its header — `/api/official`, `/api/search`, `/api/g/{owner}/{repo}/{slug}`,
 * `/api/n/{owner}/{repo}/{slug}`, `/api/index-status`, `POST /api/drafts` and
 * `GET /api/drafts/{id}` — with their response shapes and the 400/404 error
 * shape. A test pins every route `api.ts` parses to a path here, so the two
 * cannot drift.
 */
export function openApiDocument(): Record<string, unknown> {
  const ownerParam = (name: string, description: string): Record<string, unknown> => ({
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "string" },
  });
  const documentResponses = (kind: string): Record<string, unknown> => ({
    "200": {
      description: `One ${kind} document: the validated JSON plus its catalogue row.`,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CatalogEntry" },
        },
      },
    },
    "400": errorRef("A path segment breaks the owner, repo or slug rule."),
    "404": errorRef(`No ${kind} by that name in the index.`),
    "410": {
      description: "The document was removed after a community report.",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Blocked" },
        },
      },
    },
    "503": indexingRef(),
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "graphs.univerlab.org catalogue API",
      version: "1.0.0",
      description:
        "Read-only JSON API over the scheduled catalogue index. Every answer is served " +
        "from KV — no call reaches GitHub — and every answer is CORS-open for GET.",
    },
    servers: [{ url: origin() }],
    paths: {
      "/api/official": {
        get: {
          operationId: "official",
          summary: "The official listing: graphs and nodes from the official repository.",
          responses: {
            "200": {
              description: "Official entries split by kind, in index order.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["graphs", "nodes"],
                    properties: {
                      graphs: { type: "array", items: { $ref: "#/components/schemas/DocRow" } },
                      nodes: { type: "array", items: { $ref: "#/components/schemas/DocRow" } },
                    },
                  },
                },
              },
            },
            "503": indexingRef(),
          },
        },
      },
      "/api/search": {
        get: {
          operationId: "search",
          summary: "Community search over the index: filter, sort, page.",
          parameters: [
            {
              name: "q",
              in: "query",
              description: "Free text over name, slug, description and owner/repo; at most 256 characters.",
              schema: { type: "string", maxLength: 256, default: "" },
            },
            {
              name: "sort",
              in: "query",
              description: "top orders by stars, new by updated.",
              schema: { type: "string", enum: ["top", "new"], default: "top" },
            },
            {
              name: "page",
              in: "query",
              description: "One-based page over 20-item pages.",
              schema: { type: "integer", minimum: 1, default: 1 },
            },
          ],
          responses: {
            "200": {
              description: "The page of matches plus the echoed filters.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/SearchOutcome" },
                },
              },
            },
            "400": errorRef("q is too long, or sort or page is malformed."),
            "503": indexingRef(),
          },
        },
      },
      "/api/g/{owner}/{repo}/{slug}": {
        get: {
          operationId: "graph",
          summary: "One graph document by owner, repo and slug.",
          parameters: [
            ownerParam("owner", "The GitHub owner: 1-39 letters, digits or -, no leading or trailing -."),
            ownerParam("repo", "The GitHub repository: 1-100 letters, digits, _, . or -."),
            ownerParam("slug", "The document slug: 1-48 characters of a-z, 0-9 or -."),
          ],
          responses: documentResponses("graph"),
        },
      },
      "/api/n/{owner}/{repo}/{slug}": {
        get: {
          operationId: "node",
          summary: "One node document by owner, repo and slug.",
          parameters: [
            ownerParam("owner", "The GitHub owner: 1-39 letters, digits or -, no leading or trailing -."),
            ownerParam("repo", "The GitHub repository: 1-100 letters, digits, _, . or -."),
            ownerParam("slug", "The document slug: 1-48 characters of a-z, 0-9 or -."),
          ],
          responses: documentResponses("node"),
        },
      },
      "/api/index-status": {
        get: {
          operationId: "indexStatus",
          summary: "The last index run's accounting.",
          responses: {
            "200": {
              description: "Run accounting; invalid details are trimmed past the first 20.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/IndexStatus" },
                },
              },
            },
            "503": indexingRef(),
          },
        },
      },
      "/api/drafts": {
        post: {
          operationId: "createDraft",
          summary: "Store a validated, harness-free graph or node draft for 30 minutes.",
          description:
            "The one write surface of the catalogue. Drafts are the deliberate exception to " +
            "the redirect-only contract: they live in KV for at most 30 minutes, the first " +
            "install deletes one, and the page carries noindex. At most 10 per minute per " +
            "client IP when the rate-limiting binding is present.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DraftRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "The draft was stored; install it once before it expires.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DraftCreated" },
                },
              },
            },
            "400": {
              description: "The body is malformed, or the document did not validate.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DraftInvalid" },
                },
              },
            },
            "413": errorRef("The body is larger than 256 KiB."),
            "429": errorRef("More than 10 drafts were created from this client in one minute."),
            "503": errorRef("Draft storage is not configured on this deployment."),
          },
        },
      },
      "/api/drafts/{id}": {
        get: {
          operationId: "readDraft",
          summary: "One stored draft, without consuming it.",
          parameters: [
            ownerParam("id", "The draft id: 26 characters of lowercase Crockford base32."),
          ],
          responses: {
            "200": {
              description: "The stored draft; reading it never deletes it.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Draft" },
                },
              },
            },
            "404": errorRef("No draft by that id: it expired, was installed, or never existed."),
            "503": errorRef("Draft storage is not configured on this deployment."),
          },
        },
      },
    },
    components: {
      schemas: {
        DocRow: {
          type: "object",
          required: [
            "kind",
            "slug",
            "name",
            "description",
            "readme",
            "nodeCount",
            "repo",
            "official",
            "stars",
            "updated",
            "harnesses",
            "sourceRef",
          ],
          properties: {
            kind: { type: "string", enum: ["graph", "node"] },
            slug: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            readme: { type: "string", description: "Listings carry no README text; always empty here." },
            nodeCount: { type: "integer", description: "Graphs: the node count. Nodes: 1." },
            repo: { type: "string", description: "The owner/repo pair." },
            official: { type: "boolean" },
            stars: { type: ["integer", "null"], description: "GitHub stars; null when unknown, never zero-filled." },
            updated: { type: ["string", "null"], description: "Last updated, YYYY-MM-DD, or null when unknown." },
            harnesses: { type: "array", items: { type: "string" } },
            sourceRef: { type: ["string", "null"], description: "The ref the page was read from, or null when unknown." },
            downloads: {
              type: "integer",
              description: "Install counts, present only when analytics is configured and this document has any.",
            },
          },
        },
        CatalogEntry: {
          type: "object",
          required: ["doc", "document"],
          properties: {
            doc: { $ref: "#/components/schemas/DocRow" },
            document: {
              description: "The validated graph or node JSON itself.",
              type: "object",
            },
          },
        },
        SearchOutcome: {
          type: "object",
          required: ["items", "q", "sort", "page", "total", "truncated"],
          properties: {
            items: { type: "array", items: { $ref: "#/components/schemas/DocRow" } },
            q: { type: "string" },
            sort: { type: "string", enum: ["top", "new"] },
            page: { type: "integer" },
            total: { type: "integer", description: "How many entries matched, across all pages." },
            truncated: { type: "boolean", description: "True while later pages still hold matches." },
          },
        },
        IndexStatus: {
          type: "object",
          required: [
            "built_at",
            "duration_ms",
            "calls",
            "repos_seen",
            "documents",
            "blocked",
            "invalid",
            "truncated",
            "authenticated",
          ],
          properties: {
            built_at: { type: "string" },
            duration_ms: { type: "integer" },
            calls: { type: "integer", description: "GitHub calls the run made." },
            repos_seen: { type: "integer" },
            documents: { type: "integer" },
            blocked: { type: "integer", description: "How many blocked-list entries the run read." },
            invalid: {
              type: "array",
              items: {
                type: "object",
                required: ["repo", "slug", "reason"],
                properties: {
                  repo: { type: "string" },
                  slug: { type: "string" },
                  reason: { type: "string" },
                },
              },
            },
            truncated: { type: "boolean" },
            authenticated: { type: "boolean" },
          },
        },
        DraftRequest: {
          type: "object",
          required: ["kind", "document"],
          properties: {
            kind: { type: "string", enum: ["graph", "node"] },
            document: {
              description: "The graph or node document; validated against schema/<kind> and harness-free.",
              type: "object",
            },
          },
        },
        DraftCreated: {
          type: "object",
          required: ["id", "kind", "name", "expires_at", "page_url", "install"],
          properties: {
            id: { type: "string", pattern: "^[0-9a-hjkmnp-tv-z]{26}$" },
            kind: { type: "string", enum: ["graph", "node"] },
            name: { type: "string", description: "The document's own name." },
            expires_at: { type: "string", format: "date-time" },
            page_url: { type: "string", format: "uri", description: "The /d/<id> page." },
            install: {
              type: "string",
              description: "The exact command: canopy graph install draft:<id> or canopy node install draft:<id>.",
            },
          },
        },
        Draft: {
          type: "object",
          required: ["kind", "document", "expires_at"],
          properties: {
            kind: { type: "string", enum: ["graph", "node"] },
            document: { type: "object" },
            expires_at: { type: "string", format: "date-time" },
          },
        },
        DraftInvalid: {
          type: "object",
          required: ["kind", "message", "status", "problems", "total"],
          properties: {
            kind: { type: "string", enum: ["invalid-document"] },
            message: { type: "string" },
            status: { type: "integer", enum: [400] },
            problems: {
              type: "array",
              description: "The first 20 problems, each with a JSON pointer.",
              items: {
                type: "object",
                required: ["path", "message"],
                properties: {
                  path: { type: "string", description: "A JSON pointer, e.g. #/nodes/0/config/platform." },
                  message: { type: "string" },
                },
              },
            },
            total: { type: "integer", description: "How many problems the document had, across all of them." },
          },
        },
        Error: {
          type: "object",
          required: ["kind", "message", "status"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "invalid-query",
                "invalid-path",
                "invalid-document",
                "invalid-body",
                "too-large",
                "rate-limited",
                "unavailable",
              ],
              description: "invalid-document answers 404 for a missing document; the rest name their status.",
            },
            message: { type: "string" },
            status: { type: "integer", enum: [400, 404, 413, 429, 503] },
          },
        },
        Indexing: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", enum: ["indexing"] },
          },
        },
        Blocked: {
          type: "object",
          required: ["error", "reason", "issue"],
          properties: {
            error: { type: "string", enum: ["blocked"] },
            reason: { type: "string" },
            issue: { type: "string" },
          },
        },
      },
    },
  };
}

/**
 * The agent-file router. A Response for the four files, NOT_AGENT_FILE
 * for anything else so `answer()` keeps routing as before. GET only,
 * like the pages: other methods fall through to the API and the
 * redirector, as does every other `/.well-known/*` path (a 404 there).
 */
export async function handleAgentFiles(
  req: Request,
  env: AgentEnv,
): Promise<Response | typeof NOT_AGENT_FILE> {
  if (req.method !== "GET") {
    return NOT_AGENT_FILE;
  }
  const pathname = new URL(req.url).pathname;
  if (pathname === "/robots.txt") {
    return new Response(ROBOTS_BODY, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }
  if (pathname === "/sitemap.xml") {
    return new Response(await sitemapBody(env), {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }
  if (pathname === "/.well-known/api-catalog") {
    return new Response(apiCatalogBody(), {
      status: 200,
      headers: {
        "content-type": "application/linkset+json",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      },
    });
  }
  if (pathname === "/api/openapi.json") {
    return new Response(`${JSON.stringify(openApiDocument(), null, 2)}\n`, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      },
    });
  }
  return NOT_AGENT_FILE;
}
