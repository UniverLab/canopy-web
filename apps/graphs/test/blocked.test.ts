// SPDX-License-Identifier: Apache-2.0
/**
 * The removal list's pure side and its KV read: entry parsing, the keys the
 * indexer writes, the match the request path asks for, and the store lookup
 * that reads a document block before its repository block.
 */
import { describe, expect, it } from "vitest";
import {
  blockedDocKey,
  blockedDocument,
  blockedEntryOf,
  blockedKey,
  blockedRepoKey,
  blockedRepository,
  parseBlockedList,
  parseBlockedValue,
  type BlockedEntry,
} from "../src/blocked.js";
import { createStore, resetIndexMemo } from "../src/store.js";
import { FakeKV } from "./fakes.js";

/** The issue every fixture was decided on. */
const ISSUE = "https://github.com/UniverLab/canopy-web/issues/42";

function documentBlock(slug = "toxic"): BlockedEntry {
  return {
    kind: "graph",
    repo: "acme/things",
    slug,
    reason: "Malicious or dangerous command",
    issue: ISSUE,
    blocked_at: "2026-10-27",
  };
}

function repositoryBlock(): BlockedEntry {
  return {
    repo: "acme/eviltools",
    reason: "Prompt that steers the agent to do harm",
    issue: ISSUE,
    blocked_at: "2026-10-27",
  };
}

describe("the blocked list", () => {
  it("parses a document block and a repository block", () => {
    const text = JSON.stringify([documentBlock(), repositoryBlock()]);
    expect(parseBlockedList(text)).toEqual([documentBlock(), repositoryBlock()]);
    expect(parseBlockedList("[]")).toEqual([]);
  });

  it("drops malformed entries and refuses text that is not an array", () => {
    const text = JSON.stringify([
      documentBlock(),
      { repo: "acme/things", reason: "no issue", blocked_at: "2026-10-27" },
      { repo: "not-a-repo", reason: "x", issue: ISSUE, blocked_at: "2026-10-27" },
      { repo: "acme/things", slug: "no-kind", reason: "x", issue: ISSUE, blocked_at: "2026-10-27" },
      "nonsense",
    ]);
    expect(parseBlockedList(text)).toEqual([documentBlock()]);
    expect(parseBlockedList("{}")).toBeNull();
    expect(parseBlockedList("not json")).toBeNull();
  });

  it("reads one stored entry back", () => {
    expect(parseBlockedValue(JSON.stringify(documentBlock()))).toEqual(documentBlock());
    expect(parseBlockedValue("not json")).toBeNull();
    expect(parseBlockedValue(JSON.stringify({ repo: "acme/things" }))).toBeNull();
  });

  it("builds keys that mirror docKey, and a repo key without a slug", () => {
    expect(blockedDocKey("graph", "Acme", "Things", "toxic")).toBe(
      "blocked:v1:graph:acme/things/toxic",
    );
    expect(blockedRepoKey("Acme", "EvilTools")).toBe("blocked:v1:repo:acme/eviltools");
    expect(blockedKey(documentBlock())).toBe("blocked:v1:graph:acme/things/toxic");
    expect(blockedKey(repositoryBlock())).toBe("blocked:v1:repo:acme/eviltools");
    expect(blockedKey({ ...documentBlock(), kind: undefined })).toBeNull();
    expect(blockedKey({ ...documentBlock(), repo: "not-a-repo" })).toBeNull();
  });

  it("matches one document, one repository, and leaves the rest listed", () => {
    const entries = [documentBlock(), repositoryBlock()];
    expect(blockedDocument(entries, "graph", "Acme", "Things", "toxic")).toEqual(documentBlock());
    expect(blockedDocument(entries, "graph", "acme", "eviltools", "flow")).toEqual(
      repositoryBlock(),
    );
    // The slug matches, the kind does not.
    expect(blockedDocument(entries, "node", "acme", "things", "toxic")).toBeNull();
    // The repository matches, the slug does not.
    expect(blockedDocument(entries, "graph", "acme", "things", "flow")).toBeNull();
    expect(blockedDocument(entries, "graph", "other", "things", "toxic")).toBeNull();
    expect(blockedRepository(entries, "acme", "things")).toBeNull();
    expect(blockedRepository(entries, "acme", "eviltools")).toEqual(repositoryBlock());
  });

  it("keeps a fixture well-formed for the entry parser", () => {
    expect(blockedEntryOf(documentBlock())).toEqual(documentBlock());
    expect(blockedEntryOf({ ...documentBlock(), kind: "preset" })).toBeNull();
  });
});

describe("the blocked read side", () => {
  it("reads a document block, then a repository block", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    await kv.put(blockedDocKey("graph", "acme", "things", "toxic"), JSON.stringify(documentBlock()));
    await kv.put(blockedRepoKey("acme", "eviltools"), JSON.stringify(repositoryBlock()));
    const store = createStore(kv);

    expect(await store.getBlocked("graph", "ACME", "Things", "toxic")).toEqual(documentBlock());
    expect(await store.getBlocked("node", "acme", "eviltools", "flow")).toEqual(repositoryBlock());
    expect(await store.getBlocked("node", "acme", "things", "toxic")).toBeNull();
    expect(await store.getBlocked("graph", "acme", "things", "flow")).toBeNull();
  });

  it("prefers the document's own block when both keys exist", async () => {
    resetIndexMemo();
    const kv = new FakeKV();
    await kv.put(blockedDocKey("graph", "acme", "things", "toxic"), JSON.stringify(documentBlock()));
    await kv.put(blockedRepoKey("acme", "things"), JSON.stringify(repositoryBlock()));
    expect(await createStore(kv).getBlocked("graph", "acme", "things", "toxic")).toEqual(
      documentBlock(),
    );
  });

  it("answers null for a missing binding, a missing key and a corrupt value", async () => {
    resetIndexMemo();
    expect(await createStore(undefined).getBlocked("graph", "a", "b", "c")).toBeNull();
    const kv = new FakeKV();
    await kv.put(blockedRepoKey("acme", "things"), "not json");
    expect(await createStore(kv).getBlocked("graph", "acme", "things", "flow")).toBeNull();
  });
});
