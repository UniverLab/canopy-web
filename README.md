# graphs.univerlab.org catalogue

Shareable Canopy documents live here. Two kinds:

- **Graphs** — a graph's portable design (`GraphExportDocument`,
  format version 6): name, nodes, edges, ensembles, hooks, infra node,
  bundled presets. Published under `graphs/<slug>/graph.json`.
- **Nodes** — a single reusable node or ensemble (`format_version: 1`):
  name, kind (`agent` | `check` | `gate` | `ensemble`), description,
  config, optional preset. Published under `nodes/<slug>/node.json`.

## Document layout

```text
graphs/
  schema/
    graph.schema.json   # the graph contract (v6, bundled presets)
    node.schema.json     # the node contract (v1)
  src/
    schema.ts           # imports the schemas, never copies them
    slug.ts             # slug rule helpers
    validate.ts         # `npm run validate` (CLI + library)
  registry/
    graphs/<slug>/graph.json + README.md
    nodes/<slug>/node.json + README.md
  worker/               # Cloudflare Worker serving the catalogue
  tests/                # vitest suite + fixtures
```

Every document folder must contain a `README.md`, and the folder name
must equal the document's slug-safe `name` (`^[a-z0-9-]{1,48}$`).

## How to publish

1. Put the document at `registry/graphs/<slug>/graph.json` (graphs) or
   `registry/nodes/<slug>/node.json` (nodes), where `<slug>` matches the
   document's `name`.
2. Add a `README.md` beside it describing what the document does.
3. Add the `canopy-graph` topic to the GitHub repository.
4. Run `npm run validate` — it must pass.

## Commands

| Script            | What it does                                    |
| ----------------- | ----------------------------------------------- |
| `npm run lint`    | eslint over the repo                            |
| `npm run typecheck` | `tsc --noEmit` (strict)                       |
| `npm test`        | vitest suite (documents + worker)                |
| `npm run test:worker` | worker suite only, in the Workers runtime    |
| `npm run validate [paths...]` | validate registry documents (files or folders; no args = all of `registry/`) |

The schemas in `schema/` are the single contract the worker and
Canopy's `graph validate` agree on — import them, never copy them.

## Worker deploy

The install redirector lives in `worker/` (Cloudflare Worker
`canopy-graphs`, behind `graphs.univerlab.org`). Deploys are manual only
(`.github/workflows/deploy.yml`, `workflow_dispatch`). Before the first
deploy, follow the one-time setup in [worker/README.md](worker/README.md):
enable Analytics Engine on the account, bind the custom domain, and set
`CLOUDFLARE_API_TOKEN`.
