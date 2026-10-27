// SPDX-License-Identifier: Apache-2.0
// Relay WebSocket client: JSON envelopes {to, body} out, {from, body} in,
// over wss://<origin>/ws/device.

export interface RelayFrame {
  from: string;
  body: unknown;
}

export interface OnlineHost {
  host_id: string;
  label: string;
}

export type WebSocketFactory = (url: string) => WebSocket;

export function defaultRelayUrl(): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/ws/device`;
}

function parseFrame(data: unknown): RelayFrame | null {
  if (typeof data !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.from !== "string" || !("body" in record)) {
    return null;
  }
  return { from: record.from, body: record.body };
}

// The relay's {t:"hosts", items} notice listing online hosts.
export function parseHostsList(body: unknown): OnlineHost[] | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.t !== "hosts" || !Array.isArray(record.items)) {
    return null;
  }
  const items: OnlineHost[] = [];
  for (const item of record.items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row.host_id === "string" && typeof row.label === "string") {
      items.push({ host_id: row.host_id, label: row.label });
    }
  }
  return items;
}

export class RelaySocket {
  private ws: WebSocket | null = null;
  private pending: Promise<void> | null = null;
  private readonly frameHandlers = new Set<(frame: RelayFrame) => void>();
  private readonly closeHandlers = new Set<(ev: CloseEvent) => void>();

  constructor(
    private readonly url: string,
    private readonly createWs: WebSocketFactory = (openUrl) => new WebSocket(openUrl),
  ) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  onFrame(handler: (frame: RelayFrame) => void): () => void {
    this.frameHandlers.add(handler);
    return () => {
      this.frameHandlers.delete(handler);
    };
  }

  onClose(handler: (ev: CloseEvent) => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  // Idempotent: resolves at once when already open, joins a pending attempt.
  connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    if (this.pending) {
      return this.pending;
    }
    this.pending = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Could not reach the relay"));
        }
      };
      const ws = this.createWs(this.url);
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        resolve();
      };
      ws.onerror = () => fail();
      ws.onclose = (ev) => {
        if (this.ws === ws) {
          this.ws = null;
        }
        fail();
        for (const handler of this.closeHandlers) {
          handler(ev);
        }
      };
      ws.onmessage = (ev: MessageEvent) => {
        const frame = parseFrame(ev.data);
        if (frame) {
          for (const handler of this.frameHandlers) {
            handler(frame);
          }
        }
      };
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  send(to: string, body: unknown): void {
    if (!this.connected || !this.ws) {
      throw new Error("Relay is not connected");
    }
    this.ws.send(JSON.stringify({ to, body }));
  }

  trySend(to: string, body: unknown): boolean {
    try {
      this.send(to, body);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
