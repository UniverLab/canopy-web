// SPDX-License-Identifier: Apache-2.0
/**
 * One UserRoom per GitHub user: it forwards opaque signaling envelopes
 * between that user's devices, guests and hosts. Connection ids are random
 * UUIDs, so an evicted room never reissues an id a live socket still
 * holds. State lives in per-socket attachments plus the guest allowlist,
 * the guest invites and pair-init counters in storage, reloaded before the
 * first event, so a fresh instance over warm storage behaves like the
 * evicted one. Guests are another user's browsers, admitted through the
 * `guest_of` door: they route like devices but never see the hosts list,
 * never pair, and every one is announced to the hosts — with its GitHub
 * identity — so the hub can authorize it. The relay enforces admission:
 * only guests with a live invite for their uid connect, one socket per
 * guest login, a republished allowlist kicks the guests it drops, every
 * socket gets a frame budget, and every frame to a host carries the
 * door-attested login/uid; what an invited guest may do is the hub's
 * call, from the injected identity.
 */
import { decodeLabel } from "./codec.js";
import {
  FRAME_MAX_BYTES,
  MAX_DEVICES,
  MAX_GUESTS,
  PAIR_INIT_MAX,
  PAIR_INIT_WINDOW_MS,
  RELAY_HOST_ID_HEADER,
  RELAY_INVITE_HASH_HEADER,
  RELAY_LABEL_HEADER,
  RELAY_LOGIN_HEADER,
  RELAY_ROLE_HEADER,
  RELAY_UID_HEADER,
  SOCKET_RATE_MAX,
  SOCKET_RATE_WINDOW_MS,
  applySecurityHeaders,
  type HostItem,
  type RelayErrorCode,
  type RoomAttachment,
} from "./protocol.js";

/** A hibernating socket, narrowed to what the room uses. */
export interface RoomSocket {
  accept(): void;
  serializeAttachment(attachment: RoomAttachment): void;
  deserializeAttachment(): RoomAttachment | null;
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

/** A hibernation auto-response pair, narrowed to its two getters. */
export interface AutoResponsePair {
  readonly request: string;
  readonly response: string;
}

/** The object's storage, narrowed to the two calls the room makes. */
export interface RoomStorage {
  get(keys: string[]): Promise<Map<string, unknown>>;
  put(entries: Record<string, unknown>): Promise<void>;
}

/** The hibernation state, narrowed to what the room uses. */
export interface RoomState {
  readonly storage: RoomStorage;
  acceptWebSocket(socket: RoomSocket): void;
  getWebSockets(): RoomSocket[];
  setWebSocketAutoResponse(pair?: AutoResponsePair): void;
  getWebSocketAutoResponse(): AutoResponsePair | null;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}

/** A freshly split WebSocket pair: index 0 is the client side. */
interface WebSocketPairLike {
  0: RoomSocket;
  1: RoomSocket;
}

/** The runtime's pair constructor, declared narrowly for this module. */
declare const WebSocketPair: new () => WebSocketPairLike;

/** The runtime's auto-response pair constructor, declared narrowly. */
declare const WebSocketRequestResponsePair: new (
  request: string,
  response: string,
) => AutoResponsePair;

/**
 * The Worker's internal probe: `GET /internal/hosts` answers whether this
 * room holds at least one connected host. Served before the upgrade check;
 * only the Worker binding calls it, never a browser.
 */
export const HOSTS_PROBE_PATH = "/internal/hosts";

/** The storage keys holding the guest allowlist, invites and pair-init stamps. */
const GUEST_ALLOW_KEY = "guestAllow";
const GUEST_INVITES_KEY = "guestInvites";
const PAIR_INIT_KEY = "pairInit";

/** One host-published guest invite: hash of the code, bound uid, unix expiry. */
export interface GuestInvite {
  code_hash: string;
  uid: number;
  expires: number;
}

const INVITE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A fresh connection id: a bare UUID, serialized on the wire as `d:<uuid>`.
 * Random, so a room woken from eviction never reissues an id a carried
 * socket still holds.
 */
export function newConnId(): string {
  return crypto.randomUUID();
}

/** A stored allowlist, or empty when the stored value is malformed. */
function parseStoredUids(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const uids: number[] = [];
  for (const uid of value) {
    if (typeof uid === "number" && Number.isSafeInteger(uid) && uid > 0 && !uids.includes(uid)) {
      uids.push(uid);
    }
  }
  return uids;
}

/** Stored invites, or empty when the stored value is malformed. */
function parseStoredInvites(value: unknown): GuestInvite[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const invites: GuestInvite[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const hash = record["code_hash"];
    const uid = record["uid"];
    const expires = record["expires"];
    if (typeof hash !== "string" || !INVITE_HASH_PATTERN.test(hash) || seen.has(hash)) {
      continue;
    }
    if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid <= 0) {
      continue;
    }
    if (typeof expires !== "number" || !Number.isSafeInteger(expires)) {
      continue;
    }
    seen.add(hash);
    invites.push({ code_hash: hash, uid, expires });
  }
  return invites;
}

/** Stored pair-init stamps, or empty when the stored value is malformed. */
function parseStoredStamps(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((stamp): stamp is number => typeof stamp === "number" && Number.isFinite(stamp));
}

/** A 101 carrying `client`, with the relay's security headers. */
function upgradeResponse(client: RoomSocket): Response {
  const headers = applySecurityHeaders(new Headers());
  const init: ResponseInit & { webSocket: RoomSocket } = { status: 101, headers, webSocket: client };
  return new Response(null, init);
}

function json(body: unknown, status: number): Response {
  const headers = applySecurityHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
  );
  return new Response(JSON.stringify(body), { status, headers });
}

function errorFrame(code: RelayErrorCode): string {
  return JSON.stringify({ from: "relay", body: { t: "error", code } });
}

function hostsFrame(items: HostItem[]): string {
  return JSON.stringify({ from: "relay", body: { t: "hosts", items } });
}

function pongFrame(): string {
  return JSON.stringify({ from: "relay", body: { t: "pong" } });
}

/** A forwarded uid header, or null when it is missing or malformed. */
function parseUid(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const uid = Number(value);
  return Number.isSafeInteger(uid) ? uid : null;
}

/**
 * The host's invite list, or null when the body is malformed. New hosts send
 * `{"t":"guest_allow","uids":[...],"invites":[{code_hash,uid,expires}]}`; old
 * hosts omit `invites`, which reads tolerantly as `[]`, never rejected.
 * Every uid is a positive safe integer, every invite a 64-hex hash with a
 * bound uid and a unix expiry. Duplicates collapse, order kept.
 */
function parseGuestAllow(body: unknown): { uids: number[]; invites: GuestInvite[] } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasInvites = keys.length === 3;
  if (record["t"] !== "guest_allow" || !Array.isArray(record["uids"])) {
    return null;
  }
  if (keys.length === 2) {
    if (!keys.includes("t") || !keys.includes("uids")) {
      return null;
    }
  } else if (hasInvites) {
    if (!keys.includes("t") || !keys.includes("uids") || !keys.includes("invites")) {
      return null;
    }
  } else {
    return null;
  }
  const uids: number[] = [];
  for (const uid of record["uids"] as unknown[]) {
    if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid <= 0) {
      return null;
    }
    if (!uids.includes(uid)) {
      uids.push(uid);
    }
  }
  if (!hasInvites) {
    return { uids, invites: [] };
  }
  if (!Array.isArray(record["invites"])) {
    return null;
  }
  const invites: GuestInvite[] = [];
  const seen = new Set<string>();
  for (const entry of record["invites"] as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const invite = entry as Record<string, unknown>;
    const inviteKeys = Object.keys(invite);
    if (
      inviteKeys.length !== 3 ||
      !inviteKeys.includes("code_hash") ||
      !inviteKeys.includes("uid") ||
      !inviteKeys.includes("expires")
    ) {
      return null;
    }
    const hash = invite["code_hash"];
    const uid = invite["uid"];
    const expires = invite["expires"];
    if (typeof hash !== "string" || !INVITE_HASH_PATTERN.test(hash)) {
      return null;
    }
    if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid <= 0) {
      return null;
    }
    if (typeof expires !== "number" || !Number.isSafeInteger(expires)) {
      return null;
    }
    if (!seen.has(hash)) {
      seen.add(hash);
      invites.push({ code_hash: hash, uid, expires });
    }
  }
  return { uids, invites };
}

/** A guest's announcement to the hosts: who this conn belongs to. */
function identityFrame(kind: "device_identity" | "device_left", attachment: RoomAttachment): string {
  return JSON.stringify({
    from: "relay",
    body: { t: kind, conn: attachment.conn, role: attachment.role, login: attachment.login, uid: attachment.uid },
  });
}

export class UserRoom {
  pairInit: number[] = [];
  /** Uids the host listed; a republish kicks connected guests past this list. Set via `guest_allow`. */
  guestAllow: number[] = [];
  /** Live invites the host published; a guest needs one bound to its uid. Set via `guest_allow`. */
  guestInvites: GuestInvite[] = [];
  /** Resolves once the stored guest lists and pair counters have loaded. */
  readonly ready: Promise<void>;

  constructor(private readonly state: RoomState) {
    // Hosts ping with plain-text pings (protocol pings never reach us):
    // the edge answers without waking this room.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    // Hibernation evicts this object while its sockets stay connected and
    // replays the constructor on wake: the guest lists and pair counters
    // reload here, gated before the first event, so a fresh instance over
    // warm storage behaves exactly like the evicted one.
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get([GUEST_ALLOW_KEY, GUEST_INVITES_KEY, PAIR_INIT_KEY]);
      this.guestAllow = parseStoredUids(stored.get(GUEST_ALLOW_KEY));
      this.guestInvites = parseStoredInvites(stored.get(GUEST_INVITES_KEY));
      this.pairInit = parseStoredStamps(stored.get(PAIR_INIT_KEY));
    });
  }

  fetch(request: Request): Response {
    if (request.method === "GET" && new URL(request.url).pathname === HOSTS_PROBE_PATH) {
      return json({ hasHost: this.hasHost() }, 200);
    }
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "upgrade_required" }, 426);
    }
    const role = request.headers.get(RELAY_ROLE_HEADER);
    if (role !== "device" && role !== "host" && role !== "guest") {
      return json({ error: "bad_request" }, 400);
    }
    const hostId = request.headers.get(RELAY_HOST_ID_HEADER);
    if (role === "host" && hostId === null) {
      return json({ error: "bad_request" }, 400);
    }
    // A guest without an identity is useless to the hub, which authorizes
    // from it: fail closed before accepting.
    const login = request.headers.get(RELAY_LOGIN_HEADER);
    const uid = parseUid(request.headers.get(RELAY_UID_HEADER));
    if (role === "guest" && (login === null || login === "" || uid === null)) {
      return json({ error: "bad_request" }, 400);
    }
    // Strangers cannot squat a room: the invite hash must match a live
    // invite bound to this uid. One error for every failure, no oracle.
    if (role === "guest" && !this.hasLiveInvite(request, uid as number)) {
      return this.refuse("bad_invite", 403);
    }
    // One socket per guest login: the newest duplicate is refused, the
    // first stays connected.
    if (role === "guest" && this.hasGuestLogin(login as string)) {
      return this.refuse("guest_duplicate", 409);
    }
    if (role === "device" && this.deviceCount() >= MAX_DEVICES) {
      return this.refuse("too_many_devices", 429);
    }
    if (role === "guest" && this.guestCount() >= MAX_GUESTS) {
      return this.refuse("too_many_guests", 429);
    }
    if (role === "host") {
      this.closeHost(hostId as string);
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const attachment: RoomAttachment = {
      role,
      conn: newConnId(),
    };
    if (role === "host") {
      attachment.host_id = hostId as string;
      attachment.label = decodeLabel(request.headers.get(RELAY_LABEL_HEADER) ?? "");
    }
    if (role === "guest") {
      attachment.login = login as string;
      attachment.uid = uid as number;
    }
    if (role === "device" && login !== null && login !== "" && uid !== null) {
      attachment.login = login;
      attachment.uid = uid;
    }
    server.serializeAttachment(attachment);
    if (role === "device") {
      server.send(hostsFrame(this.hostItems()));
    } else if (role === "host") {
      this.broadcastHosts();
      // A host that (re)connected missed every earlier announcement: hand
      // it the guests it must already be authorizing.
      for (const guest of this.guestAttachments()) {
        server.send(identityFrame("device_identity", guest));
      }
    } else {
      // Guests never see the hosts list; the hosts see the guest instead.
      this.broadcastToHosts(identityFrame("device_identity", attachment));
    }
    return upgradeResponse(pair[0]);
  }

  /** A refused socket never upgrades: no 101, no socket. */
  private refuse(reason: string, status: number): Response {
    return json({ error: reason }, status);
  }

  webSocketMessage(socket: RoomSocket, message: string | ArrayBuffer): void {
    // Signaling is small: every frame costs one token, and a socket that
    // spends its budget is closed instead of answered.
    if (!this.spendToken(socket)) {
      return;
    }
    if (typeof message !== "string") {
      socket.send(errorFrame("bad_frame"));
      return;
    }
    if (new TextEncoder().encode(message).length > FRAME_MAX_BYTES) {
      socket.send(errorFrame("too_large"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      socket.send(errorFrame("bad_frame"));
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      socket.send(errorFrame("bad_frame"));
      return;
    }
    const { to, body } = parsed as { to?: unknown; body?: unknown };
    if (typeof to !== "string") {
      socket.send(errorFrame("bad_frame"));
      return;
    }
    if (to === "relay") {
      // Browsers cannot send protocol pings, so they send an app ping the
      // edge cannot auto-answer: reply here and nowhere else. Anything
      // else to this reserved address dies quietly — the loop guard for
      // the identity notices, where an old hub answers an unknown notice
      // with an error addressed here.
      if (this.isPing(body)) {
        socket.send(pongFrame());
      }
      return;
    }
    if (to === "room") {
      // The host-to-room path: management frames for this room, handled
      // here and never routed.
      this.handleRoomFrame(socket, body);
      return;
    }
    // Guests never pair: pairing binds a device to the owner's hub, and a
    // guest's key must never land in that registry.
    if (this.isPairInit(body) && socket.deserializeAttachment()?.role === "guest") {
      socket.send(errorFrame("forbidden"));
      return;
    }
    if (this.isPairInit(body)) {
      const now = Date.now();
      this.pairInit = this.pairInit.filter((stamp) => now - stamp < PAIR_INIT_WINDOW_MS);
      if (this.pairInit.length >= PAIR_INIT_MAX) {
        socket.send(errorFrame("rate_limited"));
        return;
      }
      this.pairInit.push(now);
      this.save();
    }
    this.route(socket, to, body);
  }

  webSocketClose(socket: RoomSocket, code?: number, reason?: string): void {
    // Echo the client's close so the handshake completes, then run the
    // same gone-notices as an error. The echo must never swallow the
    // notices: a throw would leave a stale hosts list or a missing
    // device_left.
    try {
      socket.close(code, reason);
    } finally {
      this.onSocketGone(socket);
    }
  }

  webSocketError(socket: RoomSocket): void {
    this.onSocketGone(socket);
  }

  /** A closed socket leaves the hosts list, or a guest leaves the hub. */
  private onSocketGone(socket: RoomSocket): void {
    const attachment = socket.deserializeAttachment();
    if (attachment?.role === "host") {
      this.broadcastHosts();
    } else if (attachment?.role === "guest") {
      this.broadcastToHosts(identityFrame("device_left", attachment));
    }
  }

  /**
   * Spend one frame token, refilling from the clock. True spends and the
   * frame proceeds; a socket past its budget is closed with 4009 and its
   * frame dropped, with no error frame. The attachment is re-serialized
   * on every spend so hibernation keeps the budget.
   */
  private spendToken(socket: RoomSocket): boolean {
    const attachment = socket.deserializeAttachment();
    if (attachment === null) {
      return true;
    }
    const now = Date.now();
    const rate = attachment.rate ?? { tokens: SOCKET_RATE_MAX, at: now };
    const refilled = Math.min(
      SOCKET_RATE_MAX,
      rate.tokens + ((now - rate.at) * SOCKET_RATE_MAX) / SOCKET_RATE_WINDOW_MS,
    );
    if (refilled < 1) {
      socket.close(4009, "rate_limited");
      return false;
    }
    attachment.rate = { tokens: refilled - 1, at: now };
    socket.serializeAttachment(attachment);
    return true;
  }

  /**
   * A management frame for this room: the host's invite lists replace the
   * old ones, silently, and every connected guest whose uid left the list
   * is closed with 4003 (`not_invited`) — the relay's second barrier when
   * access is revoked. Anything else bounces. The runtime's webSocketClose
   * announces each kicked guest to the hosts as `device_left`, the normal
   * close path, so nothing is emitted here.
   */
  private handleRoomFrame(socket: RoomSocket, body: unknown): void {
    if (socket.deserializeAttachment()?.role !== "host") {
      socket.send(errorFrame("forbidden"));
      return;
    }
    const allow = parseGuestAllow(body);
    if (allow === null) {
      socket.send(errorFrame("bad_frame"));
      return;
    }
    this.guestAllow = allow.uids;
    this.guestInvites = allow.invites;
    this.save();
    this.pruneRevokedGuests(allow.uids);
  }

  /**
   * Close every connected guest socket whose uid is no longer listed.
   * O(connected guests) per `guest_allow`, a rare frame; listed guests,
   * devices and hosts are untouched.
   */
  private pruneRevokedGuests(uids: number[]): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.role !== "guest") {
        continue;
      }
      if (attachment.uid === undefined || !uids.includes(attachment.uid)) {
        socket.close(4003, "not_invited");
      }
    }
  }

  /**
   * Persist the guest lists and pair counters for the next eviction. Called
   * only on guest/pair mutations — never per frame or per ping.
   */
  private save(): void {
    const write = this.state.storage.put({
      [GUEST_ALLOW_KEY]: [...this.guestAllow],
      [GUEST_INVITES_KEY]: this.guestInvites.map((invite) => ({ ...invite })),
      [PAIR_INIT_KEY]: [...this.pairInit],
    });
    this.state.waitUntil(write);
  }

  /**
   * True when the invite hash header matches a live invite bound to `uid`.
   * O(invites) per guest door hit; every failure looks the same.
   */
  private hasLiveInvite(request: Request, uid: number): boolean {
    const hash = request.headers.get(RELAY_INVITE_HASH_HEADER);
    if (hash === null || !INVITE_HASH_PATTERN.test(hash)) {
      return false;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const invite of this.guestInvites) {
      if (invite.code_hash === hash && invite.uid === uid && invite.expires > nowSec) {
        return true;
      }
    }
    return false;
  }

  /** True when the body is an object whose `t` is `pair_init`. */
  private isPairInit(body: unknown): boolean {
    return (
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>)["t"] === "pair_init"
    );
  }

  /** True when the body is an object whose `t` is `ping`. */
  private isPing(body: unknown): boolean {
    return (
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>)["t"] === "ping"
    );
  }

  /** How many device sockets are currently attached. */
  private deviceCount(): number {
    let count = 0;
    for (const socket of this.state.getWebSockets()) {
      if (socket.deserializeAttachment()?.role === "device") {
        count += 1;
      }
    }
    return count;
  }

  /** How many guest sockets are currently attached. */
  private guestCount(): number {
    let count = 0;
    for (const socket of this.state.getWebSockets()) {
      if (socket.deserializeAttachment()?.role === "guest") {
        count += 1;
      }
    }
    return count;
  }

  /** True when a guest socket already holds `login`. */
  private hasGuestLogin(login: string): boolean {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.role === "guest" && attachment.login === login) {
        return true;
      }
    }
    return false;
  }

  /** Every attached guest's attachment, for a (re)connected host. */
  private guestAttachments(): RoomAttachment[] {
    const guests: RoomAttachment[] = [];
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.role === "guest") {
        guests.push(attachment);
      }
    }
    return guests;
  }

  /** Close the attached socket holding `hostId`, if any. */
  private closeHost(hostId: string): void {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.role === "host" && attachment.host_id === hostId) {
        socket.close(4000, "replaced");
      }
    }
  }

  /** True when at least one host socket is attached. */
  private hasHost(): boolean {
    for (const socket of this.state.getWebSockets()) {
      if (socket.deserializeAttachment()?.role === "host") {
        return true;
      }
    }
    return false;
  }

  /** The current hosts, sorted by id. */
  private hostItems(): HostItem[] {
    const items: HostItem[] = [];
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.role === "host" && attachment.host_id !== undefined) {
        items.push({ host_id: attachment.host_id, label: attachment.label ?? "" });
      }
    }
    items.sort((left, right) => (left.host_id < right.host_id ? -1 : left.host_id > right.host_id ? 1 : 0));
    return items;
  }

  /** Push the hosts list to every attached device. Guests never see it. */
  private broadcastHosts(): void {
    const frame = hostsFrame(this.hostItems());
    for (const socket of this.state.getWebSockets()) {
      if (socket.deserializeAttachment()?.role === "device") {
        socket.send(frame);
      }
    }
  }

  /** Push one prebuilt frame to every attached host. */
  private broadcastToHosts(frame: string): void {
    for (const socket of this.state.getWebSockets()) {
      if (socket.deserializeAttachment()?.role === "host") {
        socket.send(frame);
      }
    }
  }

  /** Deliver one envelope, rewriting its source; unknown targets bounce. */
  private route(socket: RoomSocket, to: string, body: unknown): void {
    const sender = socket.deserializeAttachment();
    if (sender === null) {
      socket.send(errorFrame("no_target"));
      return;
    }
    // Guests ride the same d:<conn> addresses as devices; the hub tells
    // them apart by the injected identity, not the address. The top-level
    // login/uid overwrite any client bytes — old hosts ignore the siblings.
    if ((sender.role === "device" || sender.role === "guest") && to.startsWith("h:")) {
      const target = this.findHost(to.slice(2));
      if (target !== null) {
        target.send(JSON.stringify({ from: `d:${sender.conn}`, login: sender.login, uid: sender.uid, body }));
        return;
      }
    } else if (sender.role === "host" && to.startsWith("d:")) {
      const target = this.findDevice(to.slice(2));
      if (target !== null && sender.host_id !== undefined) {
        target.send(JSON.stringify({ from: `h:${sender.host_id}`, body }));
        return;
      }
    }
    socket.send(errorFrame("no_target"));
  }

  /** The attached host socket holding `hostId`, if any. */
  private findHost(hostId: string): RoomSocket | null {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.role === "host" && attachment.host_id === hostId) {
        return socket;
      }
    }
    return null;
  }

  /** The attached device or guest socket holding `conn`, if any. */
  private findDevice(conn: string): RoomSocket | null {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if ((attachment?.role === "device" || attachment?.role === "guest") && attachment.conn === conn) {
        return socket;
      }
    }
    return null;
  }
}
