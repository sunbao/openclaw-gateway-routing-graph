import type { GatewayTraceEvent } from "./routing-types.ts";

export type ObserverHealth = {
  connected?: boolean;
  hello?: {
    server?: { version?: string; connId?: string };
  };
  source?: {
    gatewayUrl?: string;
  };
  lastError?: string | null;
};

export type ObserverStreamClientOptions = {
  url: string;
  onOpen?: (health: ObserverHealth) => void;
  onClose?: (info: { message: string }) => void;
  onEvent?: (evt: GatewayTraceEvent) => void;
};

function normalizeBaseUrl(raw: string): { baseUrl: string; streamUrl: string } {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/stream")) {
    return {
      baseUrl: trimmed.slice(0, -"/stream".length),
      streamUrl: trimmed,
    };
  }
  return {
    baseUrl: trimmed,
    streamUrl: `${trimmed}/stream`,
  };
}

export class ObserverStreamClient {
  private source: EventSource | null = null;
  private opened = false;
  private closed = false;
  private readonly baseUrl: string;
  private readonly streamUrl: string;

  constructor(private opts: ObserverStreamClientOptions) {
    const normalized = normalizeBaseUrl(opts.url);
    this.baseUrl = normalized.baseUrl;
    this.streamUrl = normalized.streamUrl;
  }

  get connected() {
    return this.opened;
  }

  async start() {
    this.closed = false;
    await this.bootstrap();
    this.connect();
  }

  stop() {
    this.closed = true;
    this.opened = false;
    this.source?.close();
    this.source = null;
  }

  async fetchHealth() {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`observer health request failed: HTTP ${response.status}`);
    }
    return (await response.json()) as ObserverHealth;
  }

  private async bootstrap() {
    const [healthResponse, eventsResponse] = await Promise.all([
      fetch(`${this.baseUrl}/health`),
      fetch(`${this.baseUrl}/events?limit=200`),
    ]);

    if (!healthResponse.ok) {
      throw new Error(`observer health request failed: HTTP ${healthResponse.status}`);
    }
    if (!eventsResponse.ok) {
      throw new Error(`observer events request failed: HTTP ${eventsResponse.status}`);
    }

    const health = (await healthResponse.json()) as ObserverHealth;
    const eventsPayload = (await eventsResponse.json()) as { events?: GatewayTraceEvent[] };
    for (const event of eventsPayload.events ?? []) {
      this.opts.onEvent?.(event);
    }
    this.opts.onOpen?.(health);
  }

  private connect() {
    if (this.closed) {
      return;
    }

    const source = new EventSource(this.streamUrl);
    this.source = source;

    source.addEventListener("open", async () => {
      this.opened = true;
      try {
        const health = await this.fetchHealth();
        this.opts.onOpen?.(health);
      } catch {
        this.opts.onOpen?.({});
      }
    });

    source.addEventListener("trace", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as GatewayTraceEvent;
        this.opts.onEvent?.(payload);
      } catch {
        // ignore malformed event payloads
      }
    });

    source.addEventListener("health", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as ObserverHealth;
        this.opts.onOpen?.(payload);
      } catch {
        // ignore malformed health payloads
      }
    });

    source.onerror = () => {
      this.opened = false;
      if (this.closed) {
        return;
      }
      this.opts.onClose?.({ message: "observer stream reconnecting" });
    };
  }
}
