// SPDX-License-Identifier: Apache-2.0
// The guest side of a /g/<owner_uid>/<host_id>#invite=<code> link: GitHub
// sign-in through the existing app, the host-issued invite code (from the
// fragment, or typed into a form), a guest relay socket into the owner's
// room opened with that code, a TOFU WebRTC handshake with the named host,
// and the shared session list.
// The hub authorizes everything from the relayed GitHub identity: this
// side only renders what arrives and fails closed on forbidden.

import { fetchLogin, signOut } from "./auth.js";
import { CatalogStore } from "./catalog.js";
import { createChannelHandler } from "./channel.js";
import type { JoinedSnapshot } from "./channel.js";
import { generateDeviceKey } from "./crypto.js";
import type { DeviceKey } from "./crypto.js";
import { guardGuestSend } from "./guest-guard.js";
import { GuestPeer } from "./guest-peer.js";
import type { GuestPeerDeps } from "./guest-peer.js";
import {
  INVITE_REFUSED_MESSAGE,
  INVITE_SPENT_MESSAGE,
  canonicalInviteCode,
  forgetInvite,
  loadInvite,
  saveInvite,
  takeInviteFragment,
} from "./guest-invite.js";
import type { InviteStorage } from "./guest-invite.js";
import { createGuestView } from "./guest-views.js";
import type { GuestView } from "./guest-views.js";
import type { TerminalFactory } from "./terminal.js";
import { connectFailMessage } from "./peer.js";
import { buildList, newReqId } from "./protocol.js";
import { RelayKeepalive } from "./keepalive.js";
import { RelaySocket, defaultRelayUrl } from "./relay.js";
import { createFrameRouter } from "./router.js";
import type { RouterShell } from "./router.js";
import { SessionController } from "./session.js";
import { SessionStore } from "./sessions.js";
import { clearDevice, loadDeviceKey, saveDeviceKey } from "./store.js";

// Re-exported from the split module so the guest entry keeps one import.
export { GuestPeer } from "./guest-peer.js";
export type { GuestPeerDeps } from "./guest-peer.js";

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

/**
 * The relay door for a guest of one owner, carrying the invite code. The
 * relay hashes the decoded `invite` value as is, so `code` must already be
 * canonical (see canonicalInviteCode).
 */
export function guestRelayUrl(ownerUid: number, code: string): string {
  return `${defaultRelayUrl()}?guest_of=${ownerUid}&invite=${encodeURIComponent(code)}`;
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
  /** A valid invite code was submitted from the invite form. */
  onInviteSubmit?: (code: string) => void;
  /** Injected in tests; production opens the real xterm terminal. */
  terminalFactory?: TerminalFactory;
  /** Test hook the fake host uses to read terminal output back. */
  onTerminalBytes?: (bytes: Uint8Array) => void;
  /** Test hook the fake host uses to reset that reading on redraw. */
  onTerminalClear?: () => void;
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
// store, controller and router over one guarded send function — the
// allowlist drops whatever the guest may not send. The hub's grant
// arrives as the sessions frame; a denied attach lands back on the list
// with the unauthorized notice. Typing flows exactly as the owner's
// does: the same controller over the same widgets, one shared stream
// with no locking.
export function createGuestSession(root: HTMLElement, deps: GuestSessionDeps): GuestSession {
  const store = new SessionStore();
  const catalog = new CatalogStore();
  const send = guardGuestSend(deps.send);
  const view = createGuestView(
    root,
    store,
    {
      onOpenSession: (id) => open(id),
      onLeaveSession: () => {
        controller.close();
        view.showList();
      },
      onRetry: deps.onRetry,
      onSignOut: deps.onSignOut,
      onForgetDevice: deps.onForgetDevice,
      onInviteSubmit: (code) => deps.onInviteSubmit?.(code),
      onInput: (bytes) => {
        controller.sendInputBytes(bytes);
      },
    },
    { terminalFactory: deps.terminalFactory },
  );
  view.setLogin(deps.login);

  const controller = new SessionController({
    send,
    terminal: () => ({
      write: (bytes) => {
        view.writeTerminal(bytes);
        deps.onTerminalBytes?.(bytes);
      },
      clear: () => {
        view.clearTerminal();
        deps.onTerminalClear?.();
      },
    }),
    onExited: (_id, code) => view.setSessionStatus(`Session exited (${code})`),
  });

  function open(id: string): void {
    view.showSession(id, store.get(id)?.name ?? id);
    controller.open(id);
  }

  // The router's shell slice for a guest: snapshots mount the terminal
  // and every reply lands on an inert sheet stub — a guest opens no
  // sheets and sends no prompts; typing flows as input. A denied attach
  // bypasses this entirely and reaches onForbidden below.
  const routerShell: RouterShell = {
    ensureTerminal: (id, cols, rows) => view.ensureTerminal(id, cols, rows),
    sessionResized: (id, cols, rows) => view.sessionResized(id, cols, rows),
    sheetSpawned: () => {},
    sheetComposed: () => {},
    sheetScheduled: () => {},
    sheetScheduledList: () => {},
    sheetOk: () => {},
    sheetError: () => {},
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

/** What mountGuest reaches outside itself; tests replace any of it. */
export interface GuestMountDeps {
  location: { pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url?: string): void };
  /** This tab's storage for the invite code (sessionStorage). */
  storage: InviteStorage | null;
  fetchLogin: () => Promise<string | null>;
  signOut: () => Promise<void>;
  ensureDeviceKey: () => Promise<DeviceKey>;
  clearDevice: () => Promise<void>;
  /** One relay socket for one door URL. */
  createRelay: (url: string) => RelaySocket;
  /** False when the browser knows it is offline. */
  isOnline: () => boolean;
  /** Extra GuestPeer deps (TURN, RTCPeerConnection, pins) for tests. */
  peer?: Partial<GuestPeerDeps>;
  terminalFactory?: TerminalFactory;
}

function sessionStore(): InviteStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function defaultMountDeps(): GuestMountDeps {
  return {
    location: globalThis.location,
    history: globalThis.history,
    storage: sessionStore(),
    fetchLogin,
    signOut,
    ensureDeviceKey,
    clearDevice,
    createRelay: (url) => new RelaySocket(url),
    isOnline: () => globalThis.navigator?.onLine !== false,
  };
}

/** Mount the guest app behind a /g/ link; main.ts calls this and returns. */
export async function mountGuest(root: HTMLElement, overrides: Partial<GuestMountDeps> = {}): Promise<void> {
  const deps: GuestMountDeps = { ...defaultMountDeps(), ...overrides };
  let peer: GuestPeer | null = null;
  let relay: RelaySocket | null = null;
  let keepalive: RelayKeepalive | null = null;
  let revoked = false;
  // The code this tab joins with, and whether the host ever let this tab
  // in with it: invites are single-use, so a later refusal means spent.
  let invite: string | null = null;
  let admitted = false;
  let inviteNotice: string | null = null;
  let inviteDraft = "";

  const link = parseGuestLink(deps.location.pathname);
  // The fragment goes first, before any await: the code leaves the address
  // bar (and the history entry) at once, and waits in this tab's storage
  // through a sign-in round trip. A malformed one prefills the form.
  const fromFragment = link === null ? null : takeInviteFragment(deps.location, deps.history);
  if (link !== null) {
    if (fromFragment !== null) {
      const canonical = canonicalInviteCode(fromFragment);
      if (canonical === null) {
        inviteNotice = "The invite code in this link is malformed. Check it, or ask the host for a new link.";
        inviteDraft = fromFragment;
      } else {
        saveInvite(link, canonical, deps.storage);
      }
    }
    invite = inviteNotice === null ? loadInvite(link, deps.storage) : null;
  }

  const login = await deps.fetchLogin();
  const session = createGuestSession(root, {
    login,
    send: (data) => peer?.send(data) ?? false,
    onRetry: () => void connect(),
    onSignOut: () => void doSignOut(false),
    onForgetDevice: () => void doSignOut(true),
    onInviteSubmit: (code) => {
      if (link === null) {
        return;
      }
      saveInvite(link, code, deps.storage);
      invite = code;
      admitted = false;
      closeRelay();
      void connect();
    },
    terminalFactory: deps.terminalFactory,
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
  const device = await deps.ensureDeviceKey();

  // One socket per code: the door URL carries it, so a new code is a new
  // socket. A 4003 is the relay kicking a guest whose uid left the
  // allowlist: tear down and land on the terminal screen. The keepalive
  // already stopped itself on the same close, so it never reconnects.
  function openRelay(code: string): RelaySocket {
    const socket = deps.createRelay(guestRelayUrl(ownerUid, code));
    relay = socket;
    keepalive = new RelayKeepalive({ relay: socket });
    keepalive.start();
    socket.onClose((ev) => {
      if (ev.code !== 4003 || relay !== socket) {
        return;
      }
      revoked = true;
      session.detach();
      peer?.close();
      peer = null;
      closeRelay();
      view.showForbidden("access revoked");
    });
    return socket;
  }

  function closeRelay(): void {
    keepalive?.stop();
    keepalive = null;
    const socket = relay;
    relay = null;
    socket?.close();
  }

  // The relay refuses a bad door with an HTTP status (403 bad_invite) the
  // browser never shows to the page: a socket that closes before it ever
  // opened, while online, is the door saying no. Drop the code from this
  // tab and ask again, prefilled so a retry is one tap.
  function inviteRefused(code: string): void {
    closeRelay();
    forgetInvite(link as GuestLink, deps.storage);
    invite = null;
    view.setConnectionState("failed: invite not accepted");
    view.showInvite(admitted ? INVITE_SPENT_MESSAGE : INVITE_REFUSED_MESSAGE, code);
  }

  async function connect(): Promise<void> {
    const code = invite;
    if (code === null) {
      view.showInvite(inviteNotice, inviteDraft);
      return;
    }
    const socket = relay ?? openRelay(code);
    view.showConnecting();
    view.setConnectionState("connecting");
    peer?.close();
    peer = null;
    let failed = false;
    try {
      await socket.connect();
    } catch {
      // A kick racing the open already painted the terminal screen above.
      if (revoked || relay !== socket) {
        return;
      }
      if (deps.isOnline()) {
        inviteRefused(code);
      } else {
        view.setConnectionState("failed: Could not reach the relay");
      }
      return;
    }
    const next = new GuestPeer({ ...deps.peer, relay: socket, ownerUid, hostId, device });
    peer = next;
    next.onEvent((ev) => {
      if (ev.type === "open") {
        // The host accepted the offer: the code is spent from here on.
        admitted = true;
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
      // failure (TURN, offer) with no event reaches here unpainted. A kick
      // racing the handshake painted the terminal screen instead.
      if (!failed && !revoked) {
        view.showConnecting();
        view.setConnectionState(`failed: ${err instanceof Error ? err.message : "Connection failed"}`);
      }
    }
  }

  async function doSignOut(forget: boolean): Promise<void> {
    view.setSignOutError(null);
    try {
      await deps.signOut();
    } catch (err) {
      view.setSignOutError(err instanceof Error ? err.message : "Could not sign out");
      return;
    }
    // The server session is gone: drop the peer and the socket and, on
    // Forget, the pairing keys themselves — the same browser either way.
    session.detach();
    peer?.close();
    peer = null;
    closeRelay();
    if (forget) {
      try {
        await deps.clearDevice();
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
