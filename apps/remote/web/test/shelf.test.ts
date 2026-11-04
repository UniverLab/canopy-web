// SPDX-License-Identifier: Apache-2.0
// The session shelf outside the browser: the transfer queue (parts,
// sha256, concurrency, busy), the blob URL cache, the unseen badge and
// the two surfaces — all of it gated on hello.features "shelf".

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell, ShellCallbacks } from "../src/app.js";
import type { SessionItem, ShelfItem } from "../src/protocol.js";
import { BlobLru, ShelfFetcher } from "../src/shelf-store.js";
import { ShelfController } from "../src/shelf-controller.js";
import { ShelfSheet } from "../src/shelf.js";
import { SessionStore } from "../src/sessions.js";

const CALLBACKS: ShellCallbacks = {
  onPair: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
  onRetry: () => {},
  onPairAgain: () => {},
  onOpenSession: () => {},
  onLeaveSession: () => {},
  onSignOut: () => {},
  onForgetDevice: () => {},
  onKeyPress: () => {},
  onTerminalInput: () => {},
  onControlSize: () => {},
  onReleaseSize: () => {},
  onSpawn: () => true,
  onCompose: () => true,
  onSendDraft: () => true,
  onSchedule: () => true,
  onScheduledList: () => true,
  onScheduledCancel: () => true,
  onGraphsRequest: () => {},
  onWatchGraph: () => {},
  onUnwatchGraph: () => {},
};

function shelfItem(overrides: Partial<ShelfItem> = {}): ShelfItem {
  return {
    file_id: "f1",
    session_id: "s1",
    name: "gradient.png",
    mime: "image/png",
    size: 4096,
    caption: "colour wash",
    from: "muse",
    created_at: 1793100000_000,
    ...overrides,
  };
}

function session(id: string, name: string): SessionItem {
  return {
    id,
    name,
    cli: "muse",
    model: "spark",
    workdir: "/home/u/demo",
    status: "running",
    kind: "agent",
    lastOutputAt: 1793100000_000,
  };
}

interface TransferHarness {
  sent: string[];
  blobs: { fileId: string; url: string; bytes: Uint8Array }[];
  fetcher: ShelfFetcher;
  lru: BlobLru;
}

function transferHarness(maxBytes?: number): TransferHarness {
  const sent: string[] = [];
  const blobs: { fileId: string; url: string; bytes: Uint8Array }[] = [];
  const lru = new BlobLru(maxBytes);
  const fetcher = new ShelfFetcher({
    send: (data) => {
      sent.push(data);
      return true;
    },
    lru,
    onBlob: (fileId, url, bytes) => blobs.push({ fileId, url, bytes }),
  });
  return { sent, blobs, fetcher, lru };
}

interface ShellHarness {
  root: HTMLDivElement;
  sessions: SessionStore;
  shelf: ShelfController;
  shell: Shell;
  sent: string[];
}

function shellHarness(): ShellHarness {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const sessions = new SessionStore();
  const sent: string[] = [];
  const shelf = new ShelfController({
    send: (data) => {
      sent.push(data);
      return true;
    },
    sessions,
  });
  const shell = createShell(root, sessions, CALLBACKS, { shelf });
  return { root, sessions, shelf, shell, sent };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("shelf transfers", () => {
  it("reassembles parts in order and matches the sha256", () => {
    const { sent, blobs, fetcher, lru } = transferHarness();
    const target = shelfItem();
    fetcher.ensure(target);
    expect(sent).toHaveLength(1);
    const req = (JSON.parse(sent[0] ?? "") as { req: string }).req;

    const original = new Uint8Array(40 * 1024);
    for (let i = 0; i < original.length; i += 1) {
      original[i] = (i * 31 + 7) % 256;
    }
    const PART = 12 * 1024;
    const count = Math.ceil(original.length / PART);
    expect(count).toBeGreaterThan(1);
    for (let part = 0; part < count; part += 1) {
      const handled = fetcher.handlePart({
        req,
        file_id: target.file_id,
        part,
        data: original.subarray(part * PART, Math.min(original.length, (part + 1) * PART)),
        last: part === count - 1,
      });
      expect(handled).toBe(true);
    }

    expect(blobs).toHaveLength(1);
    const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    expect(sha(blobs[0]!.bytes)).toBe(sha(original));
    expect(blobs[0]!.url).toMatch(/^blob:/);
    expect(blobs[0]!.fileId).toBe(target.file_id);
    expect(lru.get(target.file_id)).toBe(blobs[0]!.url);

    // Cached now: the same cell asks for nothing.
    fetcher.ensure(target);
    expect(sent).toHaveLength(1);
  });

  it("runs at most two transfers and finishes the queue behind them", () => {
    const { sent, fetcher } = transferHarness();
    const one = shelfItem({ file_id: "f1" });
    const two = shelfItem({ file_id: "f2" });
    const three = shelfItem({ file_id: "f3" });
    fetcher.ensure(one);
    fetcher.ensure(two);
    fetcher.ensure(three);
    expect(sent).toHaveLength(2);

    const first = (JSON.parse(sent[0] ?? "") as { req: string; file_id: string }).req;
    fetcher.handlePart({
      req: first,
      file_id: "f1",
      part: 0,
      data: new Uint8Array([1, 2, 3]),
      last: true,
    });
    expect(sent).toHaveLength(3);
    // The third file is the one that started, not a duplicate of any other.
    const asked = sent.map((frame) => (JSON.parse(frame) as { file_id: string }).file_id);
    expect(asked).toEqual(["f1", "f2", "f3"]);
  });

  it("retries a busy file after 500 ms and gives up on not_found", () => {
    vi.useFakeTimers();
    try {
      const { sent, fetcher } = transferHarness();
      fetcher.ensure(shelfItem());
      const req = (JSON.parse(sent[0] ?? "") as { req: string }).req;
      expect(
        fetcher.handleError({ req, code: "busy", message: "shelf is busy" }),
      ).toBe(true);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(499);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('"shelf_get"');

      // not_found is terminal: asking again would change nothing.
      const second = (JSON.parse(sent[1] ?? "") as { req: string }).req;
      expect(
        fetcher.handleError({ req: second, code: "not_found", message: "gone" }),
      ).toBe(true);
      fetcher.ensure(shelfItem());
      expect(sent).toHaveLength(3);

      // Somebody else's error is not this fetcher's business.
      expect(
        fetcher.handleError({ req: "r-other", code: "busy", message: "x" }),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("blob url cache", () => {
  it("revokes evicted urls and keeps a file bigger than the cap", () => {
    const revoked: string[] = [];
    const spy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation((url: string) => {
        revoked.push(url);
      });
    try {
      const lru = new BlobLru(1000);
      const a = lru.put("a", new Uint8Array(600), "image/png");
      const b = lru.put("b", new Uint8Array(600), "image/png");
      // Over the cap: the least recently used url goes first.
      expect(revoked).toEqual([a]);
      expect(lru.get("a")).toBeNull();
      expect(lru.get("b")).toBe(b);
      expect(lru.bytes).toBe(600);

      const c = lru.put("c", new Uint8Array(600), "image/svg+xml");
      expect(revoked).toEqual([a, b]);
      expect(lru.get("b")).toBeNull();
      expect(lru.get("c")).toBe(c);

      // One file larger than the whole cap still stays on screen.
      const big = lru.put("big", new Uint8Array(4000), "image/png");
      expect(lru.get("big")).toBe(big);
      expect(lru.get("c")).toBeNull();
      expect(lru.bytes).toBe(4000);
      expect(revoked).toEqual([a, b, c]);
    } finally {
      spy.mockRestore();
    }
  });

  it("evicts one file's url on request and ignores an unknown id", () => {
    const revoked: string[] = [];
    const spy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation((url: string) => {
        revoked.push(url);
      });
    try {
      const lru = new BlobLru(1000);
      const a = lru.put("a", new Uint8Array(100), "image/png");
      lru.put("b", new Uint8Array(100), "image/png");
      lru.evict("a");
      expect(revoked).toEqual([a]);
      expect(lru.get("a")).toBeNull();
      expect(lru.get("b")).not.toBeNull();
      expect(lru.bytes).toBe(100);
      // Evicting what the cache never held changes nothing.
      lru.evict("missing");
      expect(revoked).toEqual([a]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("preview by sniffed mime", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function openFile(
    harness: ShellHarness,
    item: ShelfItem,
    bytes: Uint8Array,
  ): void {
    harness.shelf.handleHello(["shelf"]);
    harness.shelf.open(harness.root);
    harness.shelf.handleList({ req: null, id: "s1", items: [item] });
    harness.root.querySelector<HTMLButtonElement>(".shelf-cell")?.click();
    const get = harness.sent
      .map((line) => JSON.parse(line) as { t: string; req?: string })
      .filter((frame) => frame.t === "shelf_get")
      .pop();
    harness.shelf.handlePart({
      req: get?.req ?? "",
      file_id: item.file_id,
      part: 0,
      data: bytes,
      last: true,
    });
  }

  it("shows markdown as text nodes, never markup", async () => {
    const harness = shellHarness();
    openFile(
      harness,
      shelfItem({ file_id: "md", name: "notes.md", mime: "text/markdown", caption: null }),
      new TextEncoder().encode("# Title\n<script>alert(1)</script>"),
    );
    await tick();
    const text = document.querySelector<HTMLElement>("#shelf-viewer-text");
    expect(text?.hidden).toBe(false);
    expect(text?.textContent).toContain("# Title");
    expect(text?.textContent).toContain("<script>alert(1)</script>");
    expect(document.querySelector("#shelf-viewer script")).toBeNull();
    expect(document.querySelector<HTMLElement>("#shelf-viewer-card")?.hidden).toBe(true);
  });

  it("shows html only as a download card with a blob link", async () => {
    const harness = shellHarness();
    openFile(
      harness,
      shelfItem({ file_id: "html", name: "page.html", mime: "text/html", caption: null }),
      new TextEncoder().encode("<script>alert(1)</script>"),
    );
    await tick();
    const card = document.querySelector<HTMLElement>("#shelf-viewer-card");
    expect(card?.hidden).toBe(false);
    expect(card?.textContent).toContain("page.html");
    expect(card?.textContent).toContain("Download");
    expect(document.querySelector("#shelf-viewer script")).toBeNull();
    expect(document.querySelector("#shelf-viewer iframe")).toBeNull();
    const link = card?.querySelector<HTMLAnchorElement>(".viewer-download");
    expect(link?.getAttribute("href")).toMatch(/^blob:/);
    expect(link?.getAttribute("download")).toBe("page.html");
    expect(document.querySelector<HTMLElement>("#shelf-viewer-text")?.hidden).toBe(true);
  });
});

describe("shelf surfaces", () => {
  it("hides every shelf surface until hello carries the feature", () => {
    const { root, sessions, shelf, shell, sent } = shellHarness();
    sessions.replace([session("s1", "build")]);
    // No hello yet: the browser sends no shelf frame at all.
    expect(sent).toHaveLength(0);
    // A hello without "shelf" changes nothing either.
    shelf.handleHello([]);
    expect(sent).toHaveLength(0);

    shell.showSessions();
    expect(root.querySelector("#host-shelf-row")).toBeNull();
    expect(root.querySelector(".session-files")).toBeNull();

    shell.showSession("s1", "build");
    const button = root.querySelector<HTMLButtonElement>("#session-files");
    expect(button?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("#session-files-badge")?.hidden).toBe(true);
    // And nothing opens behind a UI that is not there.
    button?.click();
    expect(root.querySelector('[data-sheet="shelf"]')).toBeNull();
  });

  it("counts unseen files and clears the badge when the sheet opens", () => {
    const { root, shelf, shell } = shellHarness();
    shelf.handleHello(["shelf"]);
    shell.showSession("s1", "build");
    const button = root.querySelector<HTMLButtonElement>("#session-files");
    const badge = root.querySelector<HTMLSpanElement>("#session-files-badge");
    expect(button?.hidden).toBe(false);
    expect(badge?.hidden).toBe(true);

    shelf.handleAdded(shelfItem({ file_id: "f1" }));
    shelf.handleAdded(shelfItem({ file_id: "f2" }));
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe("2");

    // Looking at the shelf marks everything on it as seen.
    button?.click();
    expect(root.querySelector('[data-sheet="shelf"]')).not.toBeNull();
    expect(badge?.hidden).toBe(true);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(2);

    // An arrival while the sheet is open is already on screen.
    shelf.handleAdded(shelfItem({ file_id: "f3" }));
    expect(badge?.hidden).toBe(true);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(3);

    // The badge belongs to the session view; leaving drops it with the view.
    shell.showSessions();
    expect(root.querySelector("#session-files")).toBeNull();
  });

  it("revokes a removed file's bytes and refetches a re-added id", () => {
    const { root, shelf, sent } = shellHarness();
    const revoked: string[] = [];
    const spy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation((url: string) => {
        revoked.push(url);
      });
    try {
      shelf.handleHello(["shelf"]);
      shelf.open(root);
      shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
      // The cell is on screen; tapping it asks for the bytes.
      root.querySelector<HTMLButtonElement>(".shelf-cell")?.click();
      const frame = (line: string): { t: string; req: string } => JSON.parse(line);
      const gets = () => sent.filter((line) => frame(line).t === "shelf_get");
      expect(gets()).toHaveLength(1);
      shelf.handlePart({
        req: frame(gets()[0] ?? "").req,
        file_id: "f1",
        part: 0,
        data: new Uint8Array([1, 2, 3]),
        last: true,
      });
      expect(revoked).toHaveLength(0);

      // The host takes the file back: its url dies with it.
      shelf.handleRemoved("f1");
      expect(revoked).toHaveLength(1);
      expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);

      // A new file wearing the same id is fetched again, never stale.
      shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
      root.querySelector<HTMLButtonElement>(".shelf-cell")?.click();
      expect(gets()).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("renders a caption carrying markup as plain text", () => {
    const { root, shelf } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    const caption = `<script>alert("pwn")</script> & friends`;
    shelf.handleList({
      req: null,
      id: "s1",
      items: [shelfItem({ caption })],
    });

    const cell = root.querySelector(".shelf-cell");
    expect(cell).not.toBeNull();
    expect(cell?.textContent).toContain(caption);
    expect(cell?.querySelector("script")).toBeNull();
    expect(root.querySelector(".sheet script")).toBeNull();
    expect(cell?.getAttribute("title")).toBe("gradient.png");
    expect(cell?.querySelector("img")?.getAttribute("src")).toBeNull();
    // The name and the caption are text, and only text.
    expect(cell?.querySelector(".shelf-caption")?.textContent).toBe(caption);
  });

  it("opens the Files folder while its sheet is up", () => {
    const { root, sessions, shelf, shell } = shellHarness();
    sessions.replace([session("s1", "build")]);
    shelf.handleHello(["shelf"]);
    shell.showSession("s1", "build");
    const folder = () => root.querySelector("#session-files-icon")?.getAttribute("data-icon");
    expect(folder()).toBe("folder");
    // The shell listens to the controller: opening and closing the sheet
    // moves the icon, and the sheet's own Esc closes it.
    const files = root.querySelector<HTMLButtonElement>("#session-files");
    expect(files?.hidden).toBe(false);
    files?.click();
    expect(shelf.isOpen()).toBe(true);
    expect(folder()).toBe("folderOpen");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(shelf.isOpen()).toBe(false);
    expect(folder()).toBe("folder");
  });

  it("opens one union sheet from the home row and the session bar", () => {
    const { root, sessions, shelf, shell, sent } = shellHarness();
    sessions.replace([session("s1", "build")]);
    shelf.handleHello(["shelf"]);
    expect(sent.map((frame) => (JSON.parse(frame) as { t: string }).t)).toEqual([
      "shelf_list",
      "shelf_list",
    ]);
    shell.showSessions();
    // The row is up before any reply lands.
    expect(root.querySelector("#host-shelf-row")).not.toBeNull();

    shelf.handleList({
      req: null,
      id: null,
      items: [shelfItem({ file_id: "h1", session_id: null, name: "host-mark.png" })],
    });
    shelf.handleList({
      req: null,
      id: "s1",
      items: [shelfItem({ file_id: "f1" }), shelfItem({ file_id: "f2" })],
    });
    // No per-row counts under a union.
    expect(root.querySelector(".session-files")).toBeNull();
    expect(root.querySelector(".session-files-count")).toBeNull();

    // The home row opens the union: the host file beside the session's.
    root.querySelector<HTMLButtonElement>("#host-shelf-row")?.click();
    expect(root.querySelector('[data-sheet="shelf"]')).not.toBeNull();
    expect(root.querySelector('[data-sheet="shelf"] h2')?.textContent).toBe("Shelf");
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(3);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    // The session bar opens the same union sheet.
    shell.showSession("s1", "build");
    root.querySelector<HTMLButtonElement>("#session-files")?.click();
    expect(root.querySelector('[data-sheet="shelf"] h2')?.textContent).toBe("Shelf");
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(3);
  });
});

describe("union shelf", () => {
  /** The union never deletes: no shelf_delete frame leaves the browser. */
  const noDeleteTraffic = (sent: string[]): void => {
    for (const line of sent) {
      expect((JSON.parse(line) as { t: string }).t).not.toBe("shelf_delete");
    }
  };

  it("merges host and session shelves newest first, deduped by file_id", () => {
    const { root, sessions, shelf, sent } = shellHarness();
    sessions.replace([session("s1", "build"), session("s2", "docs")]);
    shelf.handleHello(["shelf"]);
    shelf.handleList({
      req: null,
      id: null,
      items: [shelfItem({ file_id: "h1", session_id: null, name: "host.png", created_at: 1793100000_000 })],
    });
    shelf.handleList({
      req: null,
      id: "s1",
      items: [
        shelfItem({ file_id: "dup", name: "dup-s1.png", created_at: 1793100060_000 }),
        shelfItem({ file_id: "s1-old", name: "s1-old.png", created_at: 1793099940_000 }),
      ],
    });
    shelf.handleList({
      req: null,
      id: "s2",
      items: [
        shelfItem({ file_id: "dup", session_id: "s2", name: "dup-s2.png", created_at: 1793100120_000 }),
        shelfItem({ file_id: "s2-new", session_id: "s2", name: "s2-new.png", created_at: 1793100180_000 }),
      ],
    });
    shelf.open(root);
    const titles = [...root.querySelectorAll(".shelf-cell")].map((cell) =>
      cell.getAttribute("title"),
    );
    // One row per file_id — the first shelf's copy wins — newest first.
    expect(titles).toEqual(["s2-new.png", "dup-s1.png", "host.png", "s1-old.png"]);
    noDeleteTraffic(sent);
  });

  it("shows nothing from a terminal shelf the bridge never sends", () => {
    const { root, sessions, shelf, sent } = shellHarness();
    sessions.replace([
      session("s1", "build"),
      { ...session("t1", "shell"), kind: "terminal", cli: "", model: "" },
    ]);
    shelf.handleHello(["shelf"]);
    // The prefetch still asks every shelf, terminals included.
    expect(
      sent.map((frame) => (JSON.parse(frame) as { t: string; id?: string }).id ?? null),
    ).toEqual([null, "s1", "t1"]);
    // The bridge answers the terminal's shelf_list with no items.
    shelf.handleList({ req: null, id: "t1", items: [] });
    shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
    shelf.handleList({
      req: null,
      id: null,
      items: [shelfItem({ file_id: "h1", session_id: null, name: "host.png" })],
    });
    shelf.open(root);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(2);
    expect(root.querySelector('.shelf-cell[title="terminal-note.txt"]')).toBeNull();
    noDeleteTraffic(sent);
  });

  it("badges the total unseen on the home row and the session bar", () => {
    const { root, sessions, shelf, shell, sent } = shellHarness();
    sessions.replace([session("s1", "build")]);
    shelf.handleHello(["shelf"]);
    shelf.handleAdded(shelfItem({ file_id: "h1", session_id: null }));
    shelf.handleAdded(shelfItem({ file_id: "f1" }));
    shelf.handleAdded(shelfItem({ file_id: "f2", session_id: "s2" }));
    expect(shelf.unseenTotal()).toBe(3);

    shell.showSessions();
    const homeBadge = root.querySelector<HTMLElement>("#shelf-row-badge");
    expect(homeBadge?.hidden).toBe(false);
    expect(homeBadge?.textContent).toBe("3");

    shell.showSession("s1", "build");
    const barBadge = root.querySelector<HTMLElement>("#session-files-badge");
    expect(barBadge?.hidden).toBe(false);
    expect(barBadge?.textContent).toBe("3");
    noDeleteTraffic(sent);
  });

  it("marks every shelf seen when the union sheet opens", () => {
    const { root, sessions, shelf, shell, sent } = shellHarness();
    sessions.replace([session("s1", "build")]);
    shelf.handleHello(["shelf"]);
    shelf.handleAdded(shelfItem({ file_id: "h1", session_id: null }));
    shelf.handleAdded(shelfItem({ file_id: "f1" }));
    shell.showSessions();
    expect(root.querySelector<HTMLElement>("#shelf-row-badge")?.hidden).toBe(false);

    root.querySelector<HTMLButtonElement>("#host-shelf-row")?.click();
    expect(root.querySelector('[data-sheet="shelf"]')).not.toBeNull();
    expect(shelf.unseenTotal()).toBe(0);
    expect(root.querySelector<HTMLElement>("#shelf-row-badge")?.hidden).toBe(true);

    shell.showSession("s1", "build");
    expect(root.querySelector<HTMLElement>("#session-files-badge")?.hidden).toBe(true);
    noDeleteTraffic(sent);
  });

  it("keeps the Shelf row up at zero files, beside the empty note", () => {
    const { root, sessions, shelf, shell, sent } = shellHarness();
    sessions.replace([]);
    shelf.handleHello(["shelf"]);
    shell.showSessions();
    // Zero sessions and zero files: the entry row and the empty note.
    const row = root.querySelector("#host-shelf-row");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".session-sub")?.textContent).toBe(
      "Files from the host and its sessions",
    );
    expect(root.querySelector<HTMLElement>("#shelf-row-badge")?.hidden).toBe(true);
    expect(root.querySelector("p.empty")?.textContent).toBe("No sessions on this host.");

    sessions.replace([session("s1", "build")]);
    expect(root.querySelector("#host-shelf-row")).not.toBeNull();
    expect(root.querySelector("p.empty")).toBeNull();

    root.querySelector<HTMLButtonElement>("#host-shelf-row")?.click();
    expect(root.querySelector('[data-sheet="shelf"] h2')?.textContent).toBe("Shelf");
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);
    expect(root.querySelector(".shelf-empty")?.textContent).toBe("No files on this shelf yet.");
    noDeleteTraffic(sent);
  });

  it("shows from · age under the viewer caption, like the grid cell", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    shelf.handleList({
      req: null,
      id: "s1",
      items: [shelfItem({ from: "muse", created_at: Date.now() - 90_000 })],
    });
    root.querySelector<HTMLButtonElement>(".shelf-cell")?.click();
    expect(document.querySelector("#shelf-viewer")).not.toBeNull();
    expect(document.querySelector<HTMLElement>("#shelf-meta")?.textContent).toBe("muse · 1m ago");
    expect(document.querySelector<HTMLElement>("#shelf-meta")?.textContent).toBe(
      root.querySelector<HTMLElement>(".shelf-meta")?.textContent,
    );
    noDeleteTraffic(sent);
  });
});

describe("shelf delete", () => {
  /** The delete requests the browser sent, oldest first. */
  const deleteReqs = (sent: string[]): { req: string; file_id: string }[] =>
    sent
      .map((line) => JSON.parse(line) as { t: string; req: string; file_id: string })
      .filter((frame) => frame.t === "shelf_delete");

  const cellCross = (root: HTMLElement, fileId: string): HTMLButtonElement | null =>
    root.querySelector<HTMLButtonElement>(`.shelf-delete[data-file-id="${fileId}"]`);

  it("deletes from the viewer button, removed on the push and not the ok", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
    root.querySelector<HTMLButtonElement>(".shelf-cell")?.click();

    const button = document.querySelector<HTMLButtonElement>("#shelf-delete");
    expect(button?.textContent).toBe("Delete");
    button?.click();
    // Immediate, no confirm: the frame carries the viewed file.
    expect(deleteReqs(sent)).toHaveLength(1);
    expect(deleteReqs(sent)[0]?.file_id).toBe("f1");
    expect(button?.disabled).toBe(true);

    // The ok re-enables the control but removes nothing: the host's push
    // is the source of truth, and somebody else's ok is not this delete.
    expect(shelf.handleOk("r-unknown")).toBe(false);
    expect(shelf.handleOk(deleteReqs(sent)[0]?.req ?? "")).toBe(true);
    expect(button?.disabled).toBe(false);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(1);

    shelf.handleRemoved("f1");
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);
    // Its last file gone, the viewer closes with the sheet behind it.
    expect(document.querySelector("#shelf-viewer")).toBeNull();
  });

  it("deletes from the cell × without touching the other cells", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    shelf.handleList({
      req: null,
      id: "s1",
      items: [shelfItem({ file_id: "f1" }), shelfItem({ file_id: "f2", name: "second.png" })],
    });
    expect(root.querySelectorAll(".shelf-delete")).toHaveLength(2);
    const cross = cellCross(root, "f1");
    expect(cross?.textContent).toBe("×");
    expect(cross?.getAttribute("aria-label")).toBe("Delete gradient.png");

    cross?.click();
    expect(deleteReqs(sent)).toHaveLength(1);
    expect(deleteReqs(sent)[0]?.file_id).toBe("f1");
    expect(cellCross(root, "f1")?.disabled).toBe(true);
    expect(cellCross(root, "f2")?.disabled).toBe(false);

    // While the first is in flight a repeat sends nothing new.
    shelf.deleteFile(shelfItem({ file_id: "f1" }));
    expect(deleteReqs(sent)).toHaveLength(1);

    // The ok re-enables; only the push removes, and only that file.
    expect(shelf.handleOk(deleteReqs(sent)[0]?.req ?? "")).toBe(true);
    expect(cellCross(root, "f1")?.disabled).toBe(false);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(2);
    shelf.handleRemoved("f1");
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(1);
    expect(root.querySelector('.shelf-cell[title="second.png"]')).not.toBeNull();
  });

  it("treats not_found as removed, with no error line", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
    cellCross(root, "f1")?.click();
    const req = deleteReqs(sent)[0]?.req ?? "";

    expect(shelf.handleError({ req, code: "not_found", message: "no shelf file 'f1'" })).toBe(true);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);
    expect(root.querySelector<HTMLElement>("#shelf-delete-error")?.hidden).toBe(true);
  });

  it("shows one inline line when a delete fails, and the file stays", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
    const line = () => root.querySelector<HTMLElement>("#shelf-delete-error");
    expect(line()?.hidden).toBe(true);

    cellCross(root, "f1")?.click();
    expect(shelf.handleError({ req: deleteReqs(sent)[0]?.req ?? "", code: "internal", message: "x" })).toBe(
      true,
    );
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(1);
    expect(line()?.hidden).toBe(false);
    expect(line()?.textContent).toBe("Couldn't delete gradient.png");
    expect(cellCross(root, "f1")?.disabled).toBe(false);

    // A fresh attempt clears the line; its failure repaints the one line.
    cellCross(root, "f1")?.click();
    expect(line()?.hidden).toBe(true);
    expect(shelf.handleError({ req: deleteReqs(sent)[1]?.req ?? "", code: "internal", message: "x" })).toBe(
      true,
    );
    expect(root.querySelectorAll("#shelf-delete-error")).toHaveLength(1);
    expect(line()?.textContent).toBe("Couldn't delete gradient.png");
  });

  it("renders a hostile file name as text in the error line", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    const name = `<img src="x" onerror="alert(1)">.png`;
    shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1", name })] });
    cellCross(root, "f1")?.click();
    expect(shelf.handleError({ req: deleteReqs(sent)[0]?.req ?? "", code: "internal", message: "x" })).toBe(
      true,
    );
    const line = root.querySelector<HTMLElement>("#shelf-delete-error");
    expect(line?.textContent).toBe(`Couldn't delete ${name}`);
    expect(line?.querySelector("img")).toBeNull();
  });

  it("offers no delete control when the feature is off", () => {
    const { root, shelf } = shellHarness();
    shelf.handleHello([]);
    shelf.open(root);
    expect(root.querySelector('[data-sheet="shelf"]')).toBeNull();
    expect(root.querySelector(".shelf-delete")).toBeNull();

    // A sheet built without the feature renders no × and no viewer button.
    const sheet = new ShelfSheet({
      items: () => [shelfItem()],
      ensure: () => {},
      requestAll: () => {},
      markSeen: () => {},
      blobUrl: () => null,
      blob: () => null,
      isYours: () => false,
      onDelete: null,
      onClosed: () => {},
    });
    sheet.open(root);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(1);
    expect(root.querySelector(".shelf-delete")).toBeNull();
    root.querySelector<HTMLButtonElement>(".shelf-cell")?.click();
    expect(document.querySelector("#shelf-viewer")).not.toBeNull();
    expect(document.querySelector("#shelf-delete")).toBeNull();
    sheet.close();
  });

  it("ends the delete on a push that lands ahead of its ok", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
    cellCross(root, "f1")?.click();
    const req = deleteReqs(sent)[0]?.req ?? "";

    // The broadcast lands first: the file leaves at once, with no error.
    shelf.handleRemoved("f1");
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);
    expect(root.querySelector<HTMLElement>("#shelf-delete-error")?.hidden).toBe(true);

    // The late ok is still the delete's own answer: swallowed, never a dialog.
    expect(shelf.handleOk(req)).toBe(true);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);
    expect(root.querySelector<HTMLElement>("#shelf-delete-error")?.hidden).toBe(true);
  });

  it("swallows a late error after its push removed the file", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    shelf.handleList({
      req: null,
      id: "s1",
      items: [shelfItem({ file_id: "f1" }), shelfItem({ file_id: "f2", name: "second.png" })],
    });
    cellCross(root, "f1")?.click();
    cellCross(root, "f2")?.click();
    const [first, second] = deleteReqs(sent);
    // An eviction racing both deletes takes the files first.
    shelf.handleRemoved("f1");
    shelf.handleRemoved("f2");
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);

    // Already gone host-side either way: no error line, never a dialog.
    expect(
      shelf.handleError({ req: first?.req ?? "", code: "not_found", message: "no shelf file 'f1'" }),
    ).toBe(true);
    expect(
      shelf.handleError({ req: second?.req ?? "", code: "internal", message: "x" }),
    ).toBe(true);
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(0);
    expect(root.querySelector<HTMLElement>("#shelf-delete-error")?.hidden).toBe(true);
  });

  it("clears in-flight deletes and the error line on a fresh hello", () => {
    const { root, shelf, sent } = shellHarness();
    shelf.handleHello(["shelf"]);
    shelf.open(root);
    const items = () => [shelfItem({ file_id: "f1" }), shelfItem({ file_id: "f2", name: "second.png" })];
    shelf.handleList({ req: null, id: "s1", items: items() });
    // One delete is still in flight while another fails and leaves its line.
    cellCross(root, "f2")?.click();
    cellCross(root, "f1")?.click();
    const staleReq = deleteReqs(sent)[0]?.req ?? "";
    expect(
      shelf.handleError({ req: deleteReqs(sent)[1]?.req ?? "", code: "internal", message: "x" }),
    ).toBe(true);
    expect(root.querySelector<HTMLElement>("#shelf-delete-error")?.hidden).toBe(false);
    expect(cellCross(root, "f2")?.disabled).toBe(true);

    // A reconnect's hello ends the old connection: its pending state dies.
    shelf.handleHello(["shelf"]);
    shelf.handleList({ req: null, id: "s1", items: items() });
    expect(root.querySelector<HTMLElement>("#shelf-delete-error")?.hidden).toBe(true);
    expect(cellCross(root, "f2")?.disabled).toBe(false);
    expect(shelf.handleOk(staleReq)).toBe(false);

    // And deleting again works: the old pending never blocks the new one.
    cellCross(root, "f2")?.click();
    expect(deleteReqs(sent)).toHaveLength(3);
  });
});
