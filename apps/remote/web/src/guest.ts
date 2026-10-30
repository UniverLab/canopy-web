// SPDX-License-Identifier: Apache-2.0
// The guest side of a /g/<owner_uid>/<host_id> link: GitHub sign-in
// through the existing app, a guest relay socket into the owner's room, a
// TOFU WebRTC handshake with the named host, and the shared session list.
// The hub authorizes everything from the relayed GitHub identity: this
// side only renders what arrives and fails closed on forbidden.

import { fetchLogin, signOut } from "./auth.js";
import { CatalogStore } from "./catalog.js";
import { createChannelHandler } from "./channel.js";
import type { JoinedSnapshot } from "./channel.js";
import {
  b64decode,
  generateDeviceKey,
  idFromSpki,
  importSpkiVerifyKey,
  signOffer,
  verifyAnswer,
} from "./crypto.js";
import type { DeviceKey } from "./crypto.js";
import { getGuestHost, guestHostKey, saveGuestHost } from "./guest-store.js";
import type { GuestHostRecord } from "./guest-store.js";
import { createGuestView } from "./guest-views.js";
import type { GuestView } from "./guest-views.js";
import { asConnectFail, asIceCandidate, connectFailMessage, isBye, loadIceServers } from "./peer.js";
import type { PeerConnectionFactory, PeerEvent, TurnFetcher } from "./peer.js";
import { DATA_CHANNEL_LABEL } from "./peer.js";
import { buildList, newReqId } from "./protocol.js";
import { RelaySocket, defaultRelayUrl } from "./relay.js";
import type { RelayFrame } from "./relay.js";
import { createFrameRouter } from "./router.js";
import type { RouterShell } from "./router.js";
import { SessionController } from "./session.js";
import { SessionStore } from "./sessions.js";
import { clearDevice, loadDeviceKey, saveDeviceKey } from "./store.js";

/** A parsed guest link: whose room, and which of their hosts. */
export interface GuestLink {
  ownerUid: number;
  hostId: string;
}

const GUEST_LINK_PATTERN = /^\/g\/([1-9][0-9]*)\/([0-9a-f]{16})\/?$/;

/** Parse `/g/<owner_uid>/<host_id>`; null when the link is malformed. */
export function parseGuestLink(pathname: string): GuestLink | null {
  const match = GUEST_LINK_PATTERN.exec(pathname);
  if (match === null) {
    return null;
  }
  const ownerUid = Number(match[1]);
  if (!Number.isSafeInteger(ownerUid)) {
    return null;
  }
  return { ownerUid, hostId: match[2] as string };
}

/** The relay door for a guest of one owner. */
export function guestRelayUrl(ownerUid: number): string {
  return `${defaultRelayUrl()}?guest_of=${ownerUid}`;
}

export interface GuestPeerDeps {
  relay: RelaySocket;
  ownerUid: number;
  hostId: string;
  device: DeviceKey;
  fetchTurn?: TurnFetcher;
  createConnection?: PeerConnectionFactory;
  nowMs?: () => number;
  getPin?: (ownerUid: number, hostId: string) => Promise<GuestHostRecord | null>;
  savePin?: (host: GuestHostRecord) => Promise<void>;
}

interface GuestAnswerBody {
  sdp: string;
  sig: string;
  host_spki: string;
}

function asGuestAnswer(body: unknown): GuestAnswerBody | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const row = body as Record<string, unknown>;
  if (row.t !== "answer" || typeof row.sdp !== "string" || typeof row.sig !== "string") {
    return null;
  }
  // A guest answer carries the host key: without a pairing there is no
  // other way to learn it, so an answer without one is unusable.
  if (typeof row.host_spki !== "string" || row.host_spki === "") {
    return null;
  }
  return { sdp: row.sdp, sig: row.sig, host_spki: row.host_spki };
}

// WebRTC connection to one host as a guest: the owner's offer plus this
// browser's SPKI (the hub has no pairing row to look the key up by), and
// TOFU on the host key the answer carries, pinned apart from pairings.
// Single-use, like the owner's peer; the two handshakes stay separate
// classes because their trust roots differ.
export class GuestPeer {
  private readonly relay: RelaySocket;
  private readonly ownerUid: number;
  private readonly hostId: string;
  private readonly device: DeviceKey;
  private readonly fetchTurn: TurnFetcher;
  private readonly createConnection: PeerConnectionFactory;
  private readonly nowMs: () => number;
  private readonly getPin: (ownerUid: number, hostId: string) => Promise<GuestHostRecord | null>;
  private readonly savePin: (host: GuestHostRecord) => Promise<void>;
  private readonly handlers = new Set<(ev: PeerEvent) => void>();
  private readonly queuedCandidates: RTCIceCandidateInit[] = [];
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private unsubscribe: (() => void) | null = null;
  private offerSig = "";
  private started = false;
  private state: "idle" | "starting" | "open" | "done" = "idle";
  private settleOpen: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(deps: GuestPeerDeps) {
    this.relay = deps.relay;
    this.ownerUid = deps.ownerUid;
    this.hostId = deps.hostId;
    this.device = deps.device;
    this.fetchTurn = deps.fetchTurn ?? ((url) => globalThis.fetch(url));
    this.createConnection = deps.createConnection ?? ((config) => new RTCPeerConnection(config));
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.getPin = deps.getPin ?? ((ownerUid, hostId) => getGuestHost(ownerUid, hostId));
    this.savePin = deps.savePin ?? ((host) => saveGuestHost(host));
  }

  onEvent(handler: (ev: PeerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(ev: PeerEvent): void {
    for (const handler of this.handlers) {
      handler(ev);
    }
  }

  private get target(): string {
    return `h:${this.hostId}`;
  }

  async connect(): Promise<void> {
    if (this.started) {
      throw new Error("Peer is already running");
    }
    this.started = true;
    this.state = "starting";
    try {
      const iceServers = await loadIceServers(this.fetchTurn);
      const pc = this.createConnection({ iceServers });
      this.pc = pc;
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      this.channel = channel;
      channel.onopen = () => {
        if (this.state !== "starting") {
          return;
        }
        this.state = "open";
        this.settleOpen?.resolve();
        this.settleOpen = null;
        this.emit({ type: "open" });
      };
      channel.onclose = () => this.remoteClosed();
      channel.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string") {
          this.emit({ type: "message", data: ev.data });
        }
      };
      pc.onconnectionstatechange = () => {
        this.emit({ type: "ice", state: pc.connectionState });
      };
      pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
        if (ev.candidate) {
          this.relay.trySend(this.target, { t: "ice", candidate: ev.candidate.toJSON() });
        }
      };
      this.unsubscribe = this.relay.onFrame((frame: RelayFrame) => {
        if (frame.from === this.target) {
          void this.onHostFrame(frame.body);
        }
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? offer.sdp;
      if (!sdp) {
        throw new Error("Could not create an offer");
      }
      const ts = String(Math.floor(this.nowMs() / 1000));
      this.offerSig = await signOffer(this.device.privateKey, this.hostId, ts, sdp);
      this.relay.send(this.target, {
        t: "offer",
        device_id: this.device.deviceId,
        ts,
        sdp,
        sig: this.offerSig,
        device_spki: this.device.spkiB64,
      });
      await new Promise<void>((resolve, reject) => {
        this.settleOpen = { resolve, reject };
      });
    } catch (err) {
      this.teardown(true);
      throw err instanceof Error ? err : new Error("Connection failed");
    }
  }

  // Session-layer frames to the host. False when there is no open data
  // channel; the caller decides whether to retry or drop.
  send(data: string): boolean {
    if (this.state !== "open" || !this.channel || this.channel.readyState !== "open") {
      return false;
    }
    try {
      this.channel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.state === "starting") {
      this.settleOpen?.reject(new Error("Connection closed"));
      this.settleOpen = null;
    }
    this.teardown(true);
  }

  private fail(reason: string): void {
    if (this.state === "done") {
      return;
    }
    this.settleOpen?.reject(new Error(reason));
    this.settleOpen = null;
    this.teardown(true);
    this.emit({ type: "failed", reason });
  }

  private remoteClosed(): void {
    if (this.state === "done") {
      return;
    }
    this.settleOpen?.reject(new Error("Connection closed before it opened"));
    this.settleOpen = null;
    this.teardown(false);
    this.emit({ type: "closed" });
  }

  private async onHostFrame(body: unknown): Promise<void> {
    if (this.state === "done" || this.state === "idle") {
      return;
    }
    const failReason = asConnectFail(body);
    if (failReason !== null) {
      this.fail(connectFailMessage(failReason));
      return;
    }
    if (isBye(body)) {
      this.remoteClosed();
      return;
    }
    const candidate = asIceCandidate(body);
    if (candidate !== null) {
      await this.addRemoteCandidate(candidate);
      return;
    }
    const answer = asGuestAnswer(body);
    if (answer !== null) {
      await this.onAnswer(answer);
    }
  }

  // Trust on first use: the presented key must hash to the linked host id
  // and match the pin when one exists; the answer signature verifies
  // against the pinned key, never the presented one. A first visit pins
  // only after the signature verifies.
  private async onAnswer(answer: GuestAnswerBody): Promise<void> {
    if (!this.pc || this.offerSig === "") {
      return;
    }
    if (this.pc.remoteDescription) {
      return;
    }
    let presented: Uint8Array;
    try {
      presented = b64decode(answer.host_spki);
    } catch {
      this.fail("Host identity check failed");
      return;
    }
    let presentedId: string;
    try {
      presentedId = await idFromSpki(presented);
    } catch {
      this.fail("Host identity check failed");
      return;
    }
    if (presentedId !== this.hostId) {
      this.fail("Host identity check failed");
      return;
    }
    let pinned: GuestHostRecord | null;
    try {
      pinned = await this.getPin(this.ownerUid, this.hostId);
    } catch {
      this.fail("Host identity check failed");
      return;
    }
    if (pinned !== null && pinned.host_spki !== answer.host_spki) {
      this.fail("Host identity check failed");
      return;
    }
    let hostKey: CryptoKey;
    try {
      hostKey = await importSpkiVerifyKey(b64decode(pinned?.host_spki ?? answer.host_spki));
    } catch {
      this.fail("Host identity check failed");
      return;
    }
    // verifyAnswer decodes the signature first: undecodable base64
    // throws instead of returning false, and must fail like a forgery.
    let valid: boolean;
    try {
      valid = await verifyAnswer(
        hostKey,
        this.device.deviceId,
        this.offerSig,
        answer.sdp,
        answer.sig,
      );
    } catch {
      this.fail("Host identity check failed");
      return;
    }
    if (!valid) {
      this.fail("Host identity check failed");
      return;
    }
    try {
      await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch {
      this.fail("Connection failed");
      return;
    }
    if (pinned === null) {
      try {
        await this.savePin({
          key: guestHostKey(this.ownerUid, this.hostId),
          owner_uid: this.ownerUid,
          host_id: this.hostId,
          host_spki: answer.host_spki,
          label: "",
        });
      } catch {
        this.fail("Host identity check failed");
        return;
      }
    }
    const queued = this.queuedCandidates.splice(0, this.queuedCandidates.length);
    for (const init of queued) {
      await this.addRemoteCandidate(init);
    }
  }

  private async addRemoteCandidate(init: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || this.state === "done") {
      return;
    }
    if (!this.pc.remoteDescription) {
      this.queuedCandidates.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch {
      // A malformed candidate must not kill the connection.
    }
  }

  private teardown(sendBye: boolean): void {
    const first = this.state !== "done";
    this.state = "done";
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onmessage = null;
      try {
        this.channel.close();
      } catch {
        // Already closed.
      }
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      try {
        this.pc.close();
      } catch {
        // Already closed.
      }
      this.pc = null;
    }
    if (sendBye && first && this.offerSig !== "") {
      this.relay.trySend(this.target, { t: "bye" });
    }
  }
}

async function ensureDeviceKey(): Promise<DeviceKey> {
  const existing = await loadDeviceKey();
  if (existing) {
    return existing;
  }
  const fresh = await generateDeviceKey();
  await saveDeviceKey(fresh);
  return fresh;
}

/** What a guest session needs beyond the DOM root: identity and a wire. */
export interface GuestSessionDeps {
  login: string | null;
  send: (data: string) => boolean;
  onRetry: () => void;
  onSignOut: () => void;
  onForgetDevice: () => void;
}

export interface GuestSession {
  view: GuestView;
  /** Open one session: the same path as clicking its row. */
  open: (id: string) => void;
  /** One raw data-channel string, into the snapshot assembler. */
  push: (raw: string) => void;
  /** Re-attach the open session after a reconnect. */
  reattach: () => boolean;
  /** Detach the open session, if any. */
  detach: () => void;
}

// The guest session wiring production and the fake host share: views,
// store, controller and router over one send function. The hub's grant
// arrives as the sessions frame; a denied attach lands back on the list
// with the unauthorized notice.
export function createGuestSession(root: HTMLElement, deps: GuestSessionDeps): GuestSession {
  const store = new SessionStore();
  const catalog = new CatalogStore();
  const view = createGuestView(root, store, {
    onOpenSession: (id) => open(id),
    onLeaveSession: () => {
      controller.close();
      view.showList();
    },
    onRetry: deps.onRetry,
    onSignOut: deps.onSignOut,
    onForgetDevice: deps.onForgetDevice,
  });
  view.setLogin(deps.login);

  const controller = new SessionController({
    send: deps.send,
    terminal: () => ({
      write: (text) => view.appendOutput(text),
      clear: () => view.clearOutput(),
    }),
    onExited: (_id, code) => view.setSessionStatus(`Session exited (${code})`),
  });

  function open(id: string): void {
    view.showSession(id, store.get(id)?.name ?? id);
    controller.open(id);
  }

  // The router's shell slice for a guest: a snapshot lands the read-only
  // pane; anything composer- or sheet-shaped is inert — a guest sends no
  // prompts and opens no sheets — except errors, which land as the
  // session's status line. A denied attach bypasses this entirely and
  // reaches onForbidden below.
  const routerShell: RouterShell = {
    ensureTerminal: (id) => {
      if (controller.sessionId === id) {
        view.setSessionStatus(null);
      }
    },
    composerOk: () => {},
    composerError: (message) => view.setSessionStatus(message),
    sheetSpawned: () => {},
    sheetComposed: () => {},
    sheetOk: () => {},
    sheetError: (message) => view.setSessionStatus(message),
  };

  const router = createFrameRouter({
    store,
    controller,
    shell: routerShell,
    catalog,
    onForbidden: (id) => {
      // The attach is denied: drop the open id (its detach answers a
      // session the hub never attached, so it lands nowhere) and land
      // back on the list with the unauthorized notice. The name comes
      // from the stale row when the denied id is still listed.
      controller.close();
      const denied = id === null ? null : store.get(id);
      view.showList(
        denied === null ? "That session is not shared with you." : `“${denied.name}” is not shared with you.`,
      );
    },
  });
  const frames = createChannelHandler({
    onSnapshot: (snapshot: JoinedSnapshot) => router.handleSnapshot(snapshot),
    onFrame: router.handleFrame,
  });

  return {
    view,
    open,
    push: (raw: string) => frames.push(raw),
    reattach: () => controller.reattach(),
    detach: () => controller.close(),
  };
}

/** Mount the guest app behind a /g/ link; main.ts calls this and returns. */
export async function mountGuest(root: HTMLElement): Promise<void> {
  let peer: GuestPeer | null = null;
  let relay: RelaySocket | null = null;

  const login = await fetchLogin();
  const link = parseGuestLink(globalThis.location.pathname);
  const session = createGuestSession(root, {
    login,
    send: (data) => peer?.send(data) ?? false,
    onRetry: () => void connect(),
    onSignOut: () => void doSignOut(false),
    onForgetDevice: () => void doSignOut(true),
  });
  const view = session.view;
  if (link === null) {
    view.showInvalidLink();
    return;
  }
  if (login === null) {
    view.showSignIn();
    return;
  }
  // Plain consts: the hoisted connect() below cannot carry the null check.
  const ownerUid = link.ownerUid;
  const hostId = link.hostId;
  const device = await ensureDeviceKey();
  relay = new RelaySocket(guestRelayUrl(ownerUid));

  async function connect(): Promise<void> {
    const socket = relay;
    if (socket === null) {
      return;
    }
    view.showConnecting();
    view.setConnectionState("connecting");
    peer?.close();
    peer = null;
    let failed = false;
    try {
      await socket.connect();
    } catch {
      view.setConnectionState("failed: Could not reach the relay");
      return;
    }
    const next = new GuestPeer({ relay: socket, ownerUid, hostId, device });
    peer = next;
    next.onEvent((ev) => {
      if (ev.type === "open") {
        view.setConnectionState("connected");
        view.showList();
        next.send(buildList(newReqId()));
        session.reattach();
      } else if (ev.type === "failed") {
        failed = true;
        if (ev.reason === connectFailMessage("forbidden")) {
          view.showForbidden(ev.reason);
        } else {
          view.showConnecting();
          view.setConnectionState(`failed: ${ev.reason}`);
        }
      } else if (ev.type === "closed") {
        view.showConnecting();
        view.setConnectionState("failed: Connection closed");
      } else if (ev.type === "message") {
        session.push(ev.data);
      }
    });
    try {
      await next.connect();
    } catch (err) {
      // The failed event above already painted the state; only a setup
      // failure (TURN, offer) with no event reaches here unpainted.
      if (!failed) {
        view.showConnecting();
        view.setConnectionState(`failed: ${err instanceof Error ? err.message : "Connection failed"}`);
      }
    }
  }

  async function doSignOut(forget: boolean): Promise<void> {
    view.setSignOutError(null);
    try {
      await signOut();
    } catch (err) {
      view.setSignOutError(err instanceof Error ? err.message : "Could not sign out");
      return;
    }
    // The server session is gone: drop the peer and the socket and, on
    // Forget, the pairing keys themselves — the same browser either way.
    session.detach();
    peer?.close();
    peer = null;
    relay?.close();
    if (forget) {
      try {
        await clearDevice();
      } catch {
        // The session is already dead; a stale key row is repaired on
        // the next pair, never a reason to hold the sign-in screen.
      }
    }
    view.setLogin(null);
    view.showSignIn();
  }

  await connect();
}
