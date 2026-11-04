// SPDX-License-Identifier: Apache-2.0
/**
 * Pure route parsing for graphs.univerlab.org.
 *
 * Nothing here touches the network, the clock or a global: the Worker calls
 * these functions and the tests call them too. The one contract that matters
 * is the redirect URL — GitHub stays the download origin and trust anchor, so
 * the Worker only ever answers "where is this document", never its content.
 */

export type Kind = "graph" | "node";

export type Client = "canopy" | "curl" | "browser" | "other";

export type Outcome = "redirect" | "bad-request";

/** GitHub owner rule: 1-39 characters, alphanumerics or hyphens, no leading or trailing hyphen. */
export const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/** GitHub repository rule: 1-100 characters of letters, digits, `_`, `.` or `-`. */
export const REPO_RE = /^[a-zA-Z0-9_.-]{1,100}$/;

/**
 * Literal copy of `src/slug.ts`'s `^[a-z0-9-]{1,48}$`. That module imports
 * `node:path`, which does not exist in a Worker, so the rule is copied rather
 * than imported; the worker test suite pins the two to the same string.
 */
export const SLUG_PATTERN = "^[a-z0-9-]{1,48}$";

export const SLUG_RE = /^[a-z0-9-]{1,48}$/;

/** A git ref: branch, tag or commit sha. Never empty, never leading punctuation. */
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export const DEFAULT_REF = "HEAD";

export const OFFICIAL_OWNER = "UniverLab";

export const OFFICIAL_REPO = "canopy-graphs";

/** True when owner/repo names the official catalogue repository. */
export function isOfficialRepo(owner: string, repo: string): boolean {
  return (
    owner.toLowerCase() === OFFICIAL_OWNER.toLowerCase() &&
    repo.toLowerCase() === OFFICIAL_REPO.toLowerCase()
  );
}

/** The official repository, plus the shared slug rule, for callers of buildUrl. */
export const OFFICIAL_REPOSITORY = `${OFFICIAL_OWNER}/${OFFICIAL_REPO}`;

/** The placeholder recorded for a part a bad request did not supply. */
const UNKNOWN = "?";

export const USAGE = [
  "graphs.univerlab.org redirects to the document on GitHub.",
  "",
  "  GET /i/<kind>/<slug>                  official: UniverLab/canopy-graphs",
  "  GET /i/<owner>/<repo>/<kind>/<slug>   community repository",
  "",
  "<kind> is graph or node; ?ref=<branch|tag|commit> defaults to HEAD.",
  "",
  "example: /i/graph/hello-graph",
].join("\n");

/** A parsed install target: everything needed to build the redirect URL. */
export interface Target {
  official: boolean;
  owner: string;
  repo: string;
  kind: Kind;
  slug: string;
  ref: string;
}

/** The countable parts of a request, with `?` where a bad request had none. */
export interface Parts {
  kind: string;
  owner: string;
  repo: string;
  slug: string;
}

/** A rejected request: 404 for the bare `/i/` and for non-`/i` paths, 400 for a malformed install. */
export interface Rejection extends Parts {
  status: 400 | 404;
  reason: string;
}

export type Parsed =
  | { ok: true; target: Target }
  | { ok: false; rejection: Rejection };

function reject(reason: string, parts: Partial<Parts> = {}, status: 400 | 404 = 400): Parsed {
  return {
    ok: false,
    rejection: {
      status,
      reason,
      kind: parts.kind ?? UNKNOWN,
      owner: parts.owner ?? UNKNOWN,
      repo: parts.repo ?? UNKNOWN,
      slug: parts.slug ?? UNKNOWN,
    },
  };
}

function kindOf(segment: string): Kind | null {
  return segment === "graph" || segment === "node" ? segment : null;
}

/** Collapse the multi-line usage text into a single line for a 400 reason. */
function onOneLine(text: string): string {
  return text.replace(/\n/g, " ");
}

function splitPath(pathname: string): string[] {
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed === "" ? [] : trimmed.split("/");
}

type RefCheck = { ok: true; ref: string } | { ok: false; reason: string };

/** Read a `?ref=` value: absent means HEAD, but an empty one is still invalid. */
function readRef(ref: string | null): RefCheck {
  if (ref === null) {
    return { ok: true, ref: DEFAULT_REF };
  }
  if (!REF_RE.test(ref)) {
    return { ok: false, reason: "ref must be a branch, tag or commit sha (1-128 URL-safe characters)" };
  }
  return { ok: true, ref };
}

function finish(
  official: boolean,
  parts: { owner: string; repo: string; kind: Kind; slug: string },
  ref: string | null,
): Parsed {
  const checked = readRef(ref);
  if (!checked.ok) {
    return reject(checked.reason, parts);
  }
  return { ok: true, target: { official, ...parts, ref: checked.ref } };
}

function official(kindSegment: string, slug: string, ref: string | null): Parsed {
  const base = { owner: OFFICIAL_OWNER, repo: OFFICIAL_REPO };
  const kind = kindOf(kindSegment);
  if (kind === null) {
    return reject("kind must be graph or node", base);
  }
  if (!SLUG_RE.test(slug)) {
    return reject("slug must be 1-48 characters of a-z, 0-9 or -", { ...base, kind });
  }
  return finish(true, { ...base, kind, slug }, ref);
}

function community(
  owner: string,
  repo: string,
  kindSegment: string,
  slug: string,
  ref: string | null,
): Parsed {
  const validOwner = OWNER_RE.test(owner);
  const validRepo = REPO_RE.test(repo);
  const kind = kindOf(kindSegment);
  if (!validOwner) {
    return reject("owner must follow GitHub rules: 1-39 letters, digits or -, no leading or trailing -");
  }
  if (!validRepo) {
    return reject("repo must follow GitHub rules: 1-100 characters of letters, digits, _, . or -", {
      owner,
    });
  }
  if (kind === null) {
    return reject("kind must be graph or node", { owner, repo });
  }
  if (!SLUG_RE.test(slug)) {
    return reject("slug must be 1-48 characters of a-z, 0-9 or -", { owner, repo, kind });
  }
  return finish(false, { owner, repo, kind, slug }, ref);
}

/**
 * The router: one case per route shape, keyed by the segment count after
 * `/i`. A later spec adds its route by adding a case here; `fetch` never
 * needs to change.
 */
function route(segments: string[], ref: string | null): Parsed {
  if (segments.length === 3) {
    return official(segments[1], segments[2], ref);
  }
  if (segments.length === 5) {
    return community(segments[1], segments[2], segments[3], segments[4], ref);
  }
  return reject(`unknown route; ${onOneLine(USAGE)}`);
}

/**
 * Parse a request path and `?ref=` value into a target, a rejection, or the
 * bare `/i/` landing (a 404 whose body is the usage text).
 */
export function parseTarget(pathname: string, ref: string | null): Parsed {
  const segments = splitPath(pathname);
  if (segments.length === 0 || (segments.length === 1 && segments[0] === "i")) {
    return reject("no install target", {}, 404);
  }
  if (segments[0] !== "i") {
    // Not an install URL at all: a 404 with the same one-line usage
    // reason, so crawlers read it as "nothing here" rather than a
    // client error. A malformed /i/... request keeps its 400 below.
    return reject(`unknown route; ${onOneLine(USAGE)}`, {}, 404);
  }
  return route(segments, ref);
}

/**
 * Where the document really lives. This is the only URL the Worker hands
 * out. Official and community documents share one layout — the official
 * repository is an ordinary catalogue repository — so the path only ever
 * names the owner, repo, kind and slug.
 */
export function buildUrl(target: Target): string {
  return `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref}/${target.kind}s/${target.slug}/${target.kind}.json`;
}

const CANOPY_RE = /^canopy\/([0-9A-Za-z][0-9A-Za-z.+-]{0,31})/;

/** The Canopy version a Canopy client announced, or `""` for anything else. */
export function canopyVersion(userAgent: string | null): string {
  const match = CANOPY_RE.exec(userAgent ?? "");
  return match?.[1] ?? "";
}

/**
 * Coarse client class. Deliberately not the raw user-agent: the only question
 * worth answering is whether Canopy, a script or a person asked.
 */
export function clientClass(userAgent: string | null): Client {
  if (canopyVersion(userAgent) !== "") {
    return "canopy";
  }
  const ua = (userAgent ?? "").toLowerCase();
  if (ua.includes("curl")) {
    return "curl";
  }
  if (ua.includes("mozilla")) {
    return "browser";
  }
  return "other";
}

/** The Analytics Engine index: one string naming exactly what was asked for. */
export function indexKey(parts: Parts): string {
  return [parts.owner, parts.repo, parts.kind, parts.slug].join("/");
}

/** The blob that says which document was asked for, without repeating owner/repo. */
export function documentKey(parts: Parts): string {
  return `${parts.owner}/${parts.repo}/${parts.slug}`;
}
