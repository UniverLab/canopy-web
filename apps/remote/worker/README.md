# remote.univerlab.org — blind signaling relay

A tiny Cloudflare Worker that connects a browser to the user's own Canopy
host over WebRTC. It does exactly two things: prove both ends belong to the
same GitHub account, and forward opaque signaling messages between them.

## Routes

| Route | Answer |
|---|---|
| `GET /auth/login` | 302 to GitHub's authorize page (identity only, no scope) |
| `GET /auth/callback` | exchanges the code, sets the `cr_session` cookie, 302 to `/` |
| `POST /auth/logout` | revokes the session server-side, clears the cookie, 303 to `/` |
| `GET /auth/me` | `{login}` for the session cookie, else 401 |
| `GET /ws/device` | upgrades a browser socket into the user's room (cookie) |
| `GET /ws/host` | upgrades a host socket into the user's room (GitHub token + id + label) |
| `GET /turn` | `{iceServers}`: Cloudflare TURN credentials plus STUN |

Anything else is the discovery files or the SPA fallback: `/llms.txt`,
`/sitemap.xml` and the well-known catalogue, ARD manifest and skills are
static documents (see Static assets below), extensionless paths serve the
app's `index.html` — or the markdown service summary when asked — while
unknown well-known probes and file paths no built asset holds answer `404`;
a defined path with the wrong method answers `405`. Every response carries
the relay's security headers
(CSP, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`).

One Durable Object (`UserRoom`) per GitHub user id forwards envelopes
between that user's devices and hosts: a device frame `{to:"h:<host_id>",
body}` reaches the host as `{from:"d:<conn>", body}`, and back. Devices
also get `{t:"hosts"}` whenever the host list changes. Caps per room:
frames over 64 KiB are dropped, 8 device sockets at most, 8 guest sockets
at most, 20 `pair_init` bodies per 10 minutes, and 30 frames per 10
seconds per socket — past the budget the socket closes with 4009. Guests
connect only when the host invited their uid (`{"t":"guest_allow",
"uids":[...]}` over the host-to-room path, empty denies all), one socket
per guest login, and a republished list closes every connected guest it
drops with 4003 (`not_invited`), announced to the hosts as `device_left`.
A replaced host socket closes with 4000 (`replaced`).

## What it stores

One KV namespace, `SESSION_REVOKED`: logout writes the session's jti here
(jti → exp, TTL 43200 like the session itself) and verification refuses
revoked jtis. Nothing else persists — no D1, no R2. Room state is
per-socket attachments plus the guest allowlist and pair-init counters in
Durable Object storage, so an evicted room wakes with its state intact;
connection ids are random UUIDs, never reused. The GitHub token is
discarded after `/user`, and host token verifications live at most 5
minutes in isolate memory.

## Tests

```sh
npm run test:remote-worker     # apps/remote/worker suite, in the Workers runtime via Miniflare
```

The suite covers session sign/verify and tamper rejection, OAuth state
mismatch, host checks with a mocked GitHub, routing both ways, the hosts
list on connect/disconnect, host replacement, every limit, `/turn` with a
mocked Cloudflare API, and that room state survives an eviction.
`npm test` runs it together with the validator and catalogue suites. Tests
use injected fakes (`apps/remote/worker/test/fakes.ts`), never stubbed
globals.

## One-time setup (before the first deploy)

1. **Create the GitHub OAuth App** — owner `UniverLab`, callback
   `https://remote.univerlab.org/auth/callback`. It needs no scopes:
   identity only.
2. **Bind the custom domain** — Workers & Pages → `canopy-remote` →
   Settings → Domains & Routes → *Custom Domain* →
   `remote.univerlab.org` (Cloudflare provisions the TLS certificate).
3. **Set the Worker secrets** — from `apps/remote/worker/`:
   `wrangler secret put` for `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `SESSION_SECRET`, `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` (the last two
   from a Cloudflare Realtime TURN key). Never in the repo.
4. **Create the revocation namespace** — from `apps/remote/worker/`:
   `wrangler kv namespace create SESSION_REVOKED`, then put the returned
   id in `wrangler.toml` (it ships as `REPLACE_WITH_SESSION_REVOKED_KV_ID`).
   Until then logout only clears the cookie.
5. **Set the repository secret** — `CLOUDFLARE_API_TOKEN`, a token with
   *Edit Workers*. The account id is inlined in `wrangler.toml`, so no
   second secret is needed.

## Static assets

The Worker serves the built browser app (`apps/remote/web/dist`) through the
`[assets]` binding in `wrangler.toml`: `/` and any extensionless path serve
the app (the Worker fetches `index.html` through the `ASSETS` binding, so
`/pair` keeps working, with the agent Link header on the document), while
unknown well-known probes and file paths no built asset holds answer `404`.
`/`, `/auth/*`, `/ws/*`, `/turn` and `/.well-known/*` always reach the
Worker code (`run_worker_first`) — `/` rides with the Worker so the document
carries the Link header and answers markdown when asked. The discovery files
(`/llms.txt`, `/sitemap.xml`, the API catalogue, the ARD manifest, the Agent
Skills index and the skills) are static documents the Worker embeds; there is
no MCP card (canopy mcp is a local stdio server, and a card needs a remote
URL). Responses built by the Worker get the security headers from
`src/protocol.ts`; asset responses get the identical headers from the
`_headers` file in `apps/remote/web/public/`, which the deploy workflow keeps
in sync by running `npm run build:remote-web` before `wrangler deploy`.

## Deploy

`.github/workflows/release.yml`, run by hand on `main`: in the trunk-based flow
nothing deploys on merge. It runs CI again, deploys this Worker and the graphs
Worker together, then creates the tag and the GitHub release from the version
in the root `package.json`. To release, bump that version by PR, then:

```sh
gh workflow run release.yml --ref main
```

`.github/workflows/deploy-remote.yml` deploys this Worker alone (`workflow_dispatch`).
