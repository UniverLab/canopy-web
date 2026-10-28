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
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "graph", document }),
    });
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
