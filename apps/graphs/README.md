# graphs.univerlab.org — install redirector

A tiny Cloudflare Worker that gives catalogue documents a clean install URL:

```sh
curl -fsSL https://graphs.univerlab.org/i/graph/hello-graph
canopy graph install hello-graph      # what Canopy does under the hood
```

It **only 302-redirects** to the document on GitHub. The Worker never fetches
or proxies the document, so GitHub stays the download origin and the trust
anchor — this Worker is just a prettier doorway.

## Routes

| Route | Where it points |
|---|---|
| `GET /i/<kind>/<slug>` | official: `https://raw.githubusercontent.com/UniverLab/canopy-graphs/<ref>/<kind>s/<slug>/<kind>.json` |
| `GET /i/<owner>/<repo>/<kind>/<slug>` | community: `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<kind>s/<slug>/<kind>.json` |

- `<kind>` is `graph` or `node`.
- `?ref=` selects a branch, tag or commit sha; it defaults to `HEAD` (the
  default branch).
- Every path segment is validated (GitHub owner/repo rules, the schema's
  `^[a-z0-9-]{1,48}$` slug rule, a URL-safe ref). A malformed install
  answers `400` with a one-line reason; any other unknown path answers
  `404` with the same one-line usage reason, and `GET /i/` answers `404`
  with the usage text.

Official documents are the ones in [UniverLab/canopy-graphs](https://github.com/UniverLab/canopy-graphs),
the public catalogue repository — an ordinary catalogue repository with the
`canopy-graph` topic, so `/i/graph/hello-graph` and the community form
`/i/UniverLab/canopy-graphs/graph/hello-graph` point at the same file.

## What it counts

One aggregate data point per request, via
[Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/):

| Field | Example | Why |
|---|---|---|
| index | `UniverLab/canopy-graphs/graph/hello-graph` | which document is installed |
| kind | `graph` / `node` | graphs vs nodes |
| document | `UniverLab/canopy-graphs/hello-graph` | document, without repeating the kind |
| client | `canopy`, `curl`, `browser`, `other` | a real install, a script, or someone looking |
| canopy version | `1.7.2` | which Canopy release installs what |
| country | `CO` | rough geography |
| outcome | `redirect` / `bad-request` | 400s and 404s show what people expected to exist |

**Not recorded**: IP addresses, full user-agents, cookies, anything tied to a
person. The client class is a coarse bucket, not the raw header.

The write is fire-and-forget inside a `try/catch`: if the binding is missing
(local dev) or Analytics Engine is down, the redirect still happens.

## JSON API (the catalogue's read surface)

Pages and agents read a JSON view of the catalogue; GitHub is still the
database, the Cache API is still the only state:

| Route | Answer |
|---|---|
| `GET /api/official` | `{graphs, nodes}` — the official repository listing |
| `GET /api/search?q=&sort=top\|new&page=` | `{items, q, sort, page, total, truncated}` — `topic:canopy-graph` plus free text |
| `GET /api/g/<owner>/<repo>/<slug>` | one graph document, validated JSON attached |
| `GET /api/n/<owner>/<repo>/<slug>` | one node document, validated JSON attached |
| `GET /api/index-status` | the last index run's accounting (invalid trimmed to 20) |
| `GET /api/openapi.json` | OpenAPI 3.1 description of the five routes above |

The `g`/`n` in a single-document route is the kind asked for: a slug that only
exists under the other kind is a typed `404`, never a document of the wrong
kind.

Every answer carries `access-control-allow-origin: *` (GET only, OPTIONS →
204) and short cache-control (60 s for search, 300 s otherwise). Errors are
typed JSON bodies — `{kind, message, status, retryAfter?}` with kinds
`rate-limit` (429), `not-found`/`invalid-document` (404), `upstream` (502),
`invalid-path`/`invalid-query` (400) — so nothing the Worker fails at can
turn into a 500 for an agent to choke on. `downloads` (90-day install
counts) is attached when `CF_ACCOUNT_ID` + `CF_ANALYTICS_TOKEN` are set, and
absent when not: counts are never zero-filled.

## Agent discovery

The catalogue is a public index agents should read, so it speaks the same
discovery dialect as univerlab.org (same robots wording, same `Link` shape):

| Route | Answer |
|---|---|
| `GET /robots.txt` | crawl the catalogue, skip `/i/`; `Content-Signal` grants search and input, not training (third parties authored the documents) |
| `GET /sitemap.xml` | `/`, `/search`, `/publish`, `/llms.txt` plus every indexed document's page, from the scheduled index — never GitHub |
| `GET /.well-known/api-catalog` | RFC 9727 linkset: the OpenAPI description, the Publish docs, the index status |

Every HTML page carries
`Link: </llms.txt>; rel="describedby"; type="text/plain", </.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
and every other `/.well-known/*` path answers `404`. The four files live in
`src/agent-files.ts`, checked before the API router.

## Tests

```sh
npm run test:worker     # apps/graphs suite, in the Workers runtime via Miniflare
```

The suite covers both route shapes, `?ref=`, every 400 case, the `/i/` usage
page, the data point written for each outcome, and that a throwing or missing
binding still serves the redirect, plus the API surface above: official
listing, search with text and both orderings, invalid documents dropped, a
cache hit on a second call, rate limits surfaced as typed errors, and counts
present and absent. `npm test` runs it together with the document validator
suite. The API tests use injected fakes (`apps/graphs/test/fakes.ts`),
never stubbed globals.

## One-time setup (before the first deploy)

1. **Enable Analytics Engine on the account** — dash.cloudflare.com →
   *Storage & databases* → *Analytics Engine*. It is an account-level opt-in
   and not under *Compute/Workers*, despite where the deploy error links. Until
   it is enabled, a deploy that declares the binding fails with `code: 10089`,
   whatever the token's permissions. The dataset `canopy_graph_installs` needs
   no provisioning: it is created on the first write.
2. **Bind the custom domain** — Workers & Pages → `canopy-graphs` → Settings →
   Domains & Routes → *Custom Domain* → `graphs.univerlab.org` (Cloudflare
   provisions the TLS certificate).
3. **Set the repository secret** — `CLOUDFLARE_API_TOKEN`, a token with
   *Edit Workers*. The account id is inlined in `wrangler.toml`, so no second
   secret is needed.

## Deploy

`.github/workflows/deploy.yml`, **manual only** (`workflow_dispatch`): in the
trunk-based flow nothing deploys on merge. To deploy by hand:

```sh
cd worker
npx wrangler deploy --dry-run    # check the bundle and the binding
npx wrangler deploy
```

Reading the counts is deliberately not in this repo: Analytics Engine has no
dashboard, only the SQL API, and that needs a long-lived read token — which
does not belong on a laptop. Use the Cloudflare SQL API with
`SUM(_sample_interval)` (not `COUNT(*)`: the dataset is sampled under load).
