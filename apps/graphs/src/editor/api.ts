// SPDX-License-Identifier: Apache-2.0
/**
 * The three API surfaces the editor calls — nothing else in the Worker
 * is touched:
 *
 *   GET  /api/g|n/<owner>/<repo>/<slug>   one document (ref mapped here,
 *                                         client-side: `slug` means the
 *                                         official repository, `owner/
 *                                         repo/slug` a community one)
 *   GET  /api/official, /api/search       the palette's catalogue rows
 *   POST /api/drafts, GET /api/drafts/<id>  the one-use share
 *
 * Every failure arrives as an `ApiError` carrying the API's own message
 * (and its problem paths, when it answers 400 with them), so the UI
 * shows the text the Worker wrote instead of inventing one.
 */
import { isRecord, isString, type JsonValue } from "../json.js";
import { OFFICIAL_OWNER, OFFICIAL_REPO } from "../lib.js";
import { INDEXING_BODY } from "../pages/copy.js";

/** The catalogue row the palette needs from `/api/official` and `/api/search`. */
export interface CatalogRow {
  kind: "graph" | "node";
  slug: string;
  name: string;
  repo: string;
  description: string;
}

/** A typed API failure: the status and the API's own words. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The message a failure body carries, or the status's own story. */
function messageOf(body: unknown, status: number): string {
  if (isRecord(body)) {
    if (isString(body["message"]) && body["message"] !== "") {
      return body["message"];
    }
    if (body["error"] === "indexing") {
      return INDEXING_BODY;
    }
  }
  if (status === 404) {
    return "no such document";
  }
  return `the server answered ${status}`;
}

/** The `path: message` lines a typed 400 body carries, if any. */
function problemsOf(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body["problems"])) {
    return [];
  }
  return body["problems"].flatMap((entry) =>
    isRecord(entry)
      ? [`${isString(entry["path"]) ? entry["path"] : "#"}: ${isString(entry["message"]) ? entry["message"] : "invalid"}`]
      : [],
  );
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError("the network did not answer", 0);
  }
  let body: unknown = null;
  try {
    body = (await response.json()) as unknown;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new ApiError(messageOf(body, response.status), response.status, problemsOf(body));
  }
  return body;
}

/**
 * Map an install ref to its API path: one segment is an official slug,
 * three are `owner/repo/slug`; anything else is no ref at all.
 */
export function refPath(kind: "g" | "n", ref: string): string | null {
  const parts = ref.split("/").filter((part) => part !== "");
  const segment = (part: string): string => encodeURIComponent(part);
  if (parts.length === 1 && parts[0] !== undefined) {
    return `/api/${kind}/${segment(OFFICIAL_OWNER)}/${segment(OFFICIAL_REPO)}/${segment(parts[0])}`;
  }
  if (parts.length === 3 && parts.every((part) => part !== "")) {
    return `/api/${kind}/${parts.map(segment).join("/")}`;
  }
  return null;
}

/** The `document` one `/api/g` or `/api/n` answer carries. */
export async function fetchDocument(kind: "g" | "n", ref: string): Promise<Record<string, JsonValue>> {
  const path = refPath(kind, ref);
  if (path === null) {
    throw new ApiError(`"${ref}" is not a document ref`, 400);
  }
  const body = await request(path);
  if (!isRecord(body) || !isRecord(body["document"])) {
    throw new ApiError("the answer held no document", 502);
  }
  return body["document"];
}

function rowsOf(value: unknown): CatalogRow[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) =>
    isRecord(entry) && isString(entry["name"]) && isString(entry["slug"]) && isString(entry["repo"])
      ? [{
          kind: entry["kind"] === "node" ? ("node" as const) : ("graph" as const),
          slug: entry["slug"],
          name: entry["name"],
          repo: entry["repo"],
          description: isString(entry["description"]) ? entry["description"] : "",
        }]
      : [],
  );
}

/** The official listing: the palette shows its `nodes`. */
export async function fetchOfficial(): Promise<{ graphs: CatalogRow[]; nodes: CatalogRow[] }> {
  const body = await request("/api/official");
  if (!isRecord(body)) {
    throw new ApiError("the answer was not a listing", 502);
  }
  return { graphs: rowsOf(body["graphs"]), nodes: rowsOf(body["nodes"]) };
}

/** A free-text search; the palette keeps the node rows only. */
export async function fetchSearch(q: string): Promise<CatalogRow[]> {
  const body = await request(`/api/search?q=${encodeURIComponent(q)}&sort=top&page=1`);
  if (!isRecord(body)) {
    throw new ApiError("the answer was not a search result", 502);
  }
  return rowsOf(body["items"]);
}

/** What `POST /api/drafts` answers on 201. */
export interface DraftCreated {
  id: string;
  install: string;
  page_url: string;
  expires_at: string;
  name: string;
}

/** Store the graph as a one-use draft; the API validates it again there. */
export async function createDraft(document: JsonValue): Promise<DraftCreated> {
  const body = await request("/api/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "graph", document }),
  });
  if (!isRecord(body) || !isString(body["id"]) || !isString(body["install"]) ||
    !isString(body["page_url"]) || !isString(body["expires_at"])) {
    throw new ApiError("the draft answer was incomplete", 502);
  }
  return {
    id: body["id"],
    install: body["install"],
    page_url: body["page_url"],
    expires_at: body["expires_at"],
    name: isString(body["name"]) ? body["name"] : "",
  };
}

/** What `GET /api/drafts/<id>` answers: the stored draft, never consumed. */
export async function fetchDraft(id: string): Promise<{ kind: string; document: Record<string, JsonValue> }> {
  if (!/^[0-9a-hjkmnp-tv-z]{26}$/.test(id)) {
    throw new ApiError("that is not a draft id", 400);
  }
  const body = await request(`/api/drafts/${encodeURIComponent(id)}`);
  if (!isRecord(body) || !isRecord(body["document"]) || !isString(body["kind"])) {
    throw new ApiError("the draft answer was incomplete", 502);
  }
  return { kind: body["kind"], document: body["document"] };
}
