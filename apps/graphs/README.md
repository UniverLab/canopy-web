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
database for published documents and the Cache API is still the read cache.
The only values the Worker itself writes are drafts (below), in their own
namespace and for 30 minutes:

| Route | Answer |
|---|---|
| `GET /api/official` | `{graphs, nodes}` — the official repository listing |
| `GET /api/search?q=&sort=top\|new&page=` | `{items, q, sort, page, total, truncated}` — `topic:canopy-graph` plus free text |
| `GET /api/g/<owner>/<repo>/<slug>` | one graph document, validated JSON attached |
| `GET /api/n/<owner>/<repo>/<slug>` | one node document, validated JSON attached |
| `GET /api/index-status` | the last index run's accounting (invalid trimmed to 20) |
| `GET /api/openapi.json` | OpenAPI 3.1 description of every route in this table |
| `POST /api/drafts` | `{id, kind, name, expires_at, page_url, install}` — store a draft for 30 minutes |
| `GET /api/drafts/<id>` | `{kind, document, expires_at}` — the stored draft, never consumed |

The `g`/`n` in a single-document route is the kind asked for: a slug that only
exists under the other kind is a typed `404`, never a document of the wrong
kind.

Every answer carries `access-control-allow-origin: *` (GET and POST only, OPTIONS →
204) and short cache-control (60 s for search, 300 s otherwise; `no-store`
for drafts and errors). Errors are typed JSON bodies —
`{kind, message, status, retryAfter?}` with kinds `rate-limit` (429),
`not-found`/`invalid-document` (404), `upstream` (502),
`invalid-path`/`invalid-query`/`invalid-body` (400), drafts' `too-large`
(413), `rate-limited` (429) and `unavailable` (503) — so nothing the Worker fails at can
turn into a 500 for an agent to choke on. `downloads` (90-day install
counts) is attached when `CF_ACCOUNT_ID` + `CF_ANALYTICS_TOKEN` are set, and
absent when not: counts are never zero-filled.

## The scheduled index (and the free plan's subrequest and write budgets)

A Cron Trigger rebuilds the catalogue every 15 minutes (`*/15 * * * *`, in
`wrangler.toml`) into KV: one entry per listed document, its validated JSON
and README, and the removal list. The request path reads only KV (plus the
bundled pattern pages below), so traffic never spends GitHub quota.

The Worker runs on the Workers **Free** plan: one invocation may spend **50
subrequests**, and a Cache API lookup or store is one of them. The indexer
therefore keeps to a single constant, `SUBREQUEST_BUDGET = 45` in
`src/indexer.ts` — the plan's 50 minus the margin the KV writes and the
answer need — which caps **every** outbound call of one run: GitHub REST,
GraphQL and the discovery search.

| Run | Transport | Cost of the official repository |
|---|---|---|
| `GITHUB_TOKEN` set | one `POST https://api.github.com/graphql` per repository | 1 subrequest for every document and README |
| no token | REST contents and raw URLs | 2–4 calls per folder, so the budget may stop it early |

KV has a budget too, and it is the tighter one: the Free plan allows **1,000
KV writes a day** per account, while the cron wakes 96 times. So the indexer
fingerprints what it writes — one SHA-256 digest per key in `index:hashes:v1`
(`src/hashes.ts`) — and skips any put whose value is unchanged;
`index:v1` is fingerprinted without its `built_at`, so
an untouched catalogue keeps its timestamp and a whole run costs **one write**
(`index:meta`, which shows `kv_writes` and `kv_skipped` at
`/api/index-status`).

The GraphQL query asks for the two top-level folders (`graphs/`, `nodes/`)
and `blocked.json`, three entry levels deep, and nothing else in
the repository. The scheduled transport is built with `cache: null`, so the
cron path never touches the Cache API — the request path keeps its cache
exactly as before.

When the budget, a rate limit or an unreadable answer stops a run, it still
writes what it read, **carries over** the previous entries of every
repository it did not reach, and never shrinks the catalogue. `GET
/api/index-status` shows `subrequests` (the calls spent) and `stopped` (why
the run ended early, or `null`), so a truncated run is visible without
`wrangler tail`.

The visit is incremental: one KV key, `index:repos:v1`, remembers each
repository's `pushed_at` and when a run last visited it, and a run visits
only the repositories that changed or were never read — pending ones oldest
visit first (never visited before anything else), so a run cut short by the
budget is resumed by the next one and no repository starves, while an
unchanged catalogue costs the official read plus discovery. Unchanged
repositories keep their entries with a star count refreshed from the search
hit at no cost; the official repository is still read in full on every run.
`GET /api/index-status` shows `repos_visited` (visited this run),
`repos_unchanged` (skipped) and `repos_pending` (left for later runs), and
`truncated` is true while any repository is still pending.

## Pattern pages

The `/patterns` pages are editorial content of this site, authored in this
repo under `apps/graphs/patterns/`: one `<slug>.md` (front matter plus a
markdown body) plus the `<slug>.figure.json` its `figure:` key names — a
harness-free graph document the plate renderer draws. The front matter
carries exactly six keys (`title`, `summary`, `status`, `implements`,
`figure`, `sources`); the strict shape lives in `src/patterns.ts`.

`npm run build:patterns` validates every page with those same rules and
regenerates the committed `src/patterns-data.generated.ts` the pages
render from. A malformed page, a missing figure, or a figure that fails
the graph schema fails the build — patterns are never fetched from
GitHub and never touch the indexer's quota. `tests/patterns-build.test.ts`
fails when the generated module is stale, so editing a page without
rebuilding is caught.

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

## Drafts (share without a repository)

A graph or node can be shared without creating a repo: `POST /api/drafts`
stores a validated, harness-free document for **30 minutes** and answers what
the other machine needs.

| Route | Answer |
|---|---|
| `POST /api/drafts` | `{id, kind, name, expires_at, page_url, install}` (201); body `{kind, document}`, at most 256 KiB |
| `GET /d/<id>` | the same document page as `/g` and `/n`, with an **unreviewed draft** banner; never consumes |
| `GET /api/drafts/<id>` | `{kind, document, expires_at}`; never consumes, so the editor can reopen it |
| `GET /i/draft/<id>` | the document JSON, `Cache-Control: no-store`, and then the draft is deleted |

The id is 128 random bits from `crypto.getRandomValues`, lowercase Crockford
base32 (26 characters, no padding). The document goes through the same
validator `npm run validate` uses, plus the harness-free rule: `platform`,
`model` and `cli` are refused (in a node's config, in a graph node's config and
in an ensemble member). A body over 256 KiB is a 413; an invalid document is a
400 whose `problems[]` carries each JSON pointer. `POST /api/drafts` is limited
to 10 per minute per client IP by a Workers rate-limiting binding, and answers
429 with `Retry-After` beyond that. Draft pages carry `noindex` and never appear
in search, `/llms.txt` or `/sitemap.xml`.

Drafts are the one deliberate exception to "the Worker never serves
documents": they are short-lived, labelled unreviewed, and validated before
they are stored, so GitHub stays the download origin for everything published.
**KV deletes are eventually consistent**, so "one use" is best effort: the
install deletes the key, but a second install within about a minute can still
read it, and the key expires on its own at 30 minutes regardless.

A draft with an unknown, spent or expired id answers 404 with a page that says
drafts last 30 minutes or one install. Storage lives in `src/drafts.ts`; the
`/d` page renders through the document page renderer in `src/pages/routes.ts`
rather than a second template.

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
never stubbed globals. `drafts.test.ts` covers the whole draft path: create,
read, install, gone; the 1800-second TTL; invalid documents with their paths;
harness bindings; the 413 and the 429; the page banner, `noindex` and the
promise that viewing never consumes; and that no draft reaches search,
`llms.txt` or the sitemap.

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
