// SPDX-License-Identifier: Apache-2.0
/**
 * The report link: one pre-filled issue URL per document page. The slug and
 * the repository use only characters the catalogue allows, so the test pins
 * the encoding of `-` and `.` and the parameter order the form relies on.
 */
import { describe, expect, it } from "vitest";
import { OFFICIAL_REPOSITORY } from "../src/lib.js";
import {
  REPORT_ISSUE_HREF,
  REPORT_PREFILL_IDS,
  REPORT_REPOSITORY_HREF,
  REPORT_TEMPLATE,
  reportPrefill,
  reportTitle,
  reportUrl,
} from "../src/pages/report.js";

const PAGE = "https://graphs.univerlab.org/g/acme-co/graph.tools/hello-graph";

describe("the report URL", () => {
  it("encodes the title, the page URL and the source exactly once", () => {
    expect(reportUrl("graph", "acme-co", "graph.tools", "hello-graph", PAGE)).toBe(
      `${REPORT_ISSUE_HREF}?template=report-document.yml` +
        `&title=Report%3A%20graph%20acme-co%2Fgraph.tools%2Fhello-graph` +
        `&document=${encodeURIComponent(PAGE)}` +
        `&kind=graph` +
        `&source=acme-co%2Fgraph.tools`,
    );
  });

  it("keeps the form's parameter order: template, title, then its own ids", () => {
    const url = reportUrl("node", "acme-co", "graph.tools", "hello-node", PAGE);
    const names = url.split("?")[1]?.split("&").map((pair) => pair.split("=")[0] ?? "");
    expect(names).toEqual(["template", "title", ...REPORT_PREFILL_IDS]);
    expect(REPORT_PREFILL_IDS).toEqual(["document", "kind", "source"]);
    expect(REPORT_TEMPLATE).toBe("report-document.yml");
  });

  it("pre-fills the form's field ids with the page's own values", () => {
    expect(reportPrefill("node", "acme-co", "graph.tools", PAGE)).toEqual({
      document: PAGE,
      kind: "node",
      source: "acme-co/graph.tools",
    });
    expect(reportTitle("node", "acme-co", "graph.tools", "hello-node")).toBe(
      "Report: node acme-co/graph.tools/hello-node",
    );
  });

  it("points the repository report at GitHub's own form", () => {
    expect(REPORT_REPOSITORY_HREF).toBe("https://github.com/contact/report-content");
  });

  it("opens reports on the official catalogue repository, wherever the document lives", () => {
    expect(OFFICIAL_REPOSITORY).toBe("UniverLab/canopy-graphs");
    expect(REPORT_ISSUE_HREF).toBe("https://github.com/UniverLab/canopy-graphs/issues/new");
    // A community document reports to the same place: one list, one decider.
    const url = reportUrl("graph", "acme", "things", "flow", PAGE);
    expect(url.startsWith(`${REPORT_ISSUE_HREF}?`)).toBe(true);
    expect(url).toContain("source=acme%2Fthings");
  });
});
