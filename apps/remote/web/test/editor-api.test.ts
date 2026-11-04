// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's one HTTP call: `POST https://graphs.univerlab.org/api/drafts`.
 *
 * Two things are held here because the browser tests route the request to a
 * canned answer and therefore never exercise them: the request must stay a
 * *simple* CORS request (the catalogue's preflight lists the origin and the
 * methods, not `access-control-allow-headers`, so a preflighted POST is
 * refused before it is sent), and a failure must surface the API's own
 * words rather than an invented one.
 */
import { describe, expect, it } from "vitest";
import { ApiError, DRAFTS_URL, createRemoteDraft } from "../src/editor/api.js";

/** A fetch stand-in that records the call and answers `body` with `status`. */
function fakeFetch(body: unknown, status = 201): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const CREATED = {
  id: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
  kind: "graph",
  name: "untitled",
  expires_at: "2026-10-28T12:30:00.000Z",
  page_url: "https://graphs.univerlab.org/d/aaaaaaaaaaaaaaaaaaaaaaaaaa",
  install: "canopy graph install draft:aaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const DOCUMENT = { format_version: 6, name: "chain", nodes: [], edges: [] };

describe("createRemoteDraft", () => {
  it("stays a simple request: no content-type, no custom header", async () => {
    const { calls, fetchImpl } = fakeFetch(CREATED);
    await createRemoteDraft(DOCUMENT, fetchImpl);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(DRAFTS_URL);
    expect(call?.init?.method).toBe("POST");
    // A `content-type: application/json` would make this a preflighted
    // request, and the catalogue's preflight answer does not allow headers.
    expect(call?.init?.headers).toBeUndefined();
    // The body is still the `{ kind, document }` the API parses.
    expect(JSON.parse(String(call?.init?.body))).toEqual({ kind: "graph", document: DOCUMENT });
  });

  it("answers the stored draft with its one-use install command", async () => {
    const { fetchImpl } = fakeFetch(CREATED);
    await expect(createRemoteDraft(DOCUMENT, fetchImpl)).resolves.toEqual({
      id: CREATED.id,
      install: "canopy graph install draft:aaaaaaaaaaaaaaaaaaaaaaaaaa",
      expires_at: CREATED.expires_at,
      name: "untitled",
    });
  });

  it("carries the API's own message and problem paths on a refusal", async () => {
    const { fetchImpl } = fakeFetch(
      {
        kind: "invalid-document",
        message: "the draft document did not validate",
        status: 400,
        problems: [{ path: "#/nodes/0/config", message: "must not bind a harness" }],
        total: 1,
      },
      400,
    );
    const error = await createRemoteDraft(DOCUMENT, fetchImpl).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("the draft document did not validate");
    expect((error as ApiError).problems).toEqual([
      "#/nodes/0/config: must not bind a harness",
    ]);
  });

  it("tells a missing route from a silent one", async () => {
    const gone = fakeFetch({}, 404);
    const notFound = await createRemoteDraft(DOCUMENT, gone.fetchImpl).catch((caught: unknown) => caught);
    expect((notFound as ApiError).message).toBe("no such document");

    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const silent = await createRemoteDraft(DOCUMENT, offline).catch((caught: unknown) => caught);
    expect(silent).toBeInstanceOf(ApiError);
    expect((silent as ApiError).status).toBe(0);
    expect((silent as ApiError).message).toBe("the drafts API did not answer");
  });

  it("refuses an incomplete 201 instead of showing half a draft", async () => {
    const { fetchImpl } = fakeFetch({ id: CREATED.id });
    const error = await createRemoteDraft(DOCUMENT, fetchImpl).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("the draft answer was incomplete");
  });
});
