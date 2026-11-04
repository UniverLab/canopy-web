<p align="center">
  <img src="https://raw.githubusercontent.com/UniverLab/.github/main/assets/banner-canopy-web.svg" alt="Canopy Web"/>
</p>

<p align="center">
  <a href="https://github.com/UniverLab/canopy-web/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/UniverLab/canopy-web/ci.yml?style=for-the-badge&label=CI" alt="CI"/></a>
  <a href="https://github.com/UniverLab/canopy-web/releases"><img src="https://img.shields.io/github/v/release/UniverLab/canopy-web?style=for-the-badge&color=3CC7BD" alt="Release"/></a>
  <img src="https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"/>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-2E8B57?style=for-the-badge" alt="License"/></a>
</p>

<p align="center">
  <a href="https://graphs.univerlab.org"><b>graphs.univerlab.org</b></a> ·
  <a href="https://remote.univerlab.org"><b>remote.univerlab.org</b></a> ·
  <a href="https://github.com/UniverLab/harness-canopy">Canopy</a> ·
  <a href="https://univerlab.org/canopy/">Docs</a>
</p>

The web side of [Canopy](https://github.com/UniverLab/harness-canopy), the graph
engine for AI coding agents: one repository with one app per subdomain, each its
own Cloudflare Worker with its own secrets and origin.

| App | Where | What it does |
| --- | --- | --- |
| [Graphs](apps/graphs/README.md) | [graphs.univerlab.org](https://graphs.univerlab.org) | Browse, share and install graph and node designs, each with its plate, its README and every prompt in full. |
| [Remote](apps/remote/README.md) | [remote.univerlab.org](https://remote.univerlab.org) | Reach your Canopy sessions from any browser, over an encrypted peer-to-peer link: drive a terminal, compose or schedule a prompt, copy its text, watch your graphs, invite a guest. |

```sh
curl -fsSL https://raw.githubusercontent.com/UniverLab/harness-canopy/main/scripts/install.sh | sh
canopy remote login   # sign in with GitHub
canopy remote pair    # a code and a QR for remote.univerlab.org
```

---

## Graphs catalogue

Official documents live in
[UniverLab/canopy-graphs](https://github.com/UniverLab/canopy-graphs), the
public catalogue repository — the same layout any community repo uses.
Two kinds:

- **Graphs** — a graph's portable design (`GraphExportDocument`,
  format version 6): name, nodes, edges, ensembles, hooks, infra node,
  bundled presets. Published under `graphs/<slug>/graph.json`.
- **Nodes** — a single reusable node or ensemble (`format_version: 1`):
  name, kind (`agent` | `check` | `gate` | `ensemble`), description,
  config, optional preset. Published under `nodes/<slug>/node.json`.

## Document layout

```text
canopy-web/
  schema/
    graph.schema.json   # the graph contract (v6, bundled presets)
    node.schema.json     # the node contract (v1)
  src/
    schema.ts           # imports the schemas, never copies them
    slug.ts             # slug rule helpers
    validate.ts         # `npm run validate` (CLI + library)
  apps/graphs/          # Cloudflare Worker serving the catalogue
  tests/                # vitest suite + fixtures
```

Every document folder must contain a `README.md`, and the folder name
must equal the document's slug-safe `name` (`^[a-z0-9-]{1,48}$`).

## How to publish

To list a graph or node from your own repo, follow the Publish page:
https://graphs.univerlab.org/publish — any public repo with the
`canopy-graph` topic is listed.

Official documents live in UniverLab/canopy-graphs and are proposed by
pull request there. The quickest way to start a graphs repo is to fork
canopy-graphs or use it as a template.

## Commands

| Script            | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `npm run lint`    | eslint over the repo                            |
| `npm run typecheck` | `tsc --noEmit` (strict)                       |
| `npm test`        | vitest suite (documents + worker)                |
| `npm run test:worker` | worker suite only, in the Workers runtime    |
| `npm run validate [paths...]` | validate document folders (files or folders; no args = this repo's example documents under `apps/graphs/test/fixtures/`) |

The schemas in `schema/` are the single contract the worker and
Canopy's `graph validate` agree on — import them, never copy them.

## Worker deploy

The install redirector lives in `apps/graphs/` (Cloudflare Worker
`canopy-graphs`, behind `graphs.univerlab.org`). Deploys are manual only
(`.github/workflows/deploy.yml`, `workflow_dispatch`). Before the first
deploy, follow the one-time setup in [apps/graphs/README.md](apps/graphs/README.md):
enable Analytics Engine on the account, bind the custom domain, and set
`CLOUDFLARE_API_TOKEN`.
