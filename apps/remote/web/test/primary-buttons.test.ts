// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Builder } from "../src/builder.js";
import { CatalogStore } from "../src/catalog.js";
import { renderPair, renderSignIn } from "../src/entry-views.js";
import type { EntryViewHooks } from "../src/entry-views.js";
import { NewDialog } from "../src/new-dialog.js";
import type { Catalog } from "../src/protocol.js";
import { FakeStorage } from "./fakes.js";

const CATALOG: Catalog = {
  clis: [{ cli: "muse", label: "Muse", models: ["spark"], yolo: true }],
  projects: [{ name: "demo", path: "/home/u/demo" }],
  presets: [],
  skills: [],
};

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

describe("primary buttons", () => {
  const roots: HTMLElement[] = [];

  const mount = (): HTMLDivElement => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    roots.push(root);
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) {
      root.remove();
    }
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("primary_buttons_share_teal_style", () => {
    const signinRoot = mount();
    renderSignIn(signinRoot, entryHooks());
    const signin = signinRoot.querySelector<HTMLButtonElement>("#signin-go");
    expect(signin?.textContent).toBe("Sign in with GitHub");
    expect(signin?.classList.contains("primary")).toBe(true);

    const pairRoot = mount();
    renderPair(pairRoot, entryHooks());
    const pair = pairRoot.querySelector<HTMLButtonElement>('#pair-form button[type="submit"]');
    expect(pair?.textContent).toBe("Pair");
    expect(pair?.classList.contains("primary")).toBe(true);

    const newRoot = mount();
    const catalog = new CatalogStore();
    catalog.replace(CATALOG);
    const dialog = new NewDialog(catalog, { onSpawn: () => true }, { sessions: [], hostId: "h1" });
    dialog.open(newRoot);
    const create = newRoot.querySelector<HTMLButtonElement>("#new-create");
    expect(create?.textContent).toBe("Create");
    expect(create?.classList.contains("primary")).toBe(true);
    dialog.close();

    const builderRoot = mount();
    const builderCatalog = new CatalogStore();
    builderCatalog.replace(CATALOG);
    const builder = new Builder(
      builderCatalog,
      { onCompose: () => true, onSend: () => true },
      new FakeStorage(),
    );
    builder.open(builderRoot);
    const builderSend = builderRoot.querySelector<HTMLButtonElement>("#builder-send");
    expect(builderSend?.textContent).toBe("Send");
    expect(builderSend?.classList.contains("primary")).toBe(true);
    builder.close();

    const path = isAbsolute("apps/remote/web/src/styles.css")
      ? "apps/remote/web/src/styles.css"
      : join(process.cwd(), "apps/remote/web/src/styles.css");
    const styles = readFileSync(path, "utf8");
    expect(styles).not.toContain("cta-gradient");
    const primaryRule = styles.slice(styles.indexOf("button.primary"));
    expect(primaryRule.slice(0, primaryRule.indexOf("}"))).toContain("background: var(--accent)");
    expect(primaryRule.slice(0, primaryRule.indexOf("}"))).toContain("color: var(--accent-ink)");
  });
});
