// SPDX-License-Identifier: Apache-2.0
/**
 * The one API surface the remote editor calls: the catalogue's drafts.
 *
 *   POST https://graphs.univerlab.org/api/drafts   store a one-use draft
 *
 * The catalogue answers CORS-open (GET, POST, OPTIONS), so the browser
 * posts straight there — no relay round trip. Every failure arrives as
 * an `ApiError` carrying the API's own message (and its problem paths,
 * when it answers 400 with them), so the UI shows the text the Worker
 * wrote instead of inventing one.
 *
 * The request is deliberately a *simple* one — a string body, no
 * `content-type: application/json` — because the catalogue's preflight
 * allows the origin and the methods but no headers, so any request that
 * needs a preflight is refused by the browser before it leaves the page.
 * The API reads the body with `JSON.parse` and never looks at the header.
 */
import { isRecord, isString } from "../../../../../packages/plate/guards.js";
import type { JsonValue } from "../../../../../src/schema.js";

/** Where drafts live: the catalogue Worker's public drafts route. */
export const DRAFTS_URL = "https://graphs.univerlab.org/api/drafts";

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

/** What `POST /api/drafts` answers on 201. */
export interface DraftCreated {
  id: string;
  install: string;
  expires_at: string;
  name: string;
}

/** Store the graph as a one-use draft; the API validates it again there. */
export async function createRemoteDraft(
  document: JsonValue,
  fetchImpl: typeof fetch = fetch,
  url: string = DRAFTS_URL,
): Promise<DraftCreated> {
  let response: Response;
  try {
    // No content-type: a bare string body goes as `text/plain;charset=UTF-8`,
    // which is CORS-safelisted. Setting `application/json` would force a
    // preflight the catalogue's CORS answer does not grant (it lists the
    // origin and the methods, not the header), and the browser would refuse
    // the draft before sending it.
    response = await fetchImpl(url, {
      method: "POST",
      body: JSON.stringify({ kind: "graph", document }),
    });
  } catch {
    throw new ApiError("the drafts API did not answer", 0);
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
  if (!isRecord(body) || !isString(body["id"]) || !isString(body["install"]) || !isString(body["expires_at"])) {
    throw new ApiError("the draft answer was incomplete", 502);
  }
  return {
    id: body["id"],
    install: body["install"],
    expires_at: body["expires_at"],
    name: isString(body["name"]) ? body["name"] : "",
  };
}
