// SPDX-License-Identifier: Apache-2.0
/**
 * One UserRoom per GitHub user: it forwards opaque signaling envelopes
 * between that user's devices, guests and hosts and remembers nothing
 * past the sockets. State lives only in per-socket attachments plus two
 * instance fields; when the last socket closes, nothing of the user
 * remains. Guests are another user's browsers, admitted through the
 * `guest_of` door: they route like devices but never see the hosts list,
 * never pair, and every one is announced to the hosts — with its GitHub
 * identity — so the hub can authorize it. The relay itself authorizes
 * nothing.
 */
import {
  FRAME_MAX_BYTES,
  MAX_DEVICES,
  MAX_GUESTS,
  PAIR_INIT_MAX,
  PAIR_INIT_WINDOW_MS,
  RELAY_HOST_ID_HEADER,
  RELAY_LABEL_HEADER,
  RELAY_LOGIN_HEADER,
  RELAY_ROLE_HEADER,
  RELAY_UID_HEADER,
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

/** The hibernation state, narrowed to what the room uses. */
export interface RoomState {
  acceptWebSocket(socket: RoomSocket): void;
  getWebSockets(): RoomSocket[];
}

/** A freshly split WebSocket pair: index 0 is the client side. */
interface WebSocketPairLike {
  0: RoomSocket;
  1: RoomSocket;
}

/** The runtime's pair constructor, declared narrowly for this module. */
declare const WebSocketPair: new () => WebSocketPairLike;

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

/** A forwarded uid header, or null when it is missing or malformed. */
function parseUid(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) {
    return null;
  }
  const uid = Number(value);
  return Number.isSafeInteger(uid) ? uid : null;
}

/** A guest's announcement to the hosts: who this conn belongs to. */
function identityFrame(kind: "device_identity" | "device_left", attachment: RoomAttachment): string {
  return JSON.stringify({
    from: "relay",
    body: { t: kind, conn: attachment.conn, role: attachment.role, login: attachment.login, uid: attachment.uid },
  });
}

export class UserRoom {
  nextConn = 1;
  pairInit: number[] = [];

  constructor(private readonly state: RoomState) {}

  fetch(request: Request): Response {
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
    if (role === "guest" && (login === null || uid === null)) {
      return json({ error: "bad_request" }, 400);
    }
    if (role === "device" && this.deviceCount() >= MAX_DEVICES) {
      return this.refuse("too_many_devices");
    }
    if (role === "guest" && this.guestCount() >= MAX_GUESTS) {
      return this.refuse("too_many_guests");
    }
    if (role === "host") {
      this.closeHost(hostId as string);
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    this.state.acceptWebSocket(server);
    const attachment: RoomAttachment = {
      role,
      conn: String(this.nextConn),
    };
    this.nextConn += 1;
    if (role === "host") {
      attachment.host_id = hostId as string;
      attachment.label = request.headers.get(RELAY_LABEL_HEADER) ?? "";
    }
    if (role === "guest") {
      attachment.login = login as string;
      attachment.uid = uid as number;
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

  /** A 101 whose server side is already closing: the room is full. */
  private refuse(reason: string): Response {
    const pair = new WebSocketPair();
    const refused = pair[1];
    // Through the hibernation API like every other socket: the runtime
    // only delivers the close on an accepted socket. It carries no
    // attachment, so it is invisible to counts and broadcasts, and its
    // close removes it again.
    this.state.acceptWebSocket(refused);
    refused.close(4008, reason);
    return upgradeResponse(pair[0]);
  }

  webSocketMessage(socket: RoomSocket, message: string | ArrayBuffer): void {
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
      // Reserved address, and the loop guard for the identity notices: an
      // old hub answers an unknown notice with an error addressed here,
      // which must die quietly instead of bouncing back forever.
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
    }
    this.route(socket, to, body);
  }

  webSocketClose(socket: RoomSocket): void {
    this.onSocketGone(socket);
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

  /** True when the body is an object whose `t` is `pair_init`. */
  private isPairInit(body: unknown): boolean {
    return (
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>)["t"] === "pair_init"
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
    // them apart by the device_identity notice, not the address.
    if ((sender.role === "device" || sender.role === "guest") && to.startsWith("h:")) {
      const target = this.findHost(to.slice(2));
      if (target !== null) {
        target.send(JSON.stringify({ from: `d:${sender.conn}`, body }));
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
