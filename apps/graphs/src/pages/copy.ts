// SPDX-License-Identifier: Apache-2.0
/**
 * Every English string the catalogue pages render.
 *
 * The pages are template functions over this module: no other file in
 * `pages/` holds page prose, so a Spanish version follows by swapping this
 * one file. The few string *shapes* (an install command, an llms.txt line)
 * live here too, next to the words they are made of.
 */
import type { DocumentKind } from "../../../../src/schema.js";
import type { Doc } from "../documents.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO } from "../lib.js";

/** The site's name, in the page titles. */
export const SITE_NAME = "graphs.univerlab.org";

/** Suffix for `<title>`: "hello-graph · graphs.univerlab.org". */
export const TITLE_SEPARATOR = " · ";

/** The catalogue in one line: the home's hero, and the meta description. */
export const TAGLINE = "A catalogue of Canopy graphs and nodes.";

/** The header's wordmark, set in the mono face. */
export const WORDMARK = "graphs";

/** The Canopy page the wordmark links back to. */
export const CANOPY_HREF = "https://univerlab.org/canopy/";

/** The header's two links: Publish (its own page, its own spec) and Source. */
export const PUBLISH_HREF = "/publish";
export const PUBLISH_LABEL = "Publish";
export const SOURCE_HREF = "https://github.com/UniverLab/canopy-web";
export const SOURCE_LABEL = "Source";

/** The search field's visible label. */
export const SEARCH_LABEL = "Search graphs and nodes";

/** The search field's placeholder. */
export const SEARCH_PLACEHOLDER = "hello-graph";

/** The search form's submit button. */
export const SEARCH_BUTTON = "Search";

/** Heading of the official listing. */
export const OFFICIAL_HEADING = "Official";

/** The two tabs over community results. */
export const TOP_TAB = "Top";
export const NEW_TAB = "New";

/** Section headings for document lists. */
export const GRAPHS_HEADING = "Graphs";
export const NODES_HEADING = "Nodes";

/** Heading over the search results list. */
export const RESULTS_HEADING = "Results";

/** Shown in the Official section when a kind has no documents yet. */
export const EMPTY_OFFICIAL_GRAPHS = "No official graphs published yet.";
export const EMPTY_OFFICIAL_NODES = "No official nodes published yet.";

/** Shown when a search matched nothing. */
export const NO_RESULTS = "No graphs or nodes matched your search.";

/** The document page's meta line. */
export const REPO_LABEL = "Repository";

/** The "Star on GitHub" button. */
export const STAR_BUTTON = "Star on GitHub";

/** Counts, shown only when present. */
export const STARS_LABEL = "stars";
export const DOWNLOADS_LABEL = "downloads";
export const NODES_LABEL = "nodes";

/** The install section and the two command prefixes. */
export const INSTALL_HEADING = "Install";
export const INSTALL_GRAPH_PREFIX = "canopy graph install";
export const INSTALL_NODE_PREFIX = "canopy node install";

/** The label of the install reference line in the markdown twin. */
export const REF_LABEL = "ref";

/** The copy button; `data-copy` carries the command. */
export const COPY_BUTTON = "Copy";

/** The copy button's accessible label. */
export const COPY_ARIA = "Copy the install command to the clipboard";

/** The copy button's confirmation, shown for a moment after a copy. */
export const COPY_DONE = "Copied";

/** The drawing's heading: the plate figure below it. */
export const DRAWING_HEADING = "Drawing";

/** The structure section of a graph's markdown twin: nodes and routes as text. */
export const STRUCTURE_HEADING = "Structure";
export const STRUCTURE_NODES_LABEL = "Nodes";
export const STRUCTURE_ENSEMBLES_LABEL = "Ensembles";
export const STRUCTURE_ROUTES_LABEL = "Routes";
export const STRUCTURE_NONE = "none";

/** The agent-nodes section: these are the nodes a harness must run. */
export const AGENT_NODES_HEADING = "Agent nodes";
export const AGENT_NODES_NOTE = "These agent nodes need a harness to run.";

/** The README section heading. */
export const README_HEADING = "README";

/** The transparency section: every command verbatim, every instruction readable. */
export const RUNS_HEADING = "What this runs";

/** The section's anchor: the community warning links to it. */
export const RUNS_SECTION_ID = "what-this-runs";

/** The badge on official documents, next to the name. */
export const OFFICIAL_BADGE = "Official";

/** The community warning: above the install box, and a twin blockquote. */
export const COMMUNITY_WARNING =
  "Community document. UniverLab does not review it. Installing it lets canopy run the " +
  "commands and agent instructions listed below on your machine, with your permissions. " +
  "Read them before you install.";

/** The phrase inside the warning that links to the section. */
export const COMMUNITY_WARNING_LINK = "the commands and agent instructions listed below";

/** The line under a community install command. */
export const RUNS_REVIEW_LINE = `Review "What this runs" first.`;

/** How the section's summary line reads. */
export function runsSummary(commands: number, prompts: number): string {
  return `Runs ${commands} shell commands and ${prompts} agent instructions on your machine.`;
}

/** One attention chip: the word plus the pattern it names. */
export function attentionChip(label: string): string {
  return `attention: ${label}`;
}

/** A builtin preset's stand-in: its text lives in the harness, not the document. */
export function builtinPresetLine(name: string): string {
  return `canopy builtin preset "${name}"`;
}

/** The warning as HTML: the link phrase points at the section. */
export function communityWarningHtml(href: string): string {
  return COMMUNITY_WARNING.replace(
    COMMUNITY_WARNING_LINK,
    `<a href="${href}">${COMMUNITY_WARNING_LINK}</a>`,
  );
}

/** The warning as a twin blockquote line, linking at the section the same way. */
export function communityWarningMarkdown(href: string): string {
  return `> ${COMMUNITY_WARNING.replace(COMMUNITY_WARNING_LINK, `[${COMMUNITY_WARNING_LINK}](${href})`)}`;
}

/** The UniverLab colophon: the product line, its experiment and its links. */
export const COLOPHON_PRODUCT = "Canopy graphs";
export const COLOPHON_EXP = "EXP-001";
export const COLOPHON_LINKS: Array<{ label: string; href: string }> = [
  { label: "Canopy", href: CANOPY_HREF },
  { label: "univerlab.org", href: "https://univerlab.org/" },
  { label: SOURCE_LABEL, href: SOURCE_HREF },
];

/** The datasheet's field labels, in sheet order. */
export const SHEET_KIND = "Kind";
export const SHEET_NAME = "Name";
export const SHEET_SOURCE = "Source";
export const SHEET_REF = "Ref";
export const SHEET_STARS = "Stars";
export const SHEET_NODES = "Nodes";
export const SHEET_EDGES = "Edges";
export const SHEET_ENSEMBLES = "Ensembles";
export const SHEET_AGENTS = "Agent nodes";

/** The cold-start 503: the first scheduled run has not built the index yet. */
export const INDEXING_HEADING = "Indexing the catalogue";
export const INDEXING_BODY = "The catalogue is being indexed — back in a few minutes";

/** The calm 404: no such document. */
export const NOT_FOUND_HEADING = "Not found";
export const NOT_FOUND_BODY = "There is no document at this address. It may have moved or never existed.";

/** The llms.txt header line, above one line per document. */
export const LLMS_HEADER = "# graphs.univerlab.org — the Canopy graph and node catalogue.";

/** Search results announce their query through this heading. */
export function resultsFor(q: string): string {
  return q === "" ? RESULTS_HEADING : `${RESULTS_HEADING} for “${q}”`;
}

/** The install command for a document of `kind`. */
export function installCommand(kind: DocumentKind, ref: string): string {
  return `${kind === "graph" ? INSTALL_GRAPH_PREFIX : INSTALL_NODE_PREFIX} ${ref}`;
}

/** One llms.txt line: name, description, ref — tab-separated, one per doc. */
export function llmsLine(doc: Doc, ref: string): string {
  return `${doc.name}\t${doc.description}\t${ref}`;
}

/** How a count reads on a document page: "12 stars". */
export function countLine(label: string, count: number): string {
  return `${count} ${label}`;
}

/** How a graph's nodes read by kind: "agent 2 · check 1 · gate 2". */
export function nodesByKindLine(counts: Array<{ kind: string; count: number }>): string {
  return counts.map(({ kind, count }) => `${kind} ${count}`).join(" · ");
}

/** How a graph's edges read, with the fail-edge count: "5 edges · 1 fail". */
export function edgesLine(total: number, fail: number): string {
  return `${total} edges · ${fail} fail`;
}

/** How one ensemble reads: "reviewers (parallel, 2 members)". */
export function ensembleLine(name: string, strategy: string, members: number): string {
  return `${name} (${strategy}, ${members} members)`;
}

/** The Publish page: how to list a graph or node in the catalogue. */
export const PUBLISH_TITLE = "Publish";
export const PUBLISH_DESCRIPTION = "How to list your graph or node in the catalogue.";
export const PUBLISH_LEDE = "Any public repo can list its graphs and nodes here.";

/** The Publish page's seven sections, in page order. */
export const PUBLISH_SHARE_HEADING = "What you can share";
export const PUBLISH_PLACE_HEADING = "Where it goes in your repo";
export const PUBLISH_TOPIC_HEADING = "Mark the repo";
export const PUBLISH_CHECK_HEADING = "Check it before sharing";
export const PUBLISH_WHEN_HEADING = "When it shows up";
export const PUBLISH_INSTALL_HEADING = "How people install it";
export const PUBLISH_OFFICIAL_HEADING = "Official documents";

/** The Canopy commands the Publish page shows, beside the install prefixes above. */
export const EXPORT_GRAPH_COMMAND = "canopy graph export";
export const VALIDATE_GRAPH_PREFIX = "canopy graph validate";

/** The example repository and slugs the Publish page installs from. */
export const PUBLISH_EXAMPLE_OWNER = "acme";
export const PUBLISH_EXAMPLE_REPO = "things";
export const PUBLISH_EXAMPLE_GRAPH = "flow";
export const PUBLISH_EXAMPLE_NODE = "cool-node";

/** The fields of a node document, as the share section lists them. */
export const PUBLISH_NODE_FIELDS = ["format_version", "name", "kind", "config", "description", "preset"];

/** The harness keys a shared document never carries. */
export const PUBLISH_BARE_KEYS = ["platform", "model", "cli"];

/** The JSON Schemas, at `main` in this repo, as raw file URLs. */
export const SCHEMA_GRAPH_URL =
  `https://raw.githubusercontent.com/${OFFICIAL_OWNER}/${OFFICIAL_REPO}/main/schema/graph.schema.json`;
export const SCHEMA_NODE_URL =
  `https://raw.githubusercontent.com/${OFFICIAL_OWNER}/${OFFICIAL_REPO}/main/schema/node.schema.json`;

/** The schema link labels. */
export const SCHEMA_GRAPH_LABEL = "graph.schema.json";
export const SCHEMA_NODE_LABEL = "node.schema.json";

/** What you can share: a graph is the export of the export command. */
export function publishShareGraph(file: string): string {
  return `A graph is a ${file} file. It is the export of:`;
}

/** What you can share: a node carries its fields and nothing else. */
export function publishShareNode(file: string): string {
  return (
    `A node is a ${file} file. It carries format_version, name, kind and config, ` +
    `with an optional description and preset.`
  );
}

/** What you can share: shared documents stay harness-free. */
export const PUBLISH_SHARE_BARE =
  "Shared documents never carry platform, model or cli. The person who installs chooses the harnesses.";

/** Where it goes: the graph path, over the path the search reads. */
export function publishPlaceGraph(path: string): string {
  return `Put the graph at ${path}.`;
}

/** Where it goes: the node path, over the path the search reads. */
export function publishPlaceNode(path: string): string {
  return `Put the node at ${path}.`;
}

/** Where it goes: every document folder carries its README. */
export const PUBLISH_PLACE_README = "Add a README.md in the same folder. It says what the document does.";

/** Where it goes: the slug equals the name and matches the slug rule. */
export function publishPlaceSlug(pattern: string): string {
  return `The <slug> in the path equals the document's name. It matches ${pattern}.`;
}

/** Mark the repo: listing needs a public repository. */
export const PUBLISH_TOPIC_PUBLIC = "The repo must be public.";

/** Mark the repo: the topic that lists it, over the search's own topic. */
export function publishTopicStep(topic: string): string {
  return `Add the ${topic} topic on GitHub. Find it under Settings → About → Topics.`;
}

/** Check it before sharing: the validator reports every problem with its path. */
export const PUBLISH_CHECK_VALIDATE =
  "Check the file with canopy 3.2 or later. It reports every problem with its path:";

/** Check it before sharing: or read the file against the JSON Schemas. */
export function publishCheckSchemas(graphLabel: string, nodeLabel: string): string {
  return `Or check the file against the JSON Schemas: ${graphLabel} and ${nodeLabel}.`;
}

/** When it shows up: GitHub indexes a new topic within minutes. */
export const PUBLISH_WHEN_INDEX = "GitHub indexes a new topic within minutes.";

/** When it shows up: over the minutes between scheduled index builds. */
export function publishWhenIndex(minutes: number): string {
  return `The catalogue re-indexes every ${minutes} minutes, so new documents appear within ${minutes} minutes.`;
}

/** How people install it: the graph installs by owner, repo and slug. */
export const PUBLISH_INSTALL_GRAPH = "People install the graph with:";

/** How people install it: the node installs the same way. */
export const PUBLISH_INSTALL_NODE = "People install the node with:";

/** How people install it: the same commands the document pages print. */
export const PUBLISH_INSTALL_SAME = "The commands are the same ones each document page prints.";

/** Official documents live in this repo's registry and arrive by pull request. */
export function publishOfficial(repo: string, prefix: string): string {
  return `Official documents live in ${repo} under ${prefix}. They are proposed by pull request.`;
}

/** The home twin's pointer to the Publish page, over its label and href. */
export function homePublishLine(label: string, href: string): string {
  return `Share your own: [${label}](${href})`;
}
