// SPDX-License-Identifier: Apache-2.0
// The shelf's second attach source, outside the browser: the Files grid in
// pick mode. A tap types the same Attachment chip an upload does, sends no
// shelf_put_* frame, fetches no blob, and the entry is gated on
// hello.features "shelf_upload" exactly like the paperclip.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createShell } from "../src/app.js";
import type { Shell, ShellCallbacks } from "../src/app.js";
import type { SessionItem, ShelfItem } from "../src/protocol.js";
import { ShelfController } from "../src/shelf-controller.js";
import { SessionStore } from "../src/sessions.js";
import { attachmentText } from "../src/upload.js";

// The upload queue hashes before it begins; the chip is what this suite
// reads, so one fixed digest is enough (the environment has no subtle).
const originalCrypto = globalThis.crypto;
beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: { subtle: { digest: async () => new ArrayBuffer(32) } },
    configurable: true,
    writable: true,
  });
});
afterAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: originalCrypto,
    configurable: true,
    writable: true,
  });
});

interface Frame {
  t: string;
  req?: string;
  file_id?: string;
  name?: string;
}

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
  onKill: () => true,
  onSpawn: () => true,
  onCompose: () => true,
  onSendDraft: () => true,
  onSchedule: () => true,
  onScheduledList: () => true,
  onScheduledCancel: () => true,
  onGraphsRequest: () => {},
  onWatchGraph: () => {},
  onUnwatchGraph: () => {},
  onGraphControl: () => true,
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

interface Harness {
  root: HTMLDivElement;
  sessions: SessionStore;
  shelf: ShelfController;
  shell: Shell;
  sent: Frame[];
  typed: string[];
}

function harness(): Harness {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const sessions = new SessionStore();
  const sent: Frame[] = [];
  const typed: string[] = [];
  const callbacks: ShellCallbacks = {
    ...CALLBACKS,
    onKeyPress: (bytes) => typed.push(new TextDecoder().decode(bytes)),
  };
  const shelf = new ShelfController({
    send: (data) => {
      sent.push(JSON.parse(data) as Frame);
      return true;
    },
    sessions,
  });
  const shell = createShell(root, sessions, callbacks, { shelf });
  return { root, sessions, shelf, shell, sent, typed };
}

function fileOf(bytes: Uint8Array, name: string, type: string): File {
  return {
    name,
    size: bytes.length,
    type,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  } as unknown as File;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("attach from the shelf", () => {
  it("types the same Attachment chip an upload does, with no shelf_put frames", async () => {
    const h = harness();
    h.sessions.replace([session("s1", "build")]);
    h.shelf.handleHello(["shelf", "shelf_upload"]);
    h.shell.showSession("s1", "build");
    expect(h.root.querySelector("#term-attach")).not.toBeNull();
    expect(h.root.querySelector("#term-attach-shelf")).not.toBeNull();

    // FEAT-28's landed path: an upload finishes and its chip types.
    const path = "/home/u/demo/notes.txt";
    h.shelf.startUploads([fileOf(new TextEncoder().encode("hello"), "notes.txt", "text/plain")], "s1");
    await settle();
    const begin = h.sent.find((frame) => frame.t === "shelf_put_begin");
    expect(begin).toBeDefined();
    h.shelf.handlePutReady({ req: begin?.req ?? "", file_id: "u1" });
    h.shelf.handleAdded(
      shelfItem({
        file_id: "u1",
        name: "notes.txt",
        mime: "text/plain",
        size: 5,
        from: "you",
        origin: "device",
        path,
      }),
    );
    const chip = h.root.querySelector<HTMLButtonElement>(".upload-attach");
    expect(chip).not.toBeNull();
    chip?.click();
    expect(h.typed).toEqual([attachmentText(path)]);
    expect(h.typed[0]).toBe("Attachment: /home/u/demo/notes.txt");

    // The shelf copy shares that path: its picker types byte for byte the
    // same chip, without asking the host for anything but the list.
    h.shelf.handleList({
      req: null,
      id: "s1",
      items: [shelfItem({ file_id: "f2", name: "shelf-notes.txt", mime: "text/plain", path })],
    });
    const before = h.sent.length;
    h.root.querySelector<HTMLButtonElement>("#term-attach-shelf")?.click();
    const cell = h.root.querySelector<HTMLButtonElement>('.shelf-cell[title="shelf-notes.txt"]');
    expect(cell).not.toBeNull();
    cell?.click();

    expect(h.typed).toHaveLength(2);
    expect(h.typed[1]).toBe(h.typed[0]);
    expect(h.shelf.isOpen()).toBe(false);
    expect(h.root.querySelector('[data-sheet="shelf"]')).toBeNull();
    expect(document.querySelector("#shelf-viewer")).toBeNull();

    const during = h.sent.slice(before);
    expect(during.filter((frame) => frame.t.startsWith("shelf_put"))).toEqual([]);
    expect(during.filter((frame) => frame.t === "shelf_get")).toEqual([]);
  });

  it("lists the union as one flat grid, in union order, with no forced download", () => {
    const h = harness();
    h.sessions.replace([session("s1", "build"), session("s2", "docs")]);
    h.shelf.handleHello(["shelf", "shelf_upload"]);
    h.shell.showSession("s1", "build");

    h.shelf.handleList({
      req: null,
      id: null,
      items: [shelfItem({ file_id: "h1", session_id: null, name: "host.png", created_at: 300 })],
    });
    h.shelf.handleList({
      req: null,
      id: "s1",
      items: [
        shelfItem({ file_id: "dup", name: "dup-s1.png", created_at: 500 }),
        shelfItem({ file_id: "a", name: "a.png", created_at: 100 }),
      ],
    });
    h.shelf.handleList({
      req: null,
      id: "s2",
      items: [
        shelfItem({ file_id: "dup", session_id: "s2", name: "dup-s2.png", created_at: 600 }),
        shelfItem({ file_id: "b", session_id: "s2", name: "b.png", created_at: 200 }),
      ],
    });

    const before = h.sent.length;
    h.root.querySelector<HTMLButtonElement>("#term-attach-shelf")?.click();
    const titles = [...h.root.querySelectorAll(".shelf-cell")].map((cell) =>
      cell.getAttribute("title"),
    );
    // The first copy of a duplicate wins, newest first, in one flat list.
    expect(titles).toEqual(["dup-s1.png", "host.png", "b.png", "a.png"]);
    expect(h.root.querySelectorAll(".shelf-section-title")).toHaveLength(0);
    expect(h.root.querySelectorAll(".shelf-download")).toHaveLength(0);
    // The cell keeps the sheet's caption and `from · age` meta.
    expect(h.root.querySelector(".shelf-cell .shelf-meta")?.textContent).toContain("muse");
    expect(h.sent.slice(before).filter((frame) => frame.t === "shelf_get")).toEqual([]);
    h.shelf.close();
  });

  it("hides the shelf entry without shelf_upload and refuses to open the picker", () => {
    const h = harness();
    h.sessions.replace([session("s1", "build")]);
    h.shelf.handleHello(["shelf"]);
    h.shell.showSession("s1", "build");

    expect(h.root.querySelector("#term-attach")).toBeNull();
    expect(h.root.querySelector("#term-attach-shelf")).toBeNull();
    expect(h.root.querySelector("#upload-input")).toBeNull();

    // Even with a file waiting, the gated controller opens nothing.
    h.shelf.handleList({ req: null, id: "s1", items: [shelfItem({ file_id: "f1" })] });
    const picked: ShelfItem[] = [];
    h.shelf.openPick(h.root, (item) => picked.push(item));
    expect(h.root.querySelector('[data-sheet="shelf"]')).toBeNull();
    expect(picked).toHaveLength(0);
  });
});
