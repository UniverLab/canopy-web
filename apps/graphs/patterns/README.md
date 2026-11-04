# Pattern pages

The `/patterns` pages are editorial content of the graphs site, authored
here — not in the catalogue repository. One page is two files:

- `patterns/<slug>.md` — front matter plus a markdown body
- `patterns/<slug>.figure.json` — the harness-free graph document the
  plate renderer draws, named by the page's own `figure:` key

The front matter carries exactly six keys (`title`, `summary`, `status`,
`implements`, `figure`, `sources`); the strict shape lives in
`apps/graphs/src/patterns.ts` (`parsePatternFile`), which is also what
validates these files.

`npm run build:patterns` validates every page with those same rules and
regenerates the committed `apps/graphs/src/patterns-data.generated.ts`
the pages render from. A malformed page, a missing figure, a figure that
fails the graph schema, or an unreferenced file fails the build — and
`tests/patterns-build.test.ts` fails when the generated module is stale,
so editing here without rebuilding is caught.

The initial set was copied byte-identical from `patterns/` in
UniverLab/canopy-graphs at `1a05a8b19205dc03cdc28b26400f7d6444f15741`.
