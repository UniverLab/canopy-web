// SPDX-License-Identifier: Apache-2.0
/**
 * The Publish page: the route and its markdown twin, rendered from the
 * code's own values. Every expected path, command, topic and minute is
 * composed here from the same constants the page reads — retyped
 * strings would let the page and the code drift apart silently.
 */
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { TTL } from "../src/github.js";
import { OFFICIAL_REPOSITORY, SLUG_PATTERN, documentPrefix } from "../src/lib.js";
import { communityDir, documentFile } from "../src/documents.js";
import { CATALOGUE_TOPIC } from "../src/search.js";
import {
  EXPORT_GRAPH_COMMAND,
  PUBLISH_BARE_KEYS,
  PUBLISH_CHECK_HEADING,
  PUBLISH_DESCRIPTION,
  PUBLISH_EXAMPLE_GRAPH,
  PUBLISH_EXAMPLE_NODE,
  PUBLISH_EXAMPLE_OWNER,
  PUBLISH_EXAMPLE_REPO,
  PUBLISH_HREF,
  PUBLISH_INSTALL_HEADING,
  PUBLISH_LABEL,
  PUBLISH_LEDE,
  PUBLISH_NODE_FIELDS,
  PUBLISH_OFFICIAL_HEADING,
  PUBLISH_PLACE_HEADING,
  PUBLISH_SHARE_HEADING,
  PUBLISH_TITLE,
  PUBLISH_TOPIC_HEADING,
  PUBLISH_WHEN_HEADING,
  SCHEMA_GRAPH_URL,
  SCHEMA_NODE_URL,
  VALIDATE_GRAPH_PREFIX,
  homePublishLine,
  installCommand,
} from "../src/pages/copy.js";
import { NOT_PAGE, handlePage } from "../src/pages/routes.js";
import { escapeHtml } from "../src/pages/md.js";
import { FakeCache, fakeFetch } from "./fakes.js";
import { officialStubs } from "./stubs.js";

const ORIGIN = "https://graphs.univerlab.org";

/** The seven sections, in the order the page must carry them. */
const STEPS = [
  PUBLISH_SHARE_HEADING,
  PUBLISH_PLACE_HEADING,
  PUBLISH_TOPIC_HEADING,
  PUBLISH_CHECK_HEADING,
  PUBLISH_WHEN_HEADING,
  PUBLISH_INSTALL_HEADING,
  PUBLISH_OFFICIAL_HEADING,
];

async function call(path: string, accept?: string): Promise<Response> {
  const fake = fakeFetch(officialStubs());
  const headers = new Headers();
  if (accept !== undefined) {
    headers.set("accept", accept);
  }
  const answer = await handlePage(new Request(`${ORIGIN}${path}`, { headers }), {}, {
    fetchImpl: fake.fetchImpl,
    cache: new FakeCache(),
  });
  expect(answer).not.toBe(NOT_PAGE);
  return answer as unknown as Response;
}

describe("the publish route", () => {
  it("serves /publish in the catalogue shell", async () => {
    const response = await call("/publish");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain(`<title>${PUBLISH_TITLE} · graphs.univerlab.org</title>`);
    expect(html).toContain(`<meta name="description" content="${PUBLISH_DESCRIPTION}">`);
    expect(html).toContain(`<h1 class="doc-title">${PUBLISH_TITLE}</h1>`);
    expect(html).toContain(PUBLISH_LEDE);
    expect(html).toContain(`<a href="${PUBLISH_HREF}">${PUBLISH_LABEL}</a>`);
  });

  it("serves /publish through the deployed Worker, not the redirector", async () => {
    const response = await worker.fetch(new Request(`${ORIGIN}/publish`), {});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain(`<h1 class="doc-title">${PUBLISH_TITLE}</h1>`);
  });

  it("carries the seven steps in order", async () => {
    const html = await (await call("/publish")).text();
    for (const step of STEPS) {
      expect(html).toContain(`<h2 class="kicker">${step}</h2>`);
    }
    const order = STEPS.map((step) => html.indexOf(step));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("the page states the code's own values", () => {
  it("renders the cache minutes from TTL.search", async () => {
    const html = await (await call("/publish")).text();
    const minutes = TTL.search / 60;
    expect(html).toContain(`for <code>${minutes} minutes</code>`);
  });

  it("states the paths the search actually reads", async () => {
    const html = await (await call("/publish")).text();
    const graphPath = `${communityDir("graph")}/<slug>/${documentFile("graph")}`;
    const nodePath = `${communityDir("node")}/<slug>/${documentFile("node")}`;
    expect(html).toContain(`<code>${escapeHtml(graphPath)}</code>`);
    expect(html).toContain(`<code>${escapeHtml(nodePath)}</code>`);
    expect(html).toContain(`<code>${SLUG_PATTERN}</code>`);
  });

  it("names the topic the search queries and the public-repo rule", async () => {
    const html = await (await call("/publish")).text();
    expect(html).toContain(`<code>${CATALOGUE_TOPIC}</code> topic`);
    expect(html).toContain("The repo must be public.");
  });

  it("prints the install commands as the document pages print them", async () => {
    const html = await (await call("/publish")).text();
    const graphRef = `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_GRAPH}`;
    const nodeRef = `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_NODE}`;
    expect(html).toContain(installCommand("graph", graphRef));
    expect(html).toContain(installCommand("node", nodeRef));
  });

  it("prints the export and validate commands from their constants", async () => {
    const html = await (await call("/publish")).text();
    const examplePath = `${communityDir("graph")}/${PUBLISH_EXAMPLE_GRAPH}/${documentFile("graph")}`;
    expect(html).toContain(EXPORT_GRAPH_COMMAND);
    expect(html).toContain(`${VALIDATE_GRAPH_PREFIX} ${examplePath}`);
  });

  it("puts every command in a code box with a Copy button", async () => {
    const html = await (await call("/publish")).text();
    const examplePath = `${communityDir("graph")}/${PUBLISH_EXAMPLE_GRAPH}/${documentFile("graph")}`;
    const graphRef = `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_GRAPH}`;
    const nodeRef = `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_NODE}`;
    for (const command of [
      EXPORT_GRAPH_COMMAND,
      `${VALIDATE_GRAPH_PREFIX} ${examplePath}`,
      installCommand("graph", graphRef),
      installCommand("node", nodeRef),
    ]) {
      expect(html).toContain(`<code>${command}</code>`);
      expect(html).toContain(`data-copy="${command}"`);
    }
  });

  it("describes the documents without retyping their shape", async () => {
    const html = await (await call("/publish")).text();
    expect(html).toContain(documentFile("graph"));
    expect(html).toContain(documentFile("node"));
    for (const field of [...PUBLISH_NODE_FIELDS, ...PUBLISH_BARE_KEYS]) {
      expect(html).toContain(field);
    }
  });

  it("links the schemas and the official registry from their constants", async () => {
    const html = await (await call("/publish")).text();
    expect(html).toContain(`href="${SCHEMA_GRAPH_URL}"`);
    expect(html).toContain(`href="${SCHEMA_NODE_URL}"`);
    expect(html).toContain(OFFICIAL_REPOSITORY);
    expect(html).toContain(documentPrefix());
  });
});

describe("the markdown twin", () => {
  it("answers Accept: text/markdown with the twin, no HTML", async () => {
    const response = await call("/publish", "text/markdown");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const twin = await response.text();
    expect(twin).toContain(`# ${PUBLISH_TITLE}`);
    expect(twin).not.toContain("<p>");
    expect(twin).not.toContain("<code>");
  });

  it("serves the same twin at /publish.md", async () => {
    const viaHeader = await (await call("/publish", "text/markdown")).text();
    const response = await call("/publish.md");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe(viaHeader);
  });

  it("carries the same steps, paths and commands", async () => {
    const twin = await (await call("/publish.md")).text();
    for (const step of STEPS) {
      expect(twin).toContain(`## ${step}`);
    }
    const order = STEPS.map((step) => twin.indexOf(step));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const graphPath = `${communityDir("graph")}/<slug>/${documentFile("graph")}`;
    const nodePath = `${communityDir("node")}/<slug>/${documentFile("node")}`;
    const examplePath = `${communityDir("graph")}/${PUBLISH_EXAMPLE_GRAPH}/${documentFile("graph")}`;
    const graphRef = `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_GRAPH}`;
    const nodeRef = `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_NODE}`;
    for (const value of [
      graphPath,
      nodePath,
      SLUG_PATTERN,
      CATALOGUE_TOPIC,
      `for \`${TTL.search / 60} minutes\``,
      EXPORT_GRAPH_COMMAND,
      `${VALIDATE_GRAPH_PREFIX} ${examplePath}`,
      installCommand("graph", graphRef),
      installCommand("node", nodeRef),
      SCHEMA_GRAPH_URL,
      SCHEMA_NODE_URL,
      OFFICIAL_REPOSITORY,
    ]) {
      expect(twin).toContain(value);
    }
  });

  it("lists the page in the home twin", async () => {
    const twin = await (await call("/", "text/markdown")).text();
    expect(twin).toContain(`## ${PUBLISH_TITLE}`);
    expect(twin).toContain(homePublishLine(PUBLISH_LABEL, PUBLISH_HREF));
    expect(twin).toContain(PUBLISH_HREF);
  });
});
