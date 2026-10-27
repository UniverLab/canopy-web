// SPDX-License-Identifier: Apache-2.0
/**
 * The report links a document page carries.
 *
 * Reporting and removal are GitHub's: the form pre-fills an issue in this
 * repository, and a maintainer decides by pull request to
 * `registry/blocked.json`. No endpoint, no storage and no moderation UI of
 * our own. This module is the one place the pre-filled URL is built, so the
 * issue form's field ids (`REPORT_PREFILL_IDS`) cannot drift from the page
 * that fills them.
 */
import { OFFICIAL_OWNER, OFFICIAL_REPO, type Kind } from "../lib.js";

/** The issue form that receives a report. */
export const REPORT_TEMPLATE = "report-document.yml";

/** Where a report lands: a new issue in the catalogue repository. */
export const REPORT_ISSUE_HREF =
  `https://github.com/${OFFICIAL_OWNER}/${OFFICIAL_REPO}/issues/new`;

/** GitHub's own form, for a whole repository the catalogue must not touch. */
export const REPORT_REPOSITORY_HREF = "https://github.com/contact/report-content";

/**
 * The issue-form field ids the catalogue pre-fills, in URL order. The form
 * ships these exact ids in `.github/ISSUE_TEMPLATE/report-document.yml`.
 */
export const REPORT_PREFILL_IDS = ["document", "kind", "source"] as const;

export type ReportPrefillId = (typeof REPORT_PREFILL_IDS)[number];

/** The issue title a report opens with: kind, repository and slug. */
export function reportTitle(kind: Kind, owner: string, repo: string, slug: string): string {
  return `Report: ${kind} ${owner}/${repo}/${slug}`;
}

/** The values the form fields receive, keyed by their own ids. */
export function reportPrefill(
  kind: Kind,
  owner: string,
  repo: string,
  pageUrl: string,
): Record<ReportPrefillId, string> {
  return { document: pageUrl, kind, source: `${owner}/${repo}` };
}

/**
 * The pre-filled issue URL. Parameter order is pinned — template, title,
 * then the form's own ids — and every value is percent-encoded once, so a
 * slug or repository carrying `-` or `.` survives unchanged.
 */
export function reportUrl(
  kind: Kind,
  owner: string,
  repo: string,
  slug: string,
  pageUrl: string,
): string {
  const prefill = reportPrefill(kind, owner, repo, pageUrl);
  const params: Array<[string, string]> = [
    ["template", REPORT_TEMPLATE],
    ["title", reportTitle(kind, owner, repo, slug)],
    ...REPORT_PREFILL_IDS.map((id): [string, string] => [id, prefill[id]]),
  ];
  return `${REPORT_ISSUE_HREF}?${params
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&")}`;
}
