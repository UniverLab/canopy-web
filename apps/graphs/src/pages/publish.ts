// SPDX-License-Identifier: Apache-2.0
/**
 * The Publish page: how to list a graph or node in the catalogue.
 *
 * A pure `Page`, prose from copy.ts and every checkable value from the
 * code that reads it: the topic from the discovery query, the paths from
 * the document folders the indexer reads, the index minutes from the
 * cron constant, the install commands from the same builder the document
 * pages print, and the slug rule from the shared pattern. The page
 * cannot drift from the code because it is rendered from it.
 */
import { INDEX_CRON_MINUTES } from "../indexer.js";
import { OFFICIAL_REPOSITORY, SLUG_PATTERN, documentPrefix } from "../lib.js";
import { communityDir, documentFile } from "../documents.js";
import { CATALOGUE_TOPIC } from "../search.js";
import {
  EXPORT_GRAPH_COMMAND,
  PUBLISH_BARE_KEYS,
  PUBLISH_CHECK_HEADING,
  PUBLISH_CHECK_VALIDATE,
  PUBLISH_DESCRIPTION,
  PUBLISH_INSTALL_GRAPH,
  PUBLISH_INSTALL_HEADING,
  PUBLISH_INSTALL_NODE,
  PUBLISH_INSTALL_SAME,
  PUBLISH_LEDE,
  PUBLISH_NODE_FIELDS,
  PUBLISH_OFFICIAL_HEADING,
  PUBLISH_PLACE_HEADING,
  PUBLISH_PLACE_README,
  PUBLISH_REPORT_BODY,
  PUBLISH_REPORT_HEADING,
  PUBLISH_SHARE_BARE,
  PUBLISH_SHARE_HEADING,
  PUBLISH_TITLE,
  PUBLISH_TOPIC_HEADING,
  PUBLISH_TOPIC_PUBLIC,
  PUBLISH_WHEN_HEADING,
  PUBLISH_WHEN_INDEX,
  PUBLISH_EXAMPLE_GRAPH,
  PUBLISH_EXAMPLE_NODE,
  PUBLISH_EXAMPLE_OWNER,
  PUBLISH_EXAMPLE_REPO,
  SCHEMA_GRAPH_LABEL,
  SCHEMA_GRAPH_URL,
  SCHEMA_NODE_LABEL,
  SCHEMA_NODE_URL,
  SOURCE_HREF,
  VALIDATE_GRAPH_PREFIX,
  installCommand,
  publishCheckSchemas,
  publishOfficial,
  publishPlaceGraph,
  publishPlaceNode,
  publishPlaceSlug,
  publishShareGraph,
  publishShareNode,
  publishTopicStep,
  publishWhenIndex,
} from "./copy.js";
import { type Page } from "./layout.js";
import { copyButton } from "./look.js";
import { escapeHtml } from "./md.js";

/** One prose paragraph: escaped, with `spans` set as inline code. */
function para(text: string, spans: string[] = []): string {
  let out = escapeHtml(text);
  for (const span of spans) {
    const code = `<code>${escapeHtml(span)}</code>`;
    out = out.replace(escapeHtml(span), () => code);
  }
  return `<p>${out}</p>`;
}

/** One prose paragraph with links: each label becomes an anchor. */
function paraLinks(text: string, links: Array<{ label: string; href: string }>): string {
  let out = escapeHtml(text);
  for (const { label, href } of links) {
    const anchor = `<a href="${escapeHtml(href)}" rel="nofollow">${escapeHtml(label)}</a>`;
    out = out.replace(escapeHtml(label), () => anchor);
  }
  return `<p>${out}</p>`;
}

/** One command in its box, with a Copy button like the install rows. */
function commandBox(command: string): string {
  return `<p><span class="row-install"><code>${escapeHtml(command)}</code>${copyButton(command)}</span></p>`;
}

/** One twin paragraph: plain text, with `spans` in backticks. */
function mdPara(text: string, spans: string[] = []): string {
  let out = text;
  for (const span of spans) {
    out = out.replace(span, () => `\`${span}\``);
  }
  return `${out}\n`;
}

/** One twin paragraph with links: each label becomes a markdown link. */
function mdLinks(text: string, links: Array<{ label: string; href: string }>): string {
  let out = text;
  for (const { label, href } of links) {
    out = out.replace(label, () => `[${label}](${href})`);
  }
  return `${out}\n`;
}

/** One twin command: an indented block, as the document twins print it. */
function mdCommand(command: string): string {
  return `    ${command}\n`;
}

/** The Publish page and its markdown twin, rendered from the code's own values. */
export function publishPage(): Page {
  const graphFile = documentFile("graph");
  const nodeFile = documentFile("node");
  const graphPath = `${communityDir("graph")}/<slug>/${graphFile}`;
  const nodePath = `${communityDir("node")}/<slug>/${nodeFile}`;
  const exampleGraphPath = `${communityDir("graph")}/${PUBLISH_EXAMPLE_GRAPH}/${graphFile}`;
  const validateCommand = `${VALIDATE_GRAPH_PREFIX} ${exampleGraphPath}`;
  const installGraph = installCommand(
    "graph",
    `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_GRAPH}`,
  );
  const installNode = installCommand(
    "node",
    `${PUBLISH_EXAMPLE_OWNER}/${PUBLISH_EXAMPLE_REPO}/${PUBLISH_EXAMPLE_NODE}`,
  );
  const minutes = INDEX_CRON_MINUTES;

  const sections: Array<{ heading: string; html: string[]; markdown: string[] }> = [
    {
      heading: PUBLISH_SHARE_HEADING,
      html: [
        para(publishShareGraph(graphFile), [graphFile]),
        commandBox(EXPORT_GRAPH_COMMAND),
        para(publishShareNode(nodeFile), [nodeFile, ...PUBLISH_NODE_FIELDS]),
        para(PUBLISH_SHARE_BARE, PUBLISH_BARE_KEYS),
      ],
      markdown: [
        mdPara(publishShareGraph(graphFile), [graphFile]),
        mdCommand(EXPORT_GRAPH_COMMAND),
        mdPara(publishShareNode(nodeFile), [nodeFile, ...PUBLISH_NODE_FIELDS]),
        mdPara(PUBLISH_SHARE_BARE, PUBLISH_BARE_KEYS),
      ],
    },
    {
      heading: PUBLISH_PLACE_HEADING,
      html: [
        para(publishPlaceGraph(graphPath), [graphPath]),
        para(publishPlaceNode(nodePath), [nodePath]),
        para(PUBLISH_PLACE_README, ["README.md"]),
        para(publishPlaceSlug(SLUG_PATTERN), ["<slug>", "name", SLUG_PATTERN]),
      ],
      markdown: [
        mdPara(publishPlaceGraph(graphPath), [graphPath]),
        mdPara(publishPlaceNode(nodePath), [nodePath]),
        mdPara(PUBLISH_PLACE_README, ["README.md"]),
        mdPara(publishPlaceSlug(SLUG_PATTERN), ["<slug>", "name", SLUG_PATTERN]),
      ],
    },
    {
      heading: PUBLISH_TOPIC_HEADING,
      html: [
        para(PUBLISH_TOPIC_PUBLIC),
        para(publishTopicStep(CATALOGUE_TOPIC), [CATALOGUE_TOPIC]),
      ],
      markdown: [
        mdPara(PUBLISH_TOPIC_PUBLIC),
        mdPara(publishTopicStep(CATALOGUE_TOPIC), [CATALOGUE_TOPIC]),
      ],
    },
    {
      heading: PUBLISH_CHECK_HEADING,
      html: [
        para(PUBLISH_CHECK_VALIDATE),
        commandBox(validateCommand),
        paraLinks(publishCheckSchemas(SCHEMA_GRAPH_LABEL, SCHEMA_NODE_LABEL), [
          { label: SCHEMA_GRAPH_LABEL, href: SCHEMA_GRAPH_URL },
          { label: SCHEMA_NODE_LABEL, href: SCHEMA_NODE_URL },
        ]),
      ],
      markdown: [
        mdPara(PUBLISH_CHECK_VALIDATE),
        mdCommand(validateCommand),
        mdLinks(publishCheckSchemas(SCHEMA_GRAPH_LABEL, SCHEMA_NODE_LABEL), [
          { label: SCHEMA_GRAPH_LABEL, href: SCHEMA_GRAPH_URL },
          { label: SCHEMA_NODE_LABEL, href: SCHEMA_NODE_URL },
        ]),
      ],
    },
    {
      heading: PUBLISH_WHEN_HEADING,
      html: [
        para(PUBLISH_WHEN_INDEX),
        para(publishWhenIndex(minutes), [`${minutes} minutes`]),
      ],
      markdown: [
        mdPara(PUBLISH_WHEN_INDEX),
        mdPara(publishWhenIndex(minutes), [`${minutes} minutes`]),
      ],
    },
    {
      heading: PUBLISH_INSTALL_HEADING,
      html: [
        para(PUBLISH_INSTALL_GRAPH),
        commandBox(installGraph),
        para(PUBLISH_INSTALL_NODE),
        commandBox(installNode),
        para(PUBLISH_INSTALL_SAME),
      ],
      markdown: [
        mdPara(PUBLISH_INSTALL_GRAPH),
        mdCommand(installGraph),
        mdPara(PUBLISH_INSTALL_NODE),
        mdCommand(installNode),
        mdPara(PUBLISH_INSTALL_SAME),
      ],
    },
    {
      heading: PUBLISH_OFFICIAL_HEADING,
      html: [
        paraLinks(publishOfficial(OFFICIAL_REPOSITORY, documentPrefix()), [
          { label: OFFICIAL_REPOSITORY, href: SOURCE_HREF },
        ]).replace(
          escapeHtml(documentPrefix()),
          `<code>${escapeHtml(documentPrefix())}</code>`,
        ),
      ],
      markdown: [
        mdLinks(publishOfficial(OFFICIAL_REPOSITORY, documentPrefix()), [
          { label: OFFICIAL_REPOSITORY, href: SOURCE_HREF },
        ]).replace(documentPrefix(), `\`${documentPrefix()}\``),
      ],
    },
    {
      heading: PUBLISH_REPORT_HEADING,
      html: [para(PUBLISH_REPORT_BODY, ["blocked.json"])],
      markdown: [mdPara(PUBLISH_REPORT_BODY, ["blocked.json"])],
    },
  ];

  const html = [
    `<h1 class="doc-title">${escapeHtml(PUBLISH_TITLE)}</h1>`,
    `<p class="description">${escapeHtml(PUBLISH_LEDE)}</p>`,
    ...sections.flatMap((section) => [
      `<h2 class="kicker">${escapeHtml(section.heading)}</h2>`,
      `<div class="readme">`,
      ...section.html,
      `</div>`,
    ]),
  ].join("\n");

  const markdown = [
    `# ${PUBLISH_TITLE}`,
    ``,
    PUBLISH_LEDE,
    ...sections.flatMap((section) => [
      ``,
      `## ${section.heading}`,
      ``,
      ...section.markdown
        .map((block) => block.replace(/\n$/, ""))
        .flatMap((block, index) => (index === 0 ? [block] : [``, block])),
    ]),
    ``,
  ].join("\n");

  return { title: PUBLISH_TITLE, description: PUBLISH_DESCRIPTION, html, markdown };
}
