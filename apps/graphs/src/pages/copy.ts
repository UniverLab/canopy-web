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
import { OFFICIAL_REPOSITORY } from "../lib.js";

/**
 * The repository the Worker and the JSON Schemas live in. The official
 * *documents* live elsewhere (`OFFICIAL_REPOSITORY`, the public catalogue
 * repository); the schemas stay pinned here, next to the validator that
 * enforces them.
 */
export const SITE_REPOSITORY = "UniverLab/canopy-web";

/** Where the official documents live: the public catalogue repository. */
export const OFFICIAL_HREF = `https://github.com/${OFFICIAL_REPOSITORY}`;

/** The site's name, in the page titles. */
export const SITE_NAME = "graphs.univerlab.org";

/** Suffix for `<title>`: "hello-graph · graphs.univerlab.org". */
export const TITLE_SEPARATOR = " · ";

/** The catalogue in one line: the home's hero, and the meta description. */
export const TAGLINE = "A catalogue of Canopy graphs and nodes.";

/** The Canopy page the colophon links back to. */
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

/** The draft banner: unreviewed, expiring, and gone after one install. */
export const DRAFT_BANNER_LEAD = "Unreviewed draft. It expires at";
export const DRAFT_BANNER_TAIL = "and disappears after its first install.";

/** The draft banner as a twin blockquote line, with the time as text. */
export function draftBannerMarkdown(when: string): string {
  return `> ${DRAFT_BANNER_LEAD} ${when} ${DRAFT_BANNER_TAIL}`;
}

/** A draft's expiry as `YYYY-MM-DD HH:MM UTC`; the raw value when unreadable. */
export function draftTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** The 404 a draft page answers once the draft is unknown or expired. */
export const DRAFT_MISSING_HEADING = "Draft not found";
export const DRAFT_MISSING_BODY = "A draft lasts 30 minutes or one install. This one is gone.";

/** The UniverLab colophon: the product line, its experiment and its links. */
export const COLOPHON_PRODUCT = "Canopy graphs";
export const COLOPHON_EXP = "EXP-001";
export const COLOPHON_LINKS: Array<{ label: string; href: string }> = [
  { label: "Canopy", href: CANOPY_HREF },
  { label: "univerlab.org", href: "https://univerlab.org/" },
  { label: SOURCE_LABEL, href: SOURCE_HREF },
];

/**
 * The markdown twin's footer section: every twin ends with the lab's
 * privacy and terms links, the counterpart of the HTML colophon's.
 */
export const MD_FOOTER =
  "## UniverLab\n\n- [Privacy](https://univerlab.org/privacy/)\n- [Terms](https://univerlab.org/terms/)";

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

/** The report links a document page carries, and the label of its issue. */
export const REPORT_LABEL = "Report";
export const REPORT_REPO_LABEL = "Report the repository to GitHub";

/** The 410: a document removed from the catalogue after a community report. */
export const BLOCKED_HEADING = "Removed from the catalogue after a community report";
export const BLOCKED_ISSUE_LABEL = "The community report";

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

/** The Publish page's sections, in page order. */
export const PUBLISH_SHARE_HEADING = "What you can share";
export const PUBLISH_PLACE_HEADING = "Where it goes in your repo";
export const PUBLISH_TOPIC_HEADING = "Mark the repo";
export const PUBLISH_CHECK_HEADING = "Check it before sharing";
export const PUBLISH_WHEN_HEADING = "When it shows up";
export const PUBLISH_INSTALL_HEADING = "How people install it";
export const PUBLISH_OFFICIAL_HEADING = "Official documents";
export const PUBLISH_REPORT_HEADING = "Reporting and removal";

/**
 * The Publish page's closing paragraph: reports are GitHub issues, removal
 * is a reviewed pull request to the list the indexer reads, and an author
 * argues on the issue that removed them. Rendered with `blocked.json` as
 * inline code.
 */
export const PUBLISH_REPORT_BODY =
  "Anyone can report a graph or node through the Report link on its page, which opens a " +
  "pre-filled GitHub issue. Maintainers decide whether to remove it by pull request to " +
  "blocked.json, and the indexer honours the list on its next run. An author can appeal " +
  "on the same issue.";

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
  `https://raw.githubusercontent.com/${SITE_REPOSITORY}/main/schema/graph.schema.json`;
export const SCHEMA_NODE_URL =
  `https://raw.githubusercontent.com/${SITE_REPOSITORY}/main/schema/node.schema.json`;

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

/**
 * The Publish page's Official section: official documents live in the
 * public catalogue repository and are proposed by pull request there;
 * forking it (or using it as a template) is the quickest way to start a
 * graphs repo.
 */
export function publishOfficial(repo: string): string {
  return (
    `Official documents live in ${repo}. They are proposed by pull request there, and ` +
    `forking ${repo} — or using it as a template — is the quickest way to start a graphs repo.`
  );
}

/** The home twin's pointer to the Publish page, over its label and href. */
export function homePublishLine(label: string, href: string): string {
  return `Share your own: [${label}](${href})`;
}

/* ── The editor (/editor) ───────────────────────────────────────────────
 * Every string the editor page and its client bundle render lives here:
 * the shell templates in pages/editor.ts and the browser code under
 * src/editor/ both import from this module, so the whole surface stays
 * swappable from one file.
 */

/** The editor's route, its header link (beside Publish) and its h1. */
export const EDITOR_HREF = "/editor";
export const EDITOR_LABEL = "Editor";
export const EDITOR_TITLE = "Editor";

/** The links every document page carries into the editor, by kind. */
export const EDITOR_EDIT_COPY = "Edit a copy";
export const EDITOR_ADD_TO_GRAPH = "Add to a graph";

/** One line about the editor: its page description and markdown twin lede. */
export const EDITOR_TAGLINE =
  "Assemble a Canopy graph by hand: place nodes, connect them with conditions, " +
  "edit their config, then export the file or share it as a one-use draft.";

/** The markdown twin's pointer to the editor page. */
export const EDITOR_TWIN_LINE = `Open it in a browser: [${EDITOR_LABEL}](${EDITOR_HREF})`;

/** The toolbar's four actions, and the confirm before New clears the work. */
export const EDITOR_NEW = "New";
export const EDITOR_NEW_CONFIRM =
  "Start over? The graph in this browser is cleared.";
export const EDITOR_IMPORT = "Import JSON";
export const EDITOR_EXPORT = "Export JSON";
export const EDITOR_COPY_LINK = "Copy link";
export const EDITOR_CANCEL = "Cancel";
export const EDITOR_APPLY = "Import";

/** The palette: blank kinds, the catalogue list, its search and its refusals. */
export const EDITOR_PALETTE_LABEL = "Node palette";
export const EDITOR_NODES_HEADING = "Nodes";
export const EDITOR_BLANK_HEADING = "Blank";
export const EDITOR_CATALOGUE_HEADING = "Catalogue";
export const EDITOR_SEARCH_LABEL = "Search catalogue nodes";
export const EDITOR_SEARCH_PLACEHOLDER = "hello-node";
export const EDITOR_CATALOGUE_EMPTY = "No official nodes listed yet.";
export const EDITOR_ENSEMBLE_NODE =
  "Ensemble nodes cannot be added: this editor draws graph nodes, not ensembles.";
export const EDITOR_CATALOGUE_FAILED =
  "The catalogue did not answer. Try again in a moment.";

/** The canvas: its accessible label, the empty note and the zoom controls. */
export const EDITOR_CANVAS_LABEL = "Graph canvas";
export const EDITOR_CANVAS_EMPTY =
  "Add a blank node or a catalogue node from the palette to start.";
export const EDITOR_ZOOM_IN = "Zoom in";
export const EDITOR_ZOOM_OUT = "Zoom out";
export const EDITOR_ZOOM_FIT = "Fit the graph";

/** The condition chooser that opens when a drag lands on another node. */
export const EDITOR_CONDITION_HEADING = "Condition";
export const EDITOR_ROUTE_LABEL = "Route name";
export const EDITOR_ROUTE_PLACEHOLDER = "proceed";
export const EDITOR_ROUTE_REQUIRED = "A route needs a name.";

/** The inspector panel: node fields, the edge editor and the graph view. */
export const EDITOR_PANEL_LABEL = "Inspector";
export const EDITOR_PANEL_NODE_HEADING = "Node";
export const EDITOR_PANEL_GRAPH_HEADING = "Graph";
export const EDITOR_SELECT_HINT = "Select a node or an edge on the canvas to edit it.";
export const EDITOR_FIELD_NAME = "Name";
export const EDITOR_FIELD_KIND = "Kind";
export const EDITOR_FIELD_PROMPT = "Prompt";
export const EDITOR_FIELD_PRESET = "Prompt preset";
export const EDITOR_FIELD_COMMAND = "Command";
export const EDITOR_FIELD_CONFIG = "Config (JSON)";
export const EDITOR_NAME_INVALID = "A name is 1-48 characters of a-z, 0-9 or -.";
export const EDITOR_CONFIG_INVALID =
  "That is not JSON yet — the graph still holds the last valid config.";
export const EDITOR_DELETE_NODE = "Delete node";
export const EDITOR_ENSEMBLE_LOCKED =
  "This node is wired into an ensemble, and this editor does not edit ensembles — " +
  "so it cannot be renamed or deleted.";
export const EDITOR_EDGE_HEADING = "Edge";
export function editorEdgeLabel(from: string, to: string): string {
  return `${from} → ${to}`;
}
export const EDITOR_CONDITION_LABEL = "Condition";
export const EDITOR_DELETE_EDGE = "Delete edge";

/** The sections the editor keeps untouched, shown read-only in the panel. */
export const EDITOR_UNTOUCHED_NOTE =
  "Ensembles, hooks, the infra node and presets are kept exactly as they came — " +
  "this editor does not edit them yet.";
export const EDITOR_SECTION_ENSEMBLES = "Ensembles";
export const EDITOR_SECTION_HOOKS = "Hooks";
export const EDITOR_SECTION_INFRA = "Infra node";
export const EDITOR_SECTION_PRESETS = "Presets";
export const EDITOR_SECTION_EMPTY = "none";

/** The live validation line: one clean statement, or the problems themselves. */
export const EDITOR_NO_PROBLEMS = "No problems.";
export function editorProblemCount(count: number): string {
  return count === 1 ? "1 problem" : `${count} problems`;
}

/** The import box: what to paste, and the two refusals it can answer. */
export const EDITOR_IMPORT_HEADING = "Import JSON";
export const EDITOR_IMPORT_LABEL = "Paste a graph.json, or choose a file.";
export const EDITOR_IMPORT_FILE = "Choose file";
export const EDITOR_IMPORT_BAD = "That text is not a JSON graph document.";
export const EDITOR_IMPORT_HARNESS =
  "That document binds a harness: shared documents never carry platform, model or cli — " +
  "the person who installs chooses the harnesses.";

/** The share block the Copy link action fills: heading, page link, countdown. */
export const EDITOR_SHARE_HEADING = "Draft";
export const EDITOR_SHARE_BUSY = "Creating a draft…";
export const EDITOR_SHARE_PAGE = "Open the draft page";
export const EDITOR_DRAFT_NODE =
  "That draft holds a node document; the editor draws graphs.";
export function draftExpiresIn(when: string): string {
  return `expires in ${when}`;
}
export const DRAFT_EXPIRED = "expired";

/** Loading a document into the canvas: the failure line over the API's text. */
export const EDITOR_LOAD_FAILED = "Could not open that document";

/* ── The editor's API failures (src/editor/api.ts) ────────────────────────
 * The client shows the API's own words whenever it has them; these are the
 * fallbacks for the failures that carry none — an unreachable network, a
 * body that is not what the route promises, a ref or draft id that never
 * parses. They live here with the rest of the editor's copy.
 */

/** The network never answered at all. */
export const EDITOR_API_OFFLINE = "the network did not answer";

/** A 404 whose body names nothing. */
export const EDITOR_API_MISSING = "no such document";

/** Any other status whose body names nothing. */
export function editorApiStatus(status: number): string {
  return `the server answered ${status}`;
}

/** A ref with neither one nor three segments. */
export function editorApiRef(ref: string): string {
  return `"${ref}" is not a document ref`;
}

/** A document route whose answer held no `document`. */
export const EDITOR_API_NO_DOCUMENT = "the answer held no document";

/** An official listing whose answer was not a listing. */
export const EDITOR_API_NO_LISTING = "the answer was not a listing";

/** A search whose answer was not a search result. */
export const EDITOR_API_NO_SEARCH = "the answer was not a search result";

/** A drafts answer missing the fields the editor reads. */
export const EDITOR_API_DRAFT_BROKEN = "the draft answer was incomplete";

/** A draft id outside the alphabet the Worker accepts. */
export const EDITOR_API_BAD_DRAFT_ID = "that is not a draft id";

/** The fallback line when a failure carries no words of its own. */
export const EDITOR_FAILED = "Something went wrong.";

/* ── Patterns (/patterns) ───────────────────────────────────────────────
 * Every string the pattern pages render: the list of cards, one pattern
 * page with its figure plate, the Implemented-by rows and the Patterns
 * back-link on document pages.
 */

/** The patterns list: its route, its header link beside Publish, its h1. */
export const PATTERNS_HREF = "/patterns";
export const PATTERNS_LABEL = "Patterns";
export const PATTERNS_TITLE = "Patterns";

/** The list page's meta description and its one-line lede. */
export const PATTERNS_DESCRIPTION = "Evergreen pages on the agent-orchestration patterns the lab runs.";
export const PATTERNS_LEDE = "Evergreen pages on the agent-orchestration patterns the lab runs. Each one opens with its drawing.";

/** Shown on the list when no pattern page has been indexed yet. */
export const PATTERNS_EMPTY = "No patterns published yet.";

/** The home page's pointer to the list, over its lead and link. */
export const PATTERNS_HOME_LEAD = "The lab's orchestration patterns:";

/** The home twin's pointer to the list, over its label and href. */
export function homePatternsLine(label: string, href: string): string {
  return `The lab's orchestration patterns: [${label}](${href})`;
}

/** The one-line notice every experiment page carries under its badge. */
export const EXPERIMENT_NOTICE = "Experiment: this pattern is not yet proven in the lab.";

/** The sources section: the lab's reading behind the page. */
export const PATTERN_SOURCES_HEADING = "Sources";

/** The section naming the catalogue documents that implement the pattern. */
export const IMPLEMENTED_BY_HEADING = "Implemented by";

/** Shown when nothing in the catalogue implements the pattern yet. */
export const PATTERNS_NO_IMPLEMENTS = "No catalogue document implements this pattern yet.";

/** A ref the index does not know, listed as text beside the ref itself. */
export const PATTERN_MISSING_REF = "not in the catalogue yet";

/** The datasheet field linking a document page back to its patterns. */
export const PATTERNS_SHEET_LABEL = "Patterns";

/** The twin's figure section: the drawing as a fenced JSON block. */
export const PATTERN_FIGURE_HEADING = "Figure";

/** The llms.txt section heading over the pattern lines. */
export const LLMS_PATTERNS_HEADING = "Patterns";

/** One llms.txt pattern line: title, summary, page path — tab-separated. */
export function llmsPatternLine(title: string, summary: string, slug: string): string {
  return `${title}\t${summary}\t${PATTERNS_HREF}/${slug}`;
}
