// SPDX-License-Identifier: Apache-2.0
/**
 * The GraphQL fixture: one answer shaped like a real catalogue repository,
 * three entry levels deep, so the authenticated indexer can be tested against
 * what GitHub actually returns.
 *
 * The official fixture holds the whole repository at once — 3 graphs, 9
 * nodes, 10 pattern pages with their figures and a `blocked.json` — which is
 * exactly the run the REST path could not finish inside the free plan's 50
 * subrequests. `snapshotBody` builds the same shape for any repository, so a
 * test can make one folder unreadable, drop a blob's text or omit the root
 * tree without inventing a second fixture language.
 */
import { type Stub } from "./fakes.js";
import { VALID_GRAPH_TEXT, VALID_NODE_TEXT } from "./documents-fixture.js";

/** The path every GraphQL call shares; the stub table matches on it. */
export const GRAPHQL_PATH = "api.github.com/graphql";

/** One document folder in the fixture: slug, document text, optional README. */
export interface SnapshotDoc {
  slug: string;
  /** The document file's text; null for a blob that answered without text. */
  text: string | null;
  /** Omit for a folder without a README. */
  readme?: string | null;
  /** False to answer the folder without its document file at all. */
  document?: boolean;
}

/** One pattern folder in the fixture: the page and the figure it names. */
export interface SnapshotPattern {
  slug: string;
  page: string;
  figure: string;
  figureName?: string;
}

/** What one repository's answer should hold. */
export interface SnapshotOptions {
  stars?: number | null;
  updated?: string | null;
  branch?: string;
  /** The removal list's text; omit to answer without a readable `blocked.json`. */
  blocked?: string | null;
  graphs?: SnapshotDoc[];
  nodes?: SnapshotDoc[];
  patterns?: SnapshotPattern[];
  /** The `errors` array of a partial answer, one message per entry. */
  errors?: string[];
}

function blob(name: string, text: string | null): unknown {
  return { name, type: "blob", object: { text } };
}

function tree(name: string, entries: unknown[]): unknown {
  return { name, type: "tree", object: { entries } };
}

/** One `graphs/<slug>` or `nodes/<slug>` folder with its document and README. */
function documentFolders(file: string, docs: SnapshotDoc[]): unknown[] {
  return docs.map((doc) =>
    tree(doc.slug, [
      ...(doc.document === false ? [] : [blob(file, doc.text)]),
      ...(doc.readme === undefined || doc.readme === null ? [] : [blob("README.md", doc.readme)]),
    ])
  );
}

/** One `patterns/<slug>.md` plus the figure its front matter names. */
function patternFolders(patterns: SnapshotPattern[]): unknown[] {
  return patterns.flatMap((pattern) => [
    blob(`${pattern.slug}.md`, pattern.page),
    blob(pattern.figureName ?? `${pattern.slug}.figure.json`, pattern.figure),
  ]);
}

/**
 * Build one `repository { object(expression: "HEAD:") }` answer. A folder
 * only appears when the fixture names it, so a repository with no `patterns/`
 * looks exactly like one GitHub does not have.
 */
export function snapshotBody(options: SnapshotOptions = {}): unknown {
  const entries: unknown[] = [];
  if (options.graphs !== undefined) {
    entries.push(tree("graphs", documentFolders("graph.json", options.graphs)));
  }
  if (options.nodes !== undefined) {
    entries.push(tree("nodes", documentFolders("node.json", options.nodes)));
  }
  if (options.patterns !== undefined) {
    entries.push(tree("patterns", patternFolders(options.patterns)));
  }
  if (options.blocked !== undefined && options.blocked !== null) {
    entries.push(blob("blocked.json", options.blocked));
  }
  return {
    data: {
      repository: {
        stargazerCount: options.stars === undefined ? 7 : options.stars,
        updatedAt: options.updated === undefined ? "2026-10-27T08:00:00Z" : options.updated,
        defaultBranchRef: { name: options.branch ?? "main" },
        object: { entries },
      },
    },
    ...(options.errors === undefined
      ? {}
      : { errors: options.errors.map((message) => ({ message })) }),
  };
}

/** One GraphQL stub, narrowed to the repository the request body names. */
export function graphqlStub(repo: string, body: unknown): Stub {
  return {
    url: GRAPHQL_PATH,
    status: 200,
    body,
    bodyIncludes: `"name":"${repo}"`,
  };
}

/** The empty discovery answer: one page that fits, and lists nothing. */
export function emptySearchStub(): Stub {
  return { url: "search/repositories", status: 200, body: { total_count: 0, items: [] } };
}

/** The three graphs the official fixture holds. */
export const OFFICIAL_GRAPH_SLUGS = ["graph-alpha", "graph-beta", "graph-gamma"];

/** The nine nodes the official fixture holds. */
export const OFFICIAL_NODE_SLUGS = [
  "node-alpha",
  "node-bravo",
  "node-charlie",
  "node-delta",
  "node-echo",
  "node-foxtrot",
  "node-golf",
  "node-hotel",
  "node-india",
];

/** The ten pattern pages the official fixture holds, figures included. */
export const PATTERN_SLUGS = [
  "pattern-alpha",
  "pattern-bravo",
  "pattern-charlie",
  "pattern-delta",
  "pattern-echo",
  "pattern-foxtrot",
  "pattern-golf",
  "pattern-hotel",
  "pattern-india",
  "pattern-juliet",
];

/** One well-formed pattern page naming its own figure. */
export function patternPage(slug: string): string {
  return [
    "---",
    `title: Page ${slug}`,
    `summary: What ${slug} describes.`,
    "status: standard",
    "implements: []",
    `figure: ${slug}.figure.json`,
    "sources:",
    "  - title: Canopy docs",
    "    url: https://univerlab.org/canopy/",
    "---",
    "",
    `The ${slug} page.`,
    "",
  ].join("\n");
}

/** The whole official repository as one GraphQL answer. */
export function officialSnapshotBody(overrides: SnapshotOptions = {}): unknown {
  return snapshotBody({
    stars: 7,
    updated: "2026-10-27T08:00:00Z",
    branch: "main",
    blocked: "[]",
    graphs: OFFICIAL_GRAPH_SLUGS.map((slug) => ({
      slug,
      text: VALID_GRAPH_TEXT,
      readme: `# ${slug}\n`,
    })),
    nodes: OFFICIAL_NODE_SLUGS.map((slug) => ({
      slug,
      text: VALID_NODE_TEXT,
      readme: `# ${slug}\n`,
    })),
    patterns: PATTERN_SLUGS.map((slug) => ({
      slug,
      page: patternPage(slug),
      figure: VALID_GRAPH_TEXT,
    })),
    ...overrides,
  });
}

/** The official answer as a stub, matched on `UniverLab/canopy-graphs`. */
export function officialSnapshotStub(overrides: SnapshotOptions = {}): Stub {
  return graphqlStub("canopy-graphs", officialSnapshotBody(overrides));
}

/** One community repository holding a graph called flow. */
export function communitySnapshotBody(overrides: SnapshotOptions = {}): unknown {
  return snapshotBody({
    stars: 2,
    updated: "2026-10-20T10:00:00Z",
    branch: "main",
    graphs: [{ slug: "flow", text: VALID_GRAPH_TEXT, readme: "# flow\n" }],
    ...overrides,
  });
}

/** The community answer as a stub, matched on `acme/things`. */
export function communitySnapshotStub(overrides: SnapshotOptions = {}): Stub {
  return graphqlStub("things", communitySnapshotBody(overrides));
}
