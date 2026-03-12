export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type GatewayHelloOk = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features?: { methods: string[]; events: string[] };
  auth?: { role: string; scopes: string[] };
  snapshot?: unknown;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

export type GatewayWsClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientId?: string;
  clientMode?: string;
  clientVersion?: string;
  instanceId?: string;
  displayName?: string;
  onHello?: (hello: GatewayHelloOk) => void;
  onClose?: (info: { code: number; reason: string; error?: unknown }) => void;
  onEvent?: (evt: GatewayEventFrame) => void;
  onGap?: (info: { expected: number; received: number }) => void;
};

function generateUUID(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  }
}

export class GatewayWsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private lastSeq: number | null = null;
  private backoffMs = 800;
  private pendingConnectError: unknown;
  private connectSent = false;
  private connectChallengeTimer: number | null = null;
  private connectResponseTimer: number | null = null;

  constructor(private opts: GatewayWsClientOptions) {}

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    if (this.connectChallengeTimer != null) {
      clearTimeout(this.connectChallengeTimer);
      this.connectChallengeTimer = null;
    }
    if (this.connectResponseTimer != null) {
      clearTimeout(this.connectResponseTimer);
      this.connectResponseTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connect() {
    if (this.closed) {
      return;
    }
    this.ws = new WebSocket(this.opts.url);
    this.ws.addEventListener("open", () => this.queueConnect());
    this.ws.addEventListener("message", (ev) => this.handleMessage(String(ev.data ?? "")));
    this.ws.addEventListener("close", (ev) => {
      const reason = String(ev.reason ?? "");
      const connectError = this.pendingConnectError;
      this.pendingConnectError = undefined;
      this.ws = null;
      this.connectSent = false;
      if (this.connectChallengeTimer != null) {
        clearTimeout(this.connectChallengeTimer);
        this.connectChallengeTimer = null;
      }
      if (this.connectResponseTimer != null) {
        clearTimeout(this.connectResponseTimer);
        this.connectResponseTimer = null;
      }
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason, error: connectError });
      this.scheduleReconnect();
    });
    this.ws.addEventListener("error", () => {
      // ignored; close handler will fire
    });
  }

  private scheduleReconnect() {
    if (this.closed) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000);
    window.setTimeout(() => this.connect(), delay);
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private queueConnect() {
    this.connectSent = false;
    if (this.connectChallengeTimer != null) {
      clearTimeout(this.connectChallengeTimer);
    }
    if (this.connectResponseTimer != null) {
      clearTimeout(this.connectResponseTimer);
      this.connectResponseTimer = null;
    }

    // Some gateways send `connect.challenge` immediately on open and expect
    // clients to wait. For compatibility with older forks, fall back to
    // sending connect after a short delay if no challenge arrives.
    this.connectChallengeTimer = window.setTimeout(() => this.sendConnect(), 250);
  }

  private sendConnect() {
    if (this.connectSent) {
      return;
    }
    this.connectSent = true;
    if (this.connectChallengeTimer != null) {
      clearTimeout(this.connectChallengeTimer);
      this.connectChallengeTimer = null;
    }
    if (this.connectResponseTimer != null) {
      clearTimeout(this.connectResponseTimer);
    }
    this.connectResponseTimer = window.setTimeout(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      this.pendingConnectError = new Error("gateway connect timeout");
      this.ws.close(1008, "connect timeout");
    }, 8000);

    // Keep scopes minimal. Some gateway forks validate scope names and will
    // reject unknown scopes during connect.
    const scopes = ["operator.admin"];
    const role = "operator";
    const token = this.opts.token?.trim() || undefined;
    const password = this.opts.password?.trim() || undefined;
    const auth =
      token || password
        ? {
            token,
            password,
          }
        : undefined;

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: (this.opts.clientId ?? "cli").trim(),
        displayName: this.opts.displayName?.trim() || undefined,
        version: (this.opts.clientVersion ?? "routing-graph").trim(),
        platform: navigator.platform || "web",
        mode: (this.opts.clientMode ?? "cli").trim(),
        instanceId: this.opts.instanceId?.trim() || undefined,
      },
      role,
      scopes,
      caps: ["tool-events"],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    const CONNECT_FAILED_CLOSE_CODE = 4008;
    void this.request<GatewayHelloOk>("connect", params)
      .then((hello) => {
        this.backoffMs = 800;
        this.pendingConnectError = undefined;
        if (this.connectResponseTimer != null) {
          clearTimeout(this.connectResponseTimer);
          this.connectResponseTimer = null;
        }
        this.opts.onHello?.(hello);
      })
      .catch((err: unknown) => {
        this.pendingConnectError = err;
        if (this.connectResponseTimer != null) {
          clearTimeout(this.connectResponseTimer);
          this.connectResponseTimer = null;
        }
        this.ws?.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
      });
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: unknown };
    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      if (evt.event === "connect.challenge") {
        // Prefer waiting for the server-side challenge before sending connect.
        // We do not currently use the nonce (device identity signing), but
        // sending connect after this event improves compatibility.
        if (!this.connectSent) {
          this.sendConnect();
        }
      }
      const seq = typeof evt.seq === "number" ? evt.seq : null;
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
        }
        this.lastSeq = seq;
      }
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[routing-graph] gateway event handler error:", err);
      }
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(new Error(res.error?.message ?? "request failed"));
      }
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = generateUUID();
    const frame = { type: "req", id, method, params };
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }
}
