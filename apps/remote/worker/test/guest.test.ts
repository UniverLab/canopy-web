// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { signSession } from "../src/auth.js";
import { sha256Hex } from "../src/codec.js";
import type { RoomAttachment } from "../src/protocol.js";
import { UserRoom, newConnId } from "../src/room.js";
import { handleDeviceWs, type RoomNamespace, type RoomStub, type WsEnv } from "../src/ws.js";
import { FakeRoomState, FakeRoomSocket } from "./fakes.js";

const ORIGIN = "https://remote.univerlab.org";
const SECRET = "test-session-secret-that-is-long-enough";
const HOST_ID = "0123456789abcdef";
const OWNER_UID = 111;
const GUEST_UID = 222;
const GUEST_LOGIN = "guest-user";
const INVITE_CODE = "CNR-0123456789ABCDEF";
const INVITE_HASH_A = "a1".repeat(32);
const INVITE_HASH_B = "b2".repeat(32);
const FAR_FUTURE = 9999999999;

function upgradeRequest(role: string, extra: Record<string, string> = {}): Request {
  const headers = new Headers({ upgrade: "websocket", "x-relay-role": role, ...extra });
  return new Request("https://user-room/", { headers });
}

function guestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-relay-login": GUEST_LOGIN, "x-relay-uid": String(GUEST_UID), ...extra };
}

function inviteHeaders(hash: string, extra: Record<string, string> = {}): Record<string, string> {
  return guestHeaders({ "x-relay-invite-hash": hash, ...extra });
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

async function setup(): Promise<{ state: FakeRoomState; room: UserRoom }> {
  const state = new FakeRoomState();
  const room = new UserRoom(state);
  await room.ready;
  return { state, room };
}

/**
 * An accepted fake socket, with a fresh id like fetch assigns.
 * Guests carry the identity the door forwards.
 */
function attachFake(
  state: FakeRoomState,
  role: "device" | "host" | "guest",
  extra: { host_id?: string; label?: string; login?: string; uid?: number } = {},
): FakeRoomSocket {
  const socket = state.makeSocket();
  state.acceptWebSocket(socket);
  const conn = newConnId();
  const attachment: RoomAttachment =
    role === "guest"
      ? { role, conn, login: GUEST_LOGIN, uid: GUEST_UID, ...extra }
      : { role, conn, ...extra };
  socket.serializeAttachment(attachment);
  return socket;
}

/** The conn of an attached fake socket, failing the test when missing. */
function connOf(socket: FakeRoomSocket): string {
  const conn = socket.deserializeAttachment()?.conn;
  if (conn === undefined) {
    throw new Error("expected the socket to carry a conn");
  }
  return conn;
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

/** A room binding that runs the door's forward against a real room. */
class RoomBackedNamespace implements RoomNamespace {
  names: string[] = [];

  constructor(private readonly room: UserRoom) {}

  idFromName(name: string): unknown {
    this.names.push(name);
    return name;
  }

  get(id: unknown): RoomStub {
    void id;
    const room = this.room;
    return {
      fetch: (request: Request): Promise<Response> => Promise.resolve(room.fetch(request)),
    };
  }
}

async function guestRequest(guestOf: string | null, cookie?: string, invite?: string): Promise<Request> {
  let url = "/ws/device";
  if (guestOf !== null) {
    url = `/ws/device?guest_of=${guestOf}`;
    if (invite !== undefined) {
      url += `&invite=${encodeURIComponent(invite)}`;
    }
  }
  const headers = new Headers({ upgrade: "websocket", origin: ORIGIN });
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
    const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), undefined, INVITE_CODE), env);
    expect(response.status).toBe(200);
    expect(namespace.names).toEqual([String(OWNER_UID)]);
    const forwarded = namespace.forwarded[0] as Request;
    expect(forwarded.headers.get("x-relay-role")).toBe("guest");
    expect(forwarded.headers.get("x-relay-login")).toBe(GUEST_LOGIN);
    expect(forwarded.headers.get("x-relay-uid")).toBe(String(GUEST_UID));
    expect(forwarded.headers.get("x-relay-invite-hash")).toBe(await sha256Hex(INVITE_CODE));
    expect(forwarded.headers.get("cookie")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
  });

  it("answers 403 without an invite and never reaches a room", async () => {
    const { namespace, env } = setupDoor();
    for (const invite of [undefined, ""]) {
      const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), undefined, invite), env);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "bad_invite" });
    }
    expect(namespace.names).toEqual([]);
  });

  it("answers 401 without a session or with a forged one, even as a guest", async () => {
    const { namespace, env } = setupDoor();
    for (const cookie of ["other=1", "cr_session=forged.value"]) {
      const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), cookie, INVITE_CODE), env);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(namespace.names).toEqual([]);
  });

  it("answers 400 for a malformed guest_of and never reaches a room", async () => {
    const { namespace, env } = setupDoor();
    // 9007199254740993 is 2^53 + 1: well-formed digits that lose
    // precision in a Number, so they must fail closed, not land elsewhere.
    for (const guestOf of ["0", "-7", "abc", "12x", "", " 42", "4.5", "9007199254740993"]) {
      const response = await handleDeviceWs(await guestRequest(guestOf, undefined, INVITE_CODE), env);
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
    expect(forwarded.headers.get("x-relay-login")).toBe(GUEST_LOGIN);
    expect(forwarded.headers.get("x-relay-uid")).toBe(String(GUEST_UID));
  });
});

describe("guest fetch", () => {
  it("accepts a guest without any hosts frame", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const response = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(response.status).toBe(101);
    const attachment = state.getWebSockets()[1]?.deserializeAttachment();
    expect(attachment?.role).toBe("guest");
    expect(attachment?.conn).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(attachment?.login).toBe(GUEST_LOGIN);
    expect(attachment?.uid).toBe(GUEST_UID);
    const client = clientOf(response);
    client.accept();
    expect(await collectMessages(client)).toEqual([]);
  });

  it("answers 400 for a guest without an identity or with a bad uid", async () => {
    const { room } = await setup();
    expect(room.fetch(upgradeRequest("guest")).status).toBe(400);
    expect(room.fetch(upgradeRequest("guest", { "x-relay-login": GUEST_LOGIN })).status).toBe(400);
    expect(
      room.fetch(upgradeRequest("guest", { "x-relay-login": "", "x-relay-uid": String(GUEST_UID) })).status,
    ).toBe(400);
    expect(
      room.fetch(upgradeRequest("guest", { "x-relay-login": GUEST_LOGIN, "x-relay-uid": "0" })).status,
    ).toBe(400);
    expect(
      room.fetch(upgradeRequest("guest", { "x-relay-login": GUEST_LOGIN, "x-relay-uid": "abc" })).status,
    ).toBe(400);
  });

  it("announces each guest to the hosts with its GitHub identity", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    const guestConn = state.getWebSockets()[1]?.deserializeAttachment()?.conn;
    expect(host.frames()).toEqual([
      {
        from: "relay",
        body: { t: "device_identity", conn: guestConn, role: "guest", login: GUEST_LOGIN, uid: GUEST_UID },
      },
    ]);
  });

  it("hands a (re)connected host the guests it must already authorize", async () => {
    const { state, room } = await setup();
    const first = attachFake(state, "guest");
    const second = attachFake(state, "guest", { login: "second", uid: 333 });
    const host = clientOf(room.fetch(upgradeRequest("host", { "x-relay-host-id": HOST_ID })));
    host.accept();
    expect(JSON.parse(await nextMessage(host))).toEqual({
      from: "relay",
      body: { t: "device_identity", conn: connOf(first), role: "guest", login: GUEST_LOGIN, uid: GUEST_UID },
    });
    expect(JSON.parse(await nextMessage(host))).toEqual({
      from: "relay",
      body: { t: "device_identity", conn: connOf(second), role: "guest", login: "second", uid: 333 },
    });
  });

  it("keeps guests out of the hosts broadcasts", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    const guest = clientOf(room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A))));
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

  it("refuses the 9th guest with 429, apart from the device cap", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    for (let index = 0; index < 8; index += 1) {
      attachFake(state, "device");
      attachFake(state, "guest", { login: `guest-${index}`, uid: 1000 + index });
    }
    const started = Date.now();
    const ninthGuest = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ninthGuest.status).toBe(429);
    expect(await ninthGuest.json()).toEqual({ error: "too_many_guests" });
    expect((ninthGuest as unknown as { webSocket?: unknown }).webSocket ?? null).toBeNull();
    const ninthDevice = room.fetch(upgradeRequest("device"));
    expect(ninthDevice.status).toBe(429);
    expect(await ninthDevice.json()).toEqual({ error: "too_many_devices" });
    expect(state.getWebSockets()).toHaveLength(16);
  });

  it("announces device_left when a guest goes, on close and on error", async () => {
    const { state, room } = await setup();
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const first = attachFake(state, "guest");
    const second = attachFake(state, "guest", { login: "second", uid: 333 });
    first.close(1000, "gone");
    room.webSocketClose(first);
    second.close(1006, "lost");
    room.webSocketError(second);
    expect(host.frames()).toEqual([
      {
        from: "relay",
        body: { t: "device_left", conn: connOf(first), role: "guest", login: GUEST_LOGIN, uid: GUEST_UID },
      },
      {
        from: "relay",
        body: { t: "device_left", conn: connOf(second), role: "guest", login: "second", uid: 333 },
      },
    ]);
  });
});

describe("guest routing", () => {
  it("delivers guest to host and host to guest with rewritten sources", async () => {
    const { state, room } = await setup();
    const guest = attachFake(state, "guest");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const guestConn = connOf(guest);
    room.webSocketMessage(guest, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer", sdp: "v=0" } }));
    expect(host.frames()).toEqual([
      { from: `d:${guestConn}`, login: GUEST_LOGIN, uid: GUEST_UID, body: { t: "offer", sdp: "v=0" } },
    ]);
    room.webSocketMessage(host, JSON.stringify({ to: `d:${guestConn}`, body: { t: "answer", sdp: "v=0" } }));
    expect(guest.frames()).toEqual([{ from: `h:${HOST_ID}`, body: { t: "answer", sdp: "v=0" } }]);
  });

  it("bounces a guest's unknown host like a device's", async () => {
    const { state, room } = await setup();
    const guest = attachFake(state, "guest");
    room.webSocketMessage(guest, JSON.stringify({ to: "h:deadbeefdeadbeef", body: { t: "offer" } }));
    expect(guest.frames()).toEqual([{ from: "relay", body: { t: "error", code: "no_target" } }]);
  });

  it("answers a guest's pair_init with forbidden, outside the rate limit", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const guest = attachFake(state, "guest");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
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

  it("drops envelopes to the relay address instead of bouncing them", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const guest = attachFake(state, "guest");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    // What an old hub sends back for an unknown notice: it must die here,
    // or the bounce would loop between hub and relay forever.
    room.webSocketMessage(host, JSON.stringify({ to: "relay", body: { t: "error", reason: "unknown_type" } }));
    room.webSocketMessage(device, JSON.stringify({ to: "relay", body: { t: "offer" } }));
    room.webSocketMessage(guest, JSON.stringify({ to: "relay", body: { t: "offer" } }));
    expect(host.sent).toEqual([]);
    expect(device.sent).toEqual([]);
    expect(guest.sent).toEqual([]);
  });

  it("pins the exact identity notice bytes the hub matches", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: 7, expires: FAR_FUTURE }];
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    attachFake(state, "guest");
    room.fetch(
      upgradeRequest("guest", inviteHeaders(INVITE_HASH_A, { "x-relay-login": "pinned", "x-relay-uid": "7" })),
    );
    const pinnedConn = state.getWebSockets()[2]?.deserializeAttachment()?.conn;
    expect(host.sent).toEqual([
      `{"from":"relay","body":{"t":"device_identity","conn":"${pinnedConn}","role":"guest","login":"pinned","uid":7}}`,
    ]);
  });
});

describe("guest allowlist", () => {
  it("refuses an unlisted guest with 403, before the upgrade", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_B, uid: 999, expires: FAR_FUTURE }];
    const refused = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "bad_invite" });
    expect((refused as unknown as { webSocket?: unknown }).webSocket ?? null).toBeNull();
    expect(state.getWebSockets()).toHaveLength(0);
  });

  it("denies every guest on an empty list", async () => {
    const { room } = await setup();
    room.guestInvites = [];
    const refused = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "bad_invite" });
  });

  it("denies every guest when no host ever sent a list", async () => {
    const { room } = await setup();
    const refused = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "bad_invite" });
  });

  it("passes a listed guest with 101", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    const response = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(response.status).toBe(101);
    expect(state.getWebSockets()).toHaveLength(1);
  });

  it("admits through the real frame a host fake sends", async () => {
    const { state, room } = await setup();
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    room.webSocketMessage(
      host,
      JSON.stringify({
        to: "room",
        body: {
          t: "guest_allow",
          uids: [GUEST_UID],
          invites: [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }],
        },
      }),
    );
    const response = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(response.status).toBe(101);
    expect(state.getWebSockets()).toHaveLength(2);
  });
});

describe("guest_allow management", () => {
  it("sets the list silently: no ack frame, nothing routed", async () => {
    const { state, room } = await setup();
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const device = attachFake(state, "device");
    room.webSocketMessage(host, JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [7, 7, 222] } }));
    expect(room.guestAllow).toEqual([7, 222]);
    expect(room.guestInvites).toEqual([]);
    expect(host.sent).toEqual([]);
    expect(device.sent).toEqual([]);
  });

  it("pruned_guest_kicked_with_4003", async () => {
    const { state, room } = await setup();
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    room.webSocketMessage(host, JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [GUEST_UID] } }));
    const guest = attachFake(state, "guest");
    const guestConn = connOf(guest);
    room.webSocketMessage(host, JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [] } }));
    expect(room.guestAllow).toEqual([]);
    expect(guest.closed).toEqual([{ code: 4003, reason: "not_invited" }]);
    expect(state.getWebSockets()).not.toContain(guest);
    // Mirror the runtime: the closed socket leaves before its close lands,
    // and the normal close path announces it to the hosts.
    room.webSocketClose(guest, 4003, "not_invited");
    expect(host.frames()).toEqual([
      {
        from: "relay",
        body: { t: "device_left", conn: guestConn, role: "guest", login: GUEST_LOGIN, uid: GUEST_UID },
      },
    ]);
  });

  it("listed_guest_survives_republish", async () => {
    const { state, room } = await setup();
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const device = attachFake(state, "device");
    room.webSocketMessage(host, JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [GUEST_UID] } }));
    const guest = attachFake(state, "guest");
    room.webSocketMessage(host, JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [GUEST_UID] } }));
    expect(room.guestAllow).toEqual([GUEST_UID]);
    expect(guest.closed).toEqual([]);
    expect(device.closed).toEqual([]);
    expect(state.getWebSockets()).toContain(guest);
    expect(host.sent).toEqual([]);
  });

  it("bounces malformed bodies with bad_frame and keeps the old list", async () => {
    const { state, room } = await setup();
    room.guestAllow = [GUEST_UID];
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const guest = attachFake(state, "guest");
    const malformed: unknown[] = [
      { t: "guest_allow" },
      { uids: [GUEST_UID] },
      { t: "guest_allow", uids: [GUEST_UID], extra: true },
      { t: "guest_allow", uids: GUEST_UID },
      { t: "guest_allow", uids: [0] },
      { t: "guest_allow", uids: [-3] },
      { t: "guest_allow", uids: ["222"] },
      { t: "guest_allow", uids: [1.5] },
      { t: "guest_allow", uids: [Number.MAX_SAFE_INTEGER + 1] },
      { t: "guest_allow", uids: null },
      { t: "guest_allow", uids: [GUEST_UID], invites: "not-an-array" },
      { t: "guest_allow", uids: [GUEST_UID], invites: [{ code_hash: "short", uid: GUEST_UID, expires: FAR_FUTURE }] },
      { t: "guest_allow", uids: [GUEST_UID], invites: [{ code_hash: INVITE_HASH_A, uid: 0, expires: FAR_FUTURE }] },
      { t: "guest_allow", uids: [GUEST_UID], invites: [{ code_hash: INVITE_HASH_A, uid: GUEST_UID }] },
      {
        t: "guest_allow",
        uids: [GUEST_UID],
        invites: [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE, extra: 1 }],
      },
      { t: "other", uids: [GUEST_UID] },
      "guest_allow",
      null,
      [GUEST_UID],
    ];
    for (const body of malformed) {
      room.webSocketMessage(host, JSON.stringify({ to: "room", body }));
    }
    expect(room.guestAllow).toEqual([GUEST_UID]);
    expect(room.guestInvites).toEqual([{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }]);
    const error = { from: "relay", body: { t: "error", code: "bad_frame" } };
    expect(host.frames()).toEqual(Array(malformed.length).fill(error));
    // A rejected list is not a new list: nobody is pruned.
    expect(guest.closed).toEqual([]);
    expect(state.getWebSockets()).toContain(guest);
  });

  it("answers a non-host sender with forbidden", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const guest = attachFake(state, "guest");
    const frame = JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [GUEST_UID] } });
    room.webSocketMessage(device, frame);
    room.webSocketMessage(guest, frame);
    expect(device.frames()).toEqual([{ from: "relay", body: { t: "error", code: "forbidden" } }]);
    expect(guest.frames()).toEqual([{ from: "relay", body: { t: "error", code: "forbidden" } }]);
    expect(room.guestAllow).toEqual([]);
    // A bounced sender prunes nobody: both sockets stay open.
    expect(device.closed).toEqual([]);
    expect(guest.closed).toEqual([]);
  });

  it("old_guest_allow_without_invites_tolerated", async () => {
    const { state, room } = await setup();
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    room.webSocketMessage(host, JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [GUEST_UID] } }));
    expect(room.guestAllow).toEqual([GUEST_UID]);
    expect(room.guestInvites).toEqual([]);
    expect(host.sent).toEqual([]);
    const refused = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "bad_invite" });
  });
});

describe("guest duplicate", () => {
  it("refuses the newest duplicate login with 409 and keeps the first", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    const first = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(first.status).toBe(101);
    const duplicate = room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A)));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "guest_duplicate" });
    expect((duplicate as unknown as { webSocket?: unknown }).webSocket ?? null).toBeNull();
    expect(state.getWebSockets()).toHaveLength(1);
  });

  it("admits a second guest under another login", async () => {
    const { state, room } = await setup();
    room.guestInvites = [
      { code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE },
      { code_hash: INVITE_HASH_B, uid: 333, expires: FAR_FUTURE },
    ];
    expect(room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A))).status).toBe(101);
    const second = room.fetch(
      upgradeRequest("guest", inviteHeaders(INVITE_HASH_B, { "x-relay-login": "second", "x-relay-uid": "333" })),
    );
    expect(second.status).toBe(101);
    expect(state.getWebSockets()).toHaveLength(2);
  });

  it("frees the login once the first socket leaves", async () => {
    const { state, room } = await setup();
    room.guestInvites = [{ code_hash: INVITE_HASH_A, uid: GUEST_UID, expires: FAR_FUTURE }];
    expect(room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A))).status).toBe(101);
    const first = state.getWebSockets()[0];
    if (first === undefined) {
      throw new Error("expected the guest socket to be attached");
    }
    // The runtime drops a closed socket before calling webSocketClose.
    first.close(1000, "gone");
    state.remove(first);
    room.webSocketClose(first);
    expect(room.fetch(upgradeRequest("guest", inviteHeaders(INVITE_HASH_A))).status).toBe(101);
    expect(state.getWebSockets()).toHaveLength(1);
  });
});

describe("forwarded identity", () => {
  it("injected_identity_overwrites_spoofed_body", async () => {
    const { state, room } = await setup();
    const guest = attachFake(state, "guest");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const guestConn = connOf(guest);
    room.webSocketMessage(
      guest,
      JSON.stringify({
        to: `h:${HOST_ID}`,
        login: "spoofed-login",
        uid: 999,
        body: { t: "offer", sdp: "v=0", login: "spoofed-login", uid: 999 },
      }),
    );
    expect(host.sent).toHaveLength(1);
    const forwarded = JSON.parse(host.sent[0] as string) as {
      from: string;
      login: string;
      uid: number;
      body: unknown;
    };
    expect(forwarded.from).toBe(`d:${guestConn}`);
    expect(forwarded.login).toBe(GUEST_LOGIN);
    expect(forwarded.uid).toBe(GUEST_UID);
    expect(forwarded.body).toEqual({ t: "offer", sdp: "v=0", login: "spoofed-login", uid: 999 });
    expect(forwarded.login).not.toBe("spoofed-login");
    expect(forwarded.uid).not.toBe(999);
    expect(host.sent[0]).toBe(
      `{"from":"d:${guestConn}","login":"${GUEST_LOGIN}","uid":${GUEST_UID},` +
        `"body":{"t":"offer","sdp":"v=0","login":"spoofed-login","uid":999}}`,
    );
  });
});

describe("invite door", () => {
  const UNKNOWN_CODE = "CNR-FFFFFFFFFFFFFFFF";

  async function roomWithInvites(invites: Array<{ code_hash: string; uid: number; expires: number }>): Promise<{
    state: FakeRoomState;
    room: UserRoom;
  }> {
    const { state, room } = await setup();
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    room.webSocketMessage(
      host,
      JSON.stringify({ to: "room", body: { t: "guest_allow", uids: [GUEST_UID], invites } }),
    );
    return { state, room };
  }

  it("invite_door_accepts_valid", async () => {
    const hash = await sha256Hex(INVITE_CODE);
    const nowSec = Math.floor(Date.now() / 1000);
    const { room } = await roomWithInvites([{ code_hash: hash, uid: GUEST_UID, expires: nowSec + 3600 }]);
    const namespace = new RoomBackedNamespace(room);
    const env: WsEnv = { USER_ROOM: namespace, SESSION_SECRET: SECRET };
    const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), undefined, INVITE_CODE), env);
    expect(response.status).toBe(101);
    expect(namespace.names).toEqual([String(OWNER_UID)]);
  });

  it("invite_door_rejects_unknown_code", async () => {
    const hash = await sha256Hex(INVITE_CODE);
    const nowSec = Math.floor(Date.now() / 1000);
    const { state, room } = await roomWithInvites([{ code_hash: hash, uid: GUEST_UID, expires: nowSec + 3600 }]);
    const namespace = new RoomBackedNamespace(room);
    const env: WsEnv = { USER_ROOM: namespace, SESSION_SECRET: SECRET };
    const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), undefined, UNKNOWN_CODE), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad_invite" });
    expect(state.getWebSockets()).toHaveLength(1);
  });

  it("invite_door_rejects_expired", async () => {
    const hash = await sha256Hex(INVITE_CODE);
    const nowSec = Math.floor(Date.now() / 1000);
    const { room } = await roomWithInvites([{ code_hash: hash, uid: GUEST_UID, expires: nowSec - 10 }]);
    const namespace = new RoomBackedNamespace(room);
    const env: WsEnv = { USER_ROOM: namespace, SESSION_SECRET: SECRET };
    const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), undefined, INVITE_CODE), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad_invite" });
  });

  it("invite_door_rejects_uid_mismatch", async () => {
    const hash = await sha256Hex(INVITE_CODE);
    const nowSec = Math.floor(Date.now() / 1000);
    const { room } = await roomWithInvites([{ code_hash: hash, uid: 999, expires: nowSec + 3600 }]);
    const namespace = new RoomBackedNamespace(room);
    const env: WsEnv = { USER_ROOM: namespace, SESSION_SECRET: SECRET };
    const response = await handleDeviceWs(await guestRequest(String(OWNER_UID), undefined, INVITE_CODE), env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "bad_invite" });
  });
});
