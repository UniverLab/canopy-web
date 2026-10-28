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
import { SessionStore } from "../src/sessions.js";

const CALLBACKS: ShellCallbacks = {
  onPair: () => {},
  onConnect: () => {},
  onDisconnect: () => {},
  onRetry: () => {},
  onPairAgain: () => {},
  onOpenSession: () => {},
  onLeaveSession: () => {},
  onKeyPress: () => {},
  onTerminalInput: () => {},
  onComposerSend: () => {},
  onSpawn: () => true,
  onCompose: () => true,
  onSendDraft: () => true,
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
      shelf.open(root, "s1");
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
    shelf.open(root, "s1");
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

  it("lists the host shelf row and per-session counts", () => {
    const { root, sessions, shelf, shell, sent } = shellHarness();
    sessions.replace([session("s1", "build")]);
    shelf.handleHello(["shelf"]);
    expect(sent.map((frame) => (JSON.parse(frame) as { t: string }).t)).toEqual([
      "shelf_list",
      "shelf_list",
    ]);
    shell.showSessions();
    expect(root.querySelector("#host-shelf-row")).toBeNull();

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
    // The count rides beside the folder icon, with no glyph in the text.
    expect(root.querySelector("#host-shelf-row .session-files-count")?.textContent).toBe("1");
    expect(root.querySelector('[data-session="s1"] .session-files-count')?.textContent).toBe("2");
    expect(root.querySelector('[data-session="s1"] .session-files svg')).not.toBeNull();

    root.querySelector<HTMLButtonElement>("#host-shelf-row")?.click();
    expect(root.querySelector('[data-sheet="shelf"]')).not.toBeNull();
    expect(root.querySelectorAll(".shelf-cell")).toHaveLength(1);
  });
});
