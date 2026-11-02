// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderPair } from "../src/entry-views.js";
import type { EntryViewHooks } from "../src/entry-views.js";

function entryHooks(overrides: Partial<EntryViewHooks> = {}): EntryViewHooks {
  return {
    header: () => `<header class="topbar"><div class="topbar-inner"></div></header>`,
    online: () => [{ host_id: "h1", label: "demo host" }],
    paired: () => [],
    draft: () => ({ code: "", hostId: "h1", label: "" }),
    snapshotDraft: () => {},
    pairError: () => null,
    pairBusy: () => false,
    setPairError: () => {},
    onPair: () => {},
    onConnect: () => {},
    onPairAgain: () => {},
    ...overrides,
  };
}

describe("entry views", () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
    document.body.innerHTML = "";
  });

  it("pairing_screen_explains_code_source", () => {
    renderPair(root, entryHooks());
    const hint = root.querySelector(".pair-hint");
    expect(hint?.textContent).toBe("Run canopy remote pair on your machine to get a code");
    expect(hint?.querySelector("code")?.textContent).toBe("canopy remote pair");
    const codeLabel = root.querySelector("#pair-code")?.closest("label");
    expect(codeLabel?.nextElementSibling).toBe(hint);
  });
});
