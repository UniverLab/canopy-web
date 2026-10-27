// SPDX-License-Identifier: Apache-2.0
/**
 * One UserRoom per GitHub user: it forwards opaque signaling envelopes
 * between that user's devices and hosts and remembers nothing past the
 * sockets. State lives only in per-socket attachments plus two instance
 * fields; when the last socket closes, nothing of the user remains.
 */
import {
  FRAME_MAX_BYTES,
  MAX_DEVICES,
  PAIR_INIT_MAX,
  PAIR_INIT_WINDOW_MS,
  RELAY_HOST_ID_HEADER,
  RELAY_LABEL_HEADER,
  RELAY_ROLE_HEADER,
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

export class UserRoom {
  nextConn = 1;
  pairInit: number[] = [];

  constructor(private readonly state: RoomState) {}

  fetch(request: Request): Response {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return json({ error: "upgrade_required" }, 426);
    }
    const role = request.headers.get(RELAY_ROLE_HEADER);
    if (role !== "device" && role !== "host") {
      return json({ error: "bad_request" }, 400);
    }
    const hostId = request.headers.get(RELAY_HOST_ID_HEADER);
    if (role === "host" && hostId === null) {
      return json({ error: "bad_request" }, 400);
    }
    if (role === "device" && this.deviceCount() >= MAX_DEVICES) {
      const pair = new WebSocketPair();
      // The runtime only delivers the close on an accepted socket; the
      // socket still never joins the room.
      pair[1].accept();
      pair[1].close(4008, "too_many_devices");
      return upgradeResponse(pair[0]);
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
    server.serializeAttachment(attachment);
    if (role === "device") {
      server.send(hostsFrame(this.hostItems()));
    } else {
      this.broadcastHosts();
    }
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
    if (socket.deserializeAttachment()?.role === "host") {
      this.broadcastHosts();
    }
  }

  webSocketError(socket: RoomSocket): void {
    if (socket.deserializeAttachment()?.role === "host") {
      this.broadcastHosts();
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

  /** Push the hosts list to every attached device. */
  private broadcastHosts(): void {
    const frame = hostsFrame(this.hostItems());
    for (const socket of this.state.getWebSockets()) {
      if (socket.deserializeAttachment()?.role === "device") {
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
    if (sender.role === "device" && to.startsWith("h:")) {
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

  /** The attached device socket holding `conn`, if any. */
  private findDevice(conn: string): RoomSocket | null {
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment();
      if (attachment?.role === "device" && attachment.conn === conn) {
        return socket;
      }
    }
    return null;
  }
}
