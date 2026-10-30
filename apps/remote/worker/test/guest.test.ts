// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { signSession } from "../src/auth.js";
import type { RoomAttachment } from "../src/protocol.js";
import { UserRoom } from "../src/room.js";
import { handleDeviceWs, type RoomNamespace, type RoomStub, type WsEnv } from "../src/ws.js";
import { FakeRoomState, FakeRoomSocket } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";
const SECRET = "test-session-secret-that-is-long-enough";
const HOST_ID = "0123456789abcdef";
const OWNER_UID = 111;
const GUEST_UID = 222;
const GUEST_LOGIN = "guest-user";

function upgradeRequest(role: string, extra: Record<string, string> = {}): Request {
  const headers = new Headers({ upgrade: "websocket", "x-relay-role": role, ...extra });
  return new Request("https://user-room/", { headers });
}

function guestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-relay-login": GUEST_LOGIN, "x-relay-uid": String(GUEST_UID), ...extra };
}

/** A real client socket, narrowed to what the tests drive. */
interface TestClient {
  accept(): void;
  send(message: string): void;
  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void;
}

function clientOf(response: Response): TestClient {
  const client = (response as unknown as { webSocket?: TestClient }).webSocket;
  if (!client) {
    throw new Error("expected a 101 carrying a client socket");
  }
  return client;
}

function nextMessage(client: TestClient): Promise<string> {
  return new Promise((resolve) => {
    client.addEventListener(
      "message",
      (event) => resolve(String((event as unknown as { data: unknown }).data)),
      { once: true },
    );
  });
}

function nextClose(client: TestClient): Promise<number> {
  return new Promise((resolve) => {
    client.addEventListener(
      "close",
      (event) => resolve((event as unknown as { code: number }).code),
      { once: true },
    );
  });
}

/** Every message the client receives within `ms`; empty when it stays silent. */
function collectMessages(client: TestClient, ms = 20): Promise<string[]> {
  const seen: string[] = [];
  client.addEventListener("message", (event) => {
    seen.push(String((event as unknown as { data: unknown }).data));
  });
  return new Promise((resolve) => {
    setTimeout(() => resolve(seen), ms);
  });
}

function setup(): { state: FakeRoomState; room: UserRoom } {
  const state = new FakeRoomState();
  return { state, room: new UserRoom(state) };
}

/**
 * An accepted fake socket, with the conn the room would have assigned.
 * Guests carry the identity the door forwards.
 */
function attachFake(
  state: FakeRoomState,
  room: UserRoom,
  role: "device" | "host" | "guest",
  extra: { host_id?: string; label?: string; login?: string; uid?: number } = {},
): FakeRoomSocket {
  const socket = state.makeSocket();
  state.acceptWebSocket(socket);
  const conn = String(room.nextConn);
  room.nextConn += 1;
  const attachment: RoomAttachment =
    role === "guest"
      ? { role, conn, login: GUEST_LOGIN, uid: GUEST_UID, ...extra }
      : { role, conn, ...extra };
  socket.serializeAttachment(attachment);
  return socket;
}

/** A room binding that records which room each socket was sent to. */
class FakeNamespace implements RoomNamespace {
  names: string[] = [];
  forwarded: Request[] = [];

  idFromName(name: string): unknown {
    this.names.push(name);
    return name;
  }

  get(id: unknown): RoomStub {
    void id;
    return {
      fetch: (request: Request): Promise<Response> => {
        this.forwarded.push(request);
        return Promise.resolve(new Response("forwarded"));
      },
    };
  }
}

async function guestRequest(guestOf: string | null, cookie?: string): Promise<Request> {
  const url = guestOf === null ? "/ws/device" : `/ws/device?guest_of=${guestOf}`;
  const headers = new Headers({ upgrade: "websocket" });
  const session = await signSession(GUEST_UID, GUEST_LOGIN, SECRET, Math.floor(Date.now() / 1000));
  headers.set("cookie", cookie ?? `cr_session=${session}`);
  return new Request(new URL(url, ORIGIN), { headers });
}

describe("GET /ws/device?guest_of", () => {
  function setupDoor(): { namespace: FakeNamespace; env: WsEnv } {
    const namespace = new FakeNamespace();
    return { namespace, env: { USER_ROOM: namespace, SESSION_SECRET: SECRET } };
  }

  it("forwards a guest to the owner's room with its own identity", async () => {
    const { namespace, env } = setupDoor();
    const response = await handleDeviceWs(await guestRequest(String(OWNER_UID)), env);
    expect(response.status).toBe(200);
    expect(namespace.names).toEqual([String(OWNER_UID)]);
    const forwarded = namespace.forwarded[0] as Request;
    expect(forwarded.headers.get("x-relay-role")).toBe("guest");
    expect(forwarded.headers.get("x-relay-login")).toBe(GUEST_LOGIN);
    expect(forwarded.headers.get("x-relay-uid")).toBe(String(GUEST_UID));
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
  });

  it("answers 401 without a session or with a forged one, even as a guest", async () => {
    const { namespace, env } = setupDoor();
    for (const cookie of ["other=1", "cr_session=forged.value"]) {
      const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), cookie), env);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(namespace.names).toEqual([]);
  });

  it("answers 400 for a malformed guest_of and never reaches a room", async () => {
    const { namespace, env } = setupDoor();
    for (const guestOf of ["0", "-7", "abc", "12x", "", " 42", "4.5"]) {
      const response = await handleDeviceWs(await guestRequest(guestOf), env);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_guest" });
    }
    expect(namespace.names).toEqual([]);
  });

  it("treats guest_of=self as a plain device in the own room", async () => {
    const { namespace, env } = setupDoor();
    const response = await handleDeviceWs(await guestRequest(String(GUEST_UID)), env);
    expect(response.status).toBe(200);
    expect(namespace.names).toEqual([String(GUEST_UID)]);
    const forwarded = namespace.forwarded[0] as Request;
    expect(forwarded.headers.get("x-relay-role")).toBe("device");
    expect(forwarded.headers.get("x-relay-login")).toBeNull();
    expect(forwarded.headers.get("x-relay-uid")).toBeNull();
  });
});

describe("guest fetch", () => {
  it("accepts a guest without any hosts frame", async () => {
    const { state, room } = setup();
    attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    const response = room.fetch(upgradeRequest("guest", guestHeaders()));
    expect(response.status).toBe(101);
    expect(state.getWebSockets()[1]?.deserializeAttachment()).toEqual({
      role: "guest",
      conn: "2",
      login: GUEST_LOGIN,
      uid: GUEST_UID,
    });
    const client = clientOf(response);
    client.accept();
    expect(await collectMessages(client)).toEqual([]);
  });

  it("answers 400 for a guest without an identity or with a bad uid", () => {
    const { room } = setup();
    expect(room.fetch(upgradeRequest("guest")).status).toBe(400);
    expect(room.fetch(upgradeRequest("guest", { "x-relay-login": GUEST_LOGIN })).status).toBe(400);
    expect(
      room.fetch(upgradeRequest("guest", { "x-relay-login": GUEST_LOGIN, "x-relay-uid": "0" })).status,
    ).toBe(400);
    expect(
      room.fetch(upgradeRequest("guest", { "x-relay-login": GUEST_LOGIN, "x-relay-uid": "abc" })).status,
    ).toBe(400);
  });

  it("announces each guest to the hosts with its GitHub identity", () => {
    const { state, room } = setup();
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    room.fetch(upgradeRequest("guest", guestHeaders()));
    expect(host.frames()).toEqual([
      {
        from: "relay",
        body: { t: "device_identity", conn: "2", role: "guest", login: GUEST_LOGIN, uid: GUEST_UID },
      },
    ]);
  });

  it("hands a (re)connected host the guests it must already authorize", async () => {
    const { state, room } = setup();
    attachFake(state, room, "guest");
    attachFake(state, room, "guest", { login: "second", uid: 333 });
    const host = clientOf(room.fetch(upgradeRequest("host", { "x-relay-host-id": HOST_ID })));
    host.accept();
    expect(JSON.parse(await nextMessage(host))).toEqual({
      from: "relay",
      body: { t: "device_identity", conn: "1", role: "guest", login: GUEST_LOGIN, uid: GUEST_UID },
    });
    expect(JSON.parse(await nextMessage(host))).toEqual({
      from: "relay",
      body: { t: "device_identity", conn: "2", role: "guest", login: "second", uid: 333 },
    });
  });

  it("keeps guests out of the hosts broadcasts", async () => {
    const { state, room } = setup();
    const guest = clientOf(room.fetch(upgradeRequest("guest", guestHeaders())));
    guest.accept();
    const device = clientOf(room.fetch(upgradeRequest("device")));
    device.accept();
    expect(JSON.parse(await nextMessage(device))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
    const seenDevice = nextMessage(device);
    const seenGuest = collectMessages(guest);
    room.fetch(upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": "devbox" }));
    expect(JSON.parse(await seenDevice)).toEqual({
      from: "relay",
      body: { t: "hosts", items: [{ host_id: HOST_ID, label: "devbox" }] },
    });
    expect(await seenGuest).toEqual([]);
    expect(state.getWebSockets()).toHaveLength(3);
  });

  it("refuses the 9th guest with code 4008, apart from the device cap", async () => {
    const { state, room } = setup();
    for (let index = 0; index < 8; index += 1) {
      attachFake(state, room, "device");
      attachFake(state, room, "guest");
    }
    const ninthGuest = clientOf(room.fetch(upgradeRequest("guest", guestHeaders())));
    ninthGuest.accept();
    expect(await nextClose(ninthGuest)).toBe(4008);
    const ninthDevice = clientOf(room.fetch(upgradeRequest("device")));
    ninthDevice.accept();
    expect(await nextClose(ninthDevice)).toBe(4008);
    // Mirror the runtime: it drops a closed, unattached socket before
    // calling webSocketClose, which then finds nothing to announce.
    for (const socket of state.getWebSockets()) {
      if (socket.deserializeAttachment() === null) {
        state.remove(socket);
        room.webSocketClose(socket);
      }
    }
    expect(state.getWebSockets()).toHaveLength(16);
  });

  it("announces device_left when a guest goes, on close and on error", () => {
    const { state, room } = setup();
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    const first = attachFake(state, room, "guest");
    const second = attachFake(state, room, "guest", { login: "second", uid: 333 });
    first.close(1000, "gone");
    room.webSocketClose(first);
    second.close(1006, "lost");
    room.webSocketError(second);
    expect(host.frames()).toEqual([
      {
        from: "relay",
        body: { t: "device_left", conn: "2", role: "guest", login: GUEST_LOGIN, uid: GUEST_UID },
      },
      {
        from: "relay",
        body: { t: "device_left", conn: "3", role: "guest", login: "second", uid: 333 },
      },
    ]);
  });
});

describe("guest routing", () => {
  it("delivers guest to host and host to guest with rewritten sources", () => {
    const { state, room } = setup();
    const guest = attachFake(state, room, "guest");
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    room.webSocketMessage(guest, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer", sdp: "v=0" } }));
    expect(host.frames()).toEqual([{ from: "d:1", body: { t: "offer", sdp: "v=0" } }]);
    room.webSocketMessage(host, JSON.stringify({ to: "d:1", body: { t: "answer", sdp: "v=0" } }));
    expect(guest.frames()).toEqual([{ from: `h:${HOST_ID}`, body: { t: "answer", sdp: "v=0" } }]);
  });

  it("bounces a guest's unknown host like a device's", () => {
    const { state, room } = setup();
    const guest = attachFake(state, room, "guest");
    room.webSocketMessage(guest, JSON.stringify({ to: "h:deadbeefdeadbeef", body: { t: "offer" } }));
    expect(guest.frames()).toEqual([{ from: "relay", body: { t: "error", code: "no_target" } }]);
  });

  it("answers a guest's pair_init with forbidden, outside the rate limit", () => {
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    const guest = attachFake(state, room, "guest");
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    for (let index = 0; index < 20; index += 1) {
      room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    }
    room.webSocketMessage(guest, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    // Forbidden, not rate_limited: the guest attempt never touched the quota.
    expect(guest.frames()).toEqual([{ from: "relay", body: { t: "error", code: "forbidden" } }]);
    expect(host.sent).toHaveLength(20);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    expect(device.frames()).toEqual([{ from: "relay", body: { t: "error", code: "rate_limited" } }]);
  });

  it("drops envelopes to the relay address instead of bouncing them", () => {
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    const guest = attachFake(state, room, "guest");
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    // What an old hub sends back for an unknown notice: it must die here,
    // or the bounce would loop between hub and relay forever.
    room.webSocketMessage(host, JSON.stringify({ to: "relay", body: { t: "error", reason: "unknown_type" } }));
    room.webSocketMessage(device, JSON.stringify({ to: "relay", body: { t: "offer" } }));
    room.webSocketMessage(guest, JSON.stringify({ to: "relay", body: { t: "offer" } }));
    expect(host.sent).toEqual([]);
    expect(device.sent).toEqual([]);
    expect(guest.sent).toEqual([]);
  });

  it("pins the exact identity notice bytes the hub matches", () => {
    const { state, room } = setup();
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    attachFake(state, room, "guest");
    room.fetch(upgradeRequest("guest", guestHeaders({ "x-relay-login": "pinned", "x-relay-uid": "7" })));
    expect(host.sent).toEqual([
      `{"from":"relay","body":{"t":"device_identity","conn":"3","role":"guest","login":"pinned","uid":7}}`,
    ]);
  });
});
