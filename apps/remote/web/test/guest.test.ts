// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { b64decode, b64encode, generateDeviceKey, importSpkiVerifyKey } from "../src/crypto.js";
import type { DeviceKey } from "../src/crypto.js";
import { GuestPeer, createGuestSession, guestRelayUrl, mountGuest, parseGuestLink } from "../src/guest.js";
import type { GuestMountDeps } from "../src/guest.js";
import { INVITE_FORMAT_ERROR, INVITE_REFUSED_MESSAGE, INVITE_SPENT_MESSAGE } from "../src/guest-invite.js";
import type { GuestHostRecord } from "../src/guest-store.js";
import { guestHostKey } from "../src/guest-store.js";
import { connectFailMessage } from "../src/peer.js";
import type { PeerEvent } from "../src/peer.js";
import { RelaySocket, defaultRelayUrl } from "../src/relay.js";
import type { TerminalFactory, TerminalHandle } from "../src/terminal.js";
import {
  connectRelay,
  createPeerHarness,
  createRelayHarness,
  createTestHost,
  createTurnFetcher,
  FakeStorage,
  FakeWebSocket,
  flush,
  signTestAnswer,
  textOf,
  waitForSend,
} from "./fakes.js";
import type { PeerHarness, RelayHarness, TestHost } from "./fakes.js";

const ANSWER_SDP = "v=0\r\no=- 9 9 IN IP4 127.0.0.1\r\n";
const OWNER_UID = 7;
const HOST_ID = "0123456789abcdef";

describe("parseGuestLink", () => {
  it("parses a well-formed guest link", () => {
    expect(parseGuestLink(`/g/7/${HOST_ID}`)).toEqual({ ownerUid: 7, hostId: HOST_ID });
    expect(parseGuestLink(`/g/7/${HOST_ID}/`)).toEqual({ ownerUid: 7, hostId: HOST_ID });
    expect(parseGuestLink("/g/123456789012345/fedcba9876543210")).toEqual({
      ownerUid: 123456789012345,
      hostId: "fedcba9876543210",
    });
  });

  it("rejects malformed links", () => {
    const bad = [
      "",
      "/",
      "/pair",
      "/g/",
      "/g/7",
      "/g/7/",
      "/g/0/0123456789abcdef",
      "/g/abc/0123456789abcdef",
      "/g/7/0123456789abcde",
      "/g/7/0123456789abcdef0",
      "/g/7/0123456789ABCDEF",
      "/g/7/0123456789abcdef/extra",
      "/g/7/0123456789abcdef?x=1",
      "/G/7/0123456789abcdef",
    ];
    for (const pathname of bad) {
      expect(parseGuestLink(pathname), pathname).toBeNull();
    }
  });
});

describe("guestRelayUrl", () => {
  it("is the device door with the owner as guest_of and the invite code", () => {
    expect(guestRelayUrl(OWNER_UID, "CNR-7K3Q-HM9P-2XAB-CDEF")).toBe(
      `${defaultRelayUrl()}?guest_of=${OWNER_UID}&invite=CNR-7K3Q-HM9P-2XAB-CDEF`,
    );
  });

  it("encodes the code as one query value", () => {
    const url = new URL(guestRelayUrl(OWNER_UID, "a&b=c d#e"));
    expect(url.searchParams.get("guest_of")).toBe(String(OWNER_UID));
    expect(url.searchParams.get("invite")).toBe("a&b=c d#e");
    expect(url.hash).toBe("");
  });
});

interface GuestSetup {
  relayHarness: RelayHarness;
  ws: FakeWebSocket;
  peerHarness: PeerHarness;
  device: DeviceKey;
  host: TestHost;
  events: PeerEvent[];
  pins: Map<string, GuestHostRecord>;
  writes: { count: number };
  peer: GuestPeer;
}

async function setupGuest(): Promise<GuestSetup> {
  const relayHarness = createRelayHarness();
  const ws = await connectRelay(relayHarness);
  const peerHarness = createPeerHarness();
  const turn = createTurnFetcher(true);
  const device = await generateDeviceKey();
  const host = await createTestHost();
  const events: PeerEvent[] = [];
  const pins = new Map<string, GuestHostRecord>();
  const writes = { count: 0 };
  const peer = new GuestPeer({
    relay: relayHarness.relay,
    ownerUid: OWNER_UID,
    hostId: host.record.host_id,
    device,
    fetchTurn: turn.fetchTurn,
    createConnection: peerHarness.factory,
    nowMs: () => 1793100000_000,
    getPin: async (ownerUid, hostId) => pins.get(guestHostKey(ownerUid, hostId)) ?? null,
    savePin: async (record) => {
      writes.count += 1;
      pins.set(record.key, record);
    },
  });
  peer.onEvent((ev) => events.push(ev));
  return {
    relayHarness,
    ws,
    peerHarness,
    device,
    host,
    events,
    pins,
    writes,
    peer,
  };
}

function guestOfferBody(setup: GuestSetup): {
  device_id: string;
  ts: string;
  sdp: string;
  sig: string;
  device_spki: string;
} {
  const offer = setup.ws.envelopes().find((e) => e.body.t === "offer");
  if (!offer || offer.to !== `h:${setup.host.record.host_id}`) {
    throw new Error("no offer sent to the host");
  }
  return offer.body as unknown as {
    device_id: string;
    ts: string;
    sdp: string;
    sig: string;
    device_spki: string;
  };
}

async function offerSignatureValid(
  device: DeviceKey,
  hostId: string,
  ts: string,
  sdp: string,
  sig: string,
): Promise<boolean> {
  const key = await importSpkiVerifyKey(device.spki);
  return globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new Uint8Array(b64decode(sig)),
    new TextEncoder().encode(`canopy-remote/v1/offer\n${hostId}\n${ts}\n${sdp}`),
  );
}

async function waitForRemoteDescription(setup: GuestSetup): Promise<void> {
  for (let i = 0; i < 100 && !setup.peerHarness.latest().remoteDescription; i += 1) {
    await flush();
  }
  if (!setup.peerHarness.latest().remoteDescription) {
    throw new Error("remote description was never set");
  }
}

async function answerGuestHandshake(setup: GuestSetup, sdp: string = ANSWER_SDP): Promise<void> {
  const offer = guestOfferBody(setup);
  const sig = await signTestAnswer(setup.host.privateKey, setup.device.deviceId, offer.sig, sdp);
  setup.ws.receive(`h:${setup.host.record.host_id}`, {
    t: "answer",
    sdp,
    sig,
    host_spki: setup.host.record.host_spki,
  });
  await waitForRemoteDescription(setup);
}

describe("GuestPeer", () => {
  it("sends the owner's offer plus this browser's SPKI", async () => {
    const setup = await setupGuest();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    const offer = guestOfferBody(setup);
    expect(offer.device_id).toBe(setup.device.deviceId);
    expect(offer.ts).toBe("1793100000");
    expect(offer.device_spki).toBe(setup.device.spkiB64);
    await expect(
      offerSignatureValid(
        setup.device,
        setup.host.record.host_id,
        offer.ts,
        offer.sdp,
        offer.sig,
      ),
    ).resolves.toBe(true);
    setup.peer.close();
    await expect(pending).rejects.toThrow("Connection closed");
  });

  it("pins the host key on first use and opens the channel", async () => {
    const setup = await setupGuest();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    // An answer from another sender is ignored.
    setup.ws.receive("h:other", { t: "answer", sdp: ANSWER_SDP, sig: "bogus", host_spki: "bogus" });
    await flush();
    expect(setup.peerHarness.latest().remoteDescription).toBeNull();
    await answerGuestHandshake(setup);
    expect(setup.peerHarness.latest().remoteDescription).toEqual({ type: "answer", sdp: ANSWER_SDP });
    expect(setup.pins.get(guestHostKey(OWNER_UID, setup.host.record.host_id))).toEqual({
      key: guestHostKey(OWNER_UID, setup.host.record.host_id),
      owner_uid: OWNER_UID,
      host_id: setup.host.record.host_id,
      host_spki: setup.host.record.host_spki,
      label: "",
    });
    setup.peerHarness.latest().firstChannel().remoteOpen();
    await pending;
    expect(setup.events).toEqual([{ type: "open" }]);
    expect(setup.writes.count).toBe(1);
  });

  it("trusts a matching pin without writing it again", async () => {
    const setup = await setupGuest();
    let pending = setup.peer.connect();
    await waitForSend(setup.ws);
    await answerGuestHandshake(setup);
    setup.peerHarness.latest().firstChannel().remoteOpen();
    await pending;
    expect(setup.writes.count).toBe(1);

    // A second visit: the pin is read, the presented key matches, no write.
    const relayHarness = createRelayHarness();
    const ws = await connectRelay(relayHarness);
    const peerHarness = createPeerHarness();
    const events: PeerEvent[] = [];
    const peer = new GuestPeer({
      relay: relayHarness.relay,
      ownerUid: OWNER_UID,
      hostId: setup.host.record.host_id,
      device: setup.device,
      fetchTurn: createTurnFetcher(true).fetchTurn,
      createConnection: peerHarness.factory,
      nowMs: () => 1793100000_000,
      getPin: async (ownerUid, hostId) => setup.pins.get(guestHostKey(ownerUid, hostId)) ?? null,
      savePin: async (record) => {
        setup.pins.set(record.key, record);
      },
    });
    peer.onEvent((ev) => events.push(ev));
    pending = peer.connect();
    await waitForSend(ws);
    const offer = ws.envelopes().find((e) => e.body.t === "offer");
    const sig = await signTestAnswer(
      setup.host.privateKey,
      setup.device.deviceId,
      String(offer?.body.sig),
      ANSWER_SDP,
    );
    ws.receive(`h:${setup.host.record.host_id}`, {
      t: "answer",
      sdp: ANSWER_SDP,
      sig,
      host_spki: setup.host.record.host_spki,
    });
    for (let i = 0; i < 100 && !peerHarness.latest().remoteDescription; i += 1) {
      await flush();
    }
    expect(peerHarness.latest().remoteDescription).not.toBeNull();
    peerHarness.latest().firstChannel().remoteOpen();
    await pending;
    expect(events).toEqual([{ type: "open" }]);
    expect(setup.writes.count).toBe(1);
  });

  it("fails when the presented key disagrees with the pin", async () => {
    const setup = await setupGuest();
    // A stale pin row: the right host id, the wrong key.
    setup.pins.set(guestHostKey(OWNER_UID, setup.host.record.host_id), {
      key: guestHostKey(OWNER_UID, setup.host.record.host_id),
      owner_uid: OWNER_UID,
      host_id: setup.host.record.host_id,
      host_spki: setup.device.spkiB64,
      label: "",
    });
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    const offer = guestOfferBody(setup);
    const sig = await signTestAnswer(setup.host.privateKey, setup.device.deviceId, offer.sig, ANSWER_SDP);
    setup.ws.receive(`h:${setup.host.record.host_id}`, {
      t: "answer",
      sdp: ANSWER_SDP,
      sig,
      host_spki: setup.host.record.host_spki,
    });
    await expect(pending).rejects.toThrow("Host identity check failed");
    expect(setup.events).toEqual([{ type: "failed", reason: "Host identity check failed" }]);
    expect(setup.peerHarness.latest().remoteDescription).toBeNull();
  });

  it("fails when the presented key hashes to another host id", async () => {
    const setup = await setupGuest();
    const other = await createTestHost("other host");
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    const offer = guestOfferBody(setup);
    const sig = await signTestAnswer(other.privateKey, setup.device.deviceId, offer.sig, ANSWER_SDP);
    setup.ws.receive(`h:${setup.host.record.host_id}`, {
      t: "answer",
      sdp: ANSWER_SDP,
      sig,
      host_spki: other.record.host_spki,
    });
    await expect(pending).rejects.toThrow("Host identity check failed");
    expect(setup.events).toEqual([{ type: "failed", reason: "Host identity check failed" }]);
    expect(setup.pins.size).toBe(0);
  });

  it("fails when the answer signature is forged under another key", async () => {
    const setup = await setupGuest();
    const other = await createTestHost("other host");
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    // The right key presented, but the signature made by another host's:
    // verification fails and nothing is pinned.
    const offer = guestOfferBody(setup);
    const sig = await signTestAnswer(other.privateKey, setup.device.deviceId, offer.sig, ANSWER_SDP);
    setup.ws.receive(`h:${setup.host.record.host_id}`, {
      t: "answer",
      sdp: ANSWER_SDP,
      sig,
      host_spki: setup.host.record.host_spki,
    });
    await expect(pending).rejects.toThrow("Host identity check failed");
    expect(setup.events).toEqual([{ type: "failed", reason: "Host identity check failed" }]);
    expect(setup.peerHarness.latest().remoteDescription).toBeNull();
    expect(setup.pins.size).toBe(0);
  });

  it("fails closed when the answer signature is not base64", async () => {
    const setup = await setupGuest();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    // "!!!" never decodes: the peer must fail, not hang in connecting.
    setup.ws.receive(`h:${setup.host.record.host_id}`, {
      t: "answer",
      sdp: ANSWER_SDP,
      sig: "!!!",
      host_spki: setup.host.record.host_spki,
    });
    await expect(pending).rejects.toThrow("Host identity check failed");
    expect(setup.events).toEqual([{ type: "failed", reason: "Host identity check failed" }]);
    expect(setup.peerHarness.latest().remoteDescription).toBeNull();
    expect(setup.pins.size).toBe(0);
  });

  it("ignores an answer without a host key", async () => {
    const setup = await setupGuest();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    setup.ws.receive(`h:${setup.host.record.host_id}`, { t: "answer", sdp: ANSWER_SDP, sig: "bogus" });
    await flush();
    expect(setup.peerHarness.latest().remoteDescription).toBeNull();
    expect(setup.events).toEqual([]);
    setup.peer.close();
    await expect(pending).rejects.toThrow("Connection closed");
  });

  it("fails closed when the hub reports no grant", async () => {
    const setup = await setupGuest();
    const pending = setup.peer.connect();
    await waitForSend(setup.ws);
    setup.ws.receive(`h:${setup.host.record.host_id}`, { t: "connect_fail", reason: "forbidden" });
    await expect(pending).rejects.toThrow(connectFailMessage("forbidden"));
    expect(setup.events).toEqual([{ type: "failed", reason: connectFailMessage("forbidden") }]);
    expect(connectFailMessage("forbidden")).toBe("This host is not shared with you");
    expect(setup.pins.size).toBe(0);
  });
});

class FakeGuestHandle implements TerminalHandle {
  written: Uint8Array[] = [];
  private inputListeners: ((text: string) => void)[] = [];

  write = (data: Uint8Array): void => {
    this.written.push(data);
  };
  clear = (): void => {};
  focus = (): void => {};
  blur = (): void => {};
  scrollToBottom = (): void => {};
  isAtBottom = (): boolean => true;
  onUserInput = (callback: (text: string) => void): (() => void) => {
    this.inputListeners.push(callback);
    return () => {};
  };
  onScroll = (): (() => void) => () => {};
  onReady = (callback: () => void): (() => void) => {
    callback();
    return () => {};
  };
  getSelection = (): string => "";
  onSelectionChange = (): (() => void) => () => {};
  bufferText = (): string => "";
  dispose = (): void => {};

  emitInput(text: string): void {
    for (const listener of this.inputListeners) {
      listener(text);
    }
  }
}

describe("createGuestSession", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function setupSession(): {
    root: HTMLElement;
    sent: string[];
    handles: FakeGuestHandle[];
    session: ReturnType<typeof createGuestSession>;
  } {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const sent: string[] = [];
    const handles: FakeGuestHandle[] = [];
    const factory: TerminalFactory = () => {
      const handle = new FakeGuestHandle();
      handles.push(handle);
      return handle;
    };
    const session = createGuestSession(root, {
      login: "guest-user",
      send: (data) => {
        sent.push(data);
        return true;
      },
      onRetry: () => {},
      onSignOut: () => {},
      onForgetDevice: () => {},
      terminalFactory: factory,
    });
    return { root, sent, handles, session };
  }

  const frames = (sent: string[]): unknown[] => sent.map((raw) => JSON.parse(raw));

  function joinSession(session: ReturnType<typeof createGuestSession>, id = "s1", name = "build"): void {
    session.view.showList();
    session.push(JSON.stringify({ t: "sessions", items: [{ id, name }] }));
    session.open(id);
    const full = b64encode(new TextEncoder().encode("hello"));
    session.push(JSON.stringify({ t: "snapshot", id, cols: 80, rows: 24, seq: 7, data: full }));
    session.push(JSON.stringify({ t: "snapshot_more", id, data: "", last: true }));
  }

  it("lists the granted sessions and attaches on open", () => {
    const { root, sent, session } = setupSession();
    session.view.showList();
    session.push(
      JSON.stringify({ t: "sessions", items: [{ id: "s1", name: "build" }, { id: "s2", name: "docs" }] }),
    );
    expect(root.querySelectorAll("[data-session]").length).toBe(2);
    root.querySelector<HTMLButtonElement>('[data-session="s2"]')?.click();
    expect(root.querySelector(".session-title")?.textContent).toBe("docs");
    expect(frames(sent)).toEqual([{ t: "attach", id: "s2" }]);
  });

  it("lands a denied attach back on the list with the unauthorized notice", () => {
    const { root, sent, session } = setupSession();
    session.view.showList();
    session.push(JSON.stringify({ t: "sessions", items: [{ id: "s1", name: "build" }] }));
    session.open("s9");
    session.push(JSON.stringify({ t: "error", code: "forbidden", id: "s9" }));
    expect(root.querySelector(".sessions-head h2")?.textContent).toBe("Shared sessions");
    expect(root.querySelector("#guest-notice")?.textContent).toBe("That session is not shared with you.");
    expect(frames(sent)).toEqual([
      { t: "attach", id: "s9" },
      { t: "detach", id: "s9" },
    ]);
  });

  it("names the denied session from its stale row", () => {
    const { root, session } = setupSession();
    session.view.showList();
    session.push(JSON.stringify({ t: "sessions", items: [{ id: "s1", name: "build" }] }));
    session.open("s1");
    session.push(JSON.stringify({ t: "error", code: "forbidden", id: "s1" }));
    expect(root.querySelector("#guest-notice")?.textContent).toBe("“build” is not shared with you.");
  });

  it("mounts the terminal on snapshot and streams output into it", () => {
    const { root, handles, session } = setupSession();
    joinSession(session);
    expect(handles.length).toBe(1);
    expect(root.querySelector("#term-pane .term-fit")).not.toBeNull();
    session.push(
      JSON.stringify({ t: "out", id: "s1", seq: 8, data: b64encode(new TextEncoder().encode("!")) }),
    );
    expect(textOf(handles[0]?.written ?? [])).toBe("hello!");
    // Stale output the snapshot already covers never duplicates.
    session.push(
      JSON.stringify({ t: "out", id: "s1", seq: 7, data: b64encode(new TextEncoder().encode("?")) }),
    );
    expect(textOf(handles[0]?.written ?? [])).toBe("hello!");
  });

  it("sends typed text and key-bar keys as input frames", () => {
    const { root, sent, handles, session } = setupSession();
    joinSession(session);
    handles[0]?.emitInput("ls");
    root.querySelector<HTMLButtonElement>('#keybar button[data-key="enter"]')?.click();
    const outbound = frames(sent);
    expect(outbound[1]).toEqual({
      t: "input",
      id: "s1",
      data: b64encode(new TextEncoder().encode("ls")),
    });
    expect(outbound[2]).toEqual({ t: "input", id: "s1", data: b64encode(new Uint8Array([0x0d])) });
  });

  it("offers no builder, no sheets and no spawn in a granted session", () => {
    const { root, session } = setupSession();
    joinSession(session);
    expect(root.querySelector("#term-builder")).toBeNull();
    expect(root.querySelector("#session-files")).toBeNull();
    expect(root.querySelector("#session-new")).toBeNull();
    // The terminal is the only text input.
    expect(root.querySelector("textarea")).toBeNull();
  });

  it("announces the exit on the session badge", () => {
    const { root, session } = setupSession();
    joinSession(session);
    session.push(JSON.stringify({ t: "exited", id: "s1", code: 1 }));
    expect(root.querySelector("#guest-exit")?.textContent).toBe("Session exited (1)");
  });

  it("clears the collected terminal text on a fresh snapshot", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const collected: Uint8Array[] = [];
    const handles: FakeGuestHandle[] = [];
    const factory: TerminalFactory = () => {
      const handle = new FakeGuestHandle();
      handles.push(handle);
      return handle;
    };
    const session = createGuestSession(root, {
      login: "guest-user",
      send: () => true,
      onRetry: () => {},
      onSignOut: () => {},
      onForgetDevice: () => {},
      terminalFactory: factory,
      onTerminalBytes: (bytes) => {
        collected.push(bytes);
      },
      onTerminalClear: () => {
        collected.length = 0;
      },
    });
    joinSession(session);
    expect(textOf(collected)).toBe("hello");
    const full = b64encode(new TextEncoder().encode("fresh"));
    session.push(JSON.stringify({ t: "snapshot", id: "s1", cols: 80, rows: 24, seq: 9, data: full }));
    session.push(JSON.stringify({ t: "snapshot_more", id: "s1", data: "", last: true }));
    expect(textOf(collected)).toBe("fresh");
  });
});

describe("mountGuest", () => {
  const CODE = "CNR-7K3Q-HM9P-2XAB-CDEF";

  afterEach(() => {
    document.body.innerHTML = "";
  });

  interface Mounted {
    root: HTMLElement;
    sockets: FakeWebSocket[];
    storage: FakeStorage;
    replaced: (string | undefined)[];
    host: TestHost;
    device: DeviceKey;
    peerHarness: PeerHarness;
    done: Promise<void>;
  }

  async function mount(options: {
    hash?: string;
    stored?: string;
    login?: string | null;
    online?: boolean;
  }): Promise<Mounted> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const host = await createTestHost();
    const device = await generateDeviceKey();
    const sockets: FakeWebSocket[] = [];
    const storage = new FakeStorage();
    const pathname = `/g/${OWNER_UID}/${host.record.host_id}`;
    if (options.stored !== undefined) {
      storage.setItem(`canopy.remote.invite:${OWNER_UID}/${host.record.host_id}`, options.stored);
    }
    const location = { pathname, search: "", hash: options.hash ?? "" };
    const replaced: (string | undefined)[] = [];
    const peerHarness = createPeerHarness();
    const pins = new Map<string, GuestHostRecord>();
    const deps: Partial<GuestMountDeps> = {
      location,
      history: {
        replaceState: (_data, _unused, url) => {
          replaced.push(url);
          location.hash = "";
        },
      },
      storage,
      fetchLogin: async () => (options.login === undefined ? "bob" : options.login),
      signOut: async () => {},
      ensureDeviceKey: async () => device,
      clearDevice: async () => {},
      createRelay: (url) =>
        new RelaySocket(url, (openUrl) => {
          const ws = new FakeWebSocket(openUrl);
          sockets.push(ws);
          return ws as unknown as WebSocket;
        }),
      isOnline: () => options.online ?? true,
      peer: {
        fetchTurn: createTurnFetcher(true).fetchTurn,
        createConnection: peerHarness.factory,
        nowMs: () => 1793100000_000,
        getPin: async (ownerUid, hostId) => pins.get(guestHostKey(ownerUid, hostId)) ?? null,
        savePin: async (record) => {
          pins.set(record.key, record);
        },
      },
    };
    const done = mountGuest(root, deps);
    return { root, sockets, storage, replaced, host, device, peerHarness, done };
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i += 1) {
      await flush();
    }
    expect(check()).toBe(true);
  }

  function inviteKey(m: Mounted): string {
    return `canopy.remote.invite:${OWNER_UID}/${m.host.record.host_id}`;
  }

  function submit(m: Mounted, value: string): void {
    const input = m.root.querySelector<HTMLInputElement>("#guest-invite-code");
    if (!input) {
      throw new Error("no invite field");
    }
    input.value = value;
    m.root.querySelector<HTMLFormElement>("#guest-invite-form")?.requestSubmit();
  }

  it("takes the fragment's code, strips it and opens the door with the canonical form", async () => {
    const m = await mount({ hash: "#invite=cnr7k3qhm9p2xabcdef" });
    // Stripped before anything else ran: path only, no fragment.
    expect(m.replaced).toEqual([`/g/${OWNER_UID}/${m.host.record.host_id}`]);
    expect(m.storage.getItem(inviteKey(m))).toBe(CODE);
    await until(() => m.sockets.length === 1);
    expect(m.sockets[0]?.url).toBe(`${defaultRelayUrl()}?guest_of=${OWNER_UID}&invite=${CODE}`);
    m.sockets[0]?.fail();
    await m.done;
  });

  it("asks for the code when the link carries none, and validates it", async () => {
    const m = await mount({});
    await m.done;
    const input = m.root.querySelector<HTMLInputElement>("#guest-invite-code");
    expect(input).not.toBeNull();
    expect(input?.closest("label")?.textContent).toContain("Invite code");
    expect(input?.getAttribute("aria-describedby")).toBe("guest-invite-hint guest-invite-error");
    expect(m.sockets).toHaveLength(0);
    // Not a code: the error is tied to the field and nothing is sent.
    submit(m, "CNR-7K3Q");
    const error = m.root.querySelector<HTMLElement>("#guest-invite-error");
    expect(error?.hidden).toBe(false);
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe(INVITE_FORMAT_ERROR);
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(m.sockets).toHaveLength(0);
    // Typed lowercase with spaces: sent canonical, kept for the tab.
    submit(m, "7k3q hm9p 2xab cdef");
    await until(() => m.sockets.length === 1);
    expect(new URL(m.sockets[0]?.url ?? "").searchParams.get("invite")).toBe(CODE);
    expect(m.storage.getItem(inviteKey(m))).toBe(CODE);
    m.sockets[0]?.fail();
    await until(() => m.root.querySelector("#guest-invite-notice") !== null);
  });

  it("reconnects in the same tab with the stored code, no form", async () => {
    const m = await mount({ stored: CODE });
    await until(() => m.sockets.length === 1);
    expect(new URL(m.sockets[0]?.url ?? "").searchParams.get("invite")).toBe(CODE);
    expect(m.root.querySelector("#guest-invite-form")).toBeNull();
    m.sockets[0]?.fail();
    await m.done;
  });

  it("turns a refused door (bad_invite) into the form again, prefilled, never 'no longer paired'", async () => {
    const m = await mount({ stored: CODE });
    await until(() => m.sockets.length === 1);
    // The relay answers 403 bad_invite: the browser sees only a close
    // before the socket ever opened.
    m.sockets[0]?.fail();
    await m.done;
    const notice = m.root.querySelector("#guest-invite-notice");
    expect(notice?.textContent).toBe(INVITE_REFUSED_MESSAGE);
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(m.root.textContent).not.toContain("no longer paired");
    expect(m.root.querySelector<HTMLInputElement>("#guest-invite-code")?.value).toBe(CODE);
    // The refused code leaves the tab; a fresh one opens a fresh door.
    expect(m.storage.getItem(inviteKey(m))).toBeNull();
    submit(m, "CNR-1111-0000-1111-0000");
    await until(() => m.sockets.length === 2);
    expect(new URL(m.sockets[1]?.url ?? "").searchParams.get("invite")).toBe("CNR-1111-0000-1111-0000");
    m.sockets[1]?.fail();
    await until(() => m.root.querySelector("#guest-invite-notice") !== null);
  });

  it("keeps the code and says the relay is unreachable when the browser is offline", async () => {
    const m = await mount({ stored: CODE, online: false });
    await until(() => m.sockets.length === 1);
    m.sockets[0]?.fail();
    await m.done;
    expect(m.root.querySelector("#guest-invite-form")).toBeNull();
    expect(m.root.textContent).toContain("Could not reach the relay");
    expect(m.storage.getItem(inviteKey(m))).toBe(CODE);
  });

  it("prefills a malformed fragment code with a notice instead of connecting", async () => {
    const m = await mount({ hash: "#invite=CNR-7K3Q" });
    await m.done;
    expect(m.replaced).toHaveLength(1);
    expect(m.sockets).toHaveLength(0);
    expect(m.root.querySelector("#guest-invite-notice")?.textContent).toContain("malformed");
    expect(m.root.querySelector<HTMLInputElement>("#guest-invite-code")?.value).toBe("CNR-7K3Q");
  });

  it("keeps the fragment's code through the sign-in gate", async () => {
    const m = await mount({ hash: `#invite=${CODE}`, login: null });
    await m.done;
    expect(m.replaced).toHaveLength(1);
    expect(m.storage.getItem(inviteKey(m))).toBe(CODE);
    expect(m.root.querySelector("#signin-go")).not.toBeNull();
    expect(m.sockets).toHaveLength(0);
  });

  it("says the code is spent when the door refuses it after the host let this tab in", async () => {
    const m = await mount({ stored: CODE });
    await until(() => m.sockets.length === 1);
    const ws = m.sockets[0] as FakeWebSocket;
    ws.open();
    await waitForSend(ws);
    const offer = ws.envelopes().find((e) => e.body.t === "offer");
    const offerSig = (offer?.body as { sig: string }).sig;
    const sig = await signTestAnswer(m.host.privateKey, m.device.deviceId, offerSig, ANSWER_SDP);
    ws.receive(`h:${m.host.record.host_id}`, {
      t: "answer",
      sdp: ANSWER_SDP,
      sig,
      host_spki: m.host.record.host_spki,
    });
    await until(() => m.peerHarness.latest().remoteDescription !== null);
    m.peerHarness.latest().firstChannel().remoteOpen();
    await m.done;
    await until(() => m.root.querySelector("#guest-list") !== null);
    // The peer and the relay socket drop; Retry finds the door shut: the
    // first accepted offer burned the code.
    m.peerHarness.latest().firstChannel().close();
    ws.close(1006);
    await until(() => m.root.querySelector("#guest-retry") !== null);
    m.root.querySelector<HTMLButtonElement>("#guest-retry")?.click();
    await until(() => m.sockets.length === 2);
    m.sockets[1]?.fail();
    await until(() => m.root.querySelector("#guest-invite-notice") !== null);
    expect(m.root.querySelector("#guest-invite-notice")?.textContent).toBe(INVITE_SPENT_MESSAGE);
  });
});
