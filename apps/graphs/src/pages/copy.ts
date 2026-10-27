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

/** The site's name, in the header and the page titles. */
export const SITE_NAME = "graphs.univerlab.org";

/** Suffix for `<title>`: "hello-graph · graphs.univerlab.org". */
export const TITLE_SEPARATOR = " · ";

/** One-line tagline under the site name. */
export const TAGLINE = "A catalogue of Canopy graphs and nodes.";

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

/** The drawing's heading and its accessible description. */
export const DRAWING_HEADING = "Drawing";
export const DRAWING_ALT = "A drawing of the graph: nodes left to right by layer.";

/** The agent-nodes section: these are the nodes a harness must run. */
export const AGENT_NODES_HEADING = "Agent nodes";
export const AGENT_NODES_NOTE = "These agent nodes need a harness to run.";

/** The README section heading. */
export const README_HEADING = "README";

/** The footer line, linking to the Canopy page on univerlab.org. */
export const FOOTER_TEXT = "Canopy · UniverLab";
export const FOOTER_HREF = "https://univerlab.org/canopy/";

/** The theme toggle's accessible label. */
export const THEME_TOGGLE = "Switch between day and night";

/** The calm 503: GitHub (or its rate limit) failed the data layer. */
export const BUSY_HEADING = "GitHub is busy";
export const BUSY_BODY = "The catalogue could not reach GitHub right now. Please try again in a moment.";

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
