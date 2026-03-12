import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { GatewayWsClient, type GatewayHelloOk } from "./gateway-client.ts";
import type { GatewayTraceEvent, RoutingFilters } from "./routing-types.ts";
import { traceEventsFromGatewayEvent } from "./routing-adapters.ts";
import {
  GRAPH_H,
  GRAPH_W,
  buildGraph,
  clamp,
  colorForEventKind,
  formatEdgeTitle,
  formatNodeTitle,
  formatRelativeTimestamp,
  shouldIncludeEvent,
  truncateLabel,
} from "./routing-graph.ts";

const STORAGE_GATEWAY_URL = "openclaw.routingGraph.gatewayUrl";
const STORAGE_TOKEN = "openclaw.routingGraph.token";
const STORAGE_PASSWORD = "openclaw.routingGraph.password";
const STORAGE_THEME = "openclaw.routingGraph.theme";

const EVENT_BUFFER_LIMIT = 500;
const EVENT_LIST_LIMIT = 60;
const SYNC_THROTTLE_MS = 80;

function readLocalStorage(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function readSessionStorage(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeSessionStorage(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function trimEvents(events: GatewayTraceEvent[]): GatewayTraceEvent[] {
  if (events.length <= EVENT_BUFFER_LIMIT) {
    return events;
  }
  return events.slice(0, EVENT_BUFFER_LIMIT);
}

export class RoutingGraphApp extends LitElement {
  static properties = {
    gatewayUrl: { state: true },
    token: { state: true },
    password: { state: true },
    connected: { state: true },
    paused: { state: true },
    theme: { state: true },
    scope: { state: true },
    sessionKey: { state: true },
    windowMs: { state: true },
    filters: { state: true },
    events: { state: true },
    hello: { state: true },
    lastError: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      padding: 20px;
      max-width: 1180px;
      margin: 0 auto;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.2px;
      color: var(--text-strong);
    }

    .sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, var(--card) 0%, var(--card-2) 100%);
      box-shadow: var(--shadow);
      padding: 14px 14px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    input,
    select {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--field-bg);
      color: var(--text);
      padding: 10px 10px;
      outline: none;
      min-width: 0;
    }

    input:focus,
    select:focus {
      border-color: rgba(96, 165, 250, 0.6);
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.12);
    }

    input[type="password"] {
      font-family: var(--mono);
      letter-spacing: 0.5px;
    }

    .btn {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--field-bg);
      color: var(--text-strong);
      padding: 10px 12px;
      font-weight: 800;
      cursor: pointer;
    }

    .btn.primary {
      background: rgba(96, 165, 250, 0.18);
      border-color: rgba(96, 165, 250, 0.35);
    }

    .btn.danger {
      background: rgba(251, 113, 133, 0.16);
      border-color: rgba(251, 113, 133, 0.35);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 12px;
      font-weight: 800;
    }

    .pill.ok {
      color: rgba(34, 197, 94, 0.9);
      border-color: rgba(34, 197, 94, 0.35);
      background: rgba(34, 197, 94, 0.12);
    }

    .pill.warn {
      color: rgba(251, 191, 36, 0.95);
      border-color: rgba(251, 191, 36, 0.35);
      background: rgba(251, 191, 36, 0.12);
    }

    .pill.danger {
      color: rgba(251, 113, 133, 0.95);
      border-color: rgba(251, 113, 133, 0.35);
      background: rgba(251, 113, 133, 0.12);
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 12px;
      align-items: center;
      margin-top: 12px;
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      border: 1px solid var(--border);
      background: var(--routing-other);
    }

    .swatch.rpc {
      background: var(--routing-rpc);
    }

    .swatch.message {
      background: var(--routing-message);
    }

    .swatch.tool {
      background: var(--routing-tool);
    }

    .graph {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      margin-top: 14px;
      background: linear-gradient(180deg, var(--card) 0%, var(--card-2) 100%);
    }

    svg {
      width: 100%;
      height: auto;
      display: block;
      color: var(--routing-other);
    }

    .routing-edge {
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .routing-node circle {
      fill: var(--routing-node-fill);
      stroke: var(--routing-node-stroke);
      stroke-width: 1.5;
    }

    .routing-node text {
      font-size: 12px;
      font-weight: 800;
      fill: var(--text-strong);
      paint-order: stroke;
      stroke: var(--text-outline);
      stroke-width: 3px;
      stroke-linejoin: round;
    }

    .events {
      margin-top: 12px;
      display: grid;
      gap: 8px;
    }

    .event-row {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 10px;
      background: var(--card-2);
      overflow-wrap: anywhere;
    }

    .event-top {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
    }

    .event-kind {
      font-weight: 900;
      color: var(--text-strong);
    }

    .event-age {
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }

    .event-body {
      margin-top: 6px;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text);
    }

    @media (max-width: 980px) {
      .grid {
        grid-template-columns: 1fr;
      }
    }
  `;

  private client: GatewayWsClient | null = null;
  private eventsBuffer: GatewayTraceEvent[] = [];
  private syncTimer: number | null = null;

  hello: GatewayHelloOk | null = null;
  lastError: string | null = null;
  gatewayUrl = (() => {
    const saved = readLocalStorage(STORAGE_GATEWAY_URL).trim();
    if (saved) return saved;

    const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname.toLowerCase();
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";

    if (isLoopback) {
      // Local gateway or SSH tunnel (recommended).
      return "ws://127.0.0.1:18789";
    }

    // When served from a remote host, many gateways reject cross-origin browser
    // WebSockets (403 -> client sees close 1006). Prefer a same-origin proxy if
    // available.
    return `${wsScheme}://${window.location.host}/__routing_graph/ws`;
  })();
  token = readSessionStorage(STORAGE_TOKEN) || "";
  password = readSessionStorage(STORAGE_PASSWORD) || "";
  connected = false;
  paused = false;
  theme: "light" | "dark" = (() => {
    const saved = readLocalStorage(STORAGE_THEME).trim();
    if (saved === "dark") return "dark";
    if (saved === "light") return "light";
    const attr = document.documentElement.dataset.theme;
    return attr === "dark" ? "dark" : "light";
  })();
  scope: "all" | "session" = "all";
  sessionKey = "";
  windowMs = 60_000;
  filters: RoutingFilters = { rpc: true, messages: true, tools: true };
  events: GatewayTraceEvent[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.applyTheme(this.theme);
  }

  private applyTheme(next: "light" | "dark") {
    this.theme = next;
    writeLocalStorage(STORAGE_THEME, next);
    try {
      document.documentElement.dataset.theme = next;
    } catch {
      // ignore
    }
  }

  private toggleTheme() {
    this.applyTheme(this.theme === "dark" ? "light" : "dark");
  }

  private flushSync() {
    if (this.syncTimer != null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.events = [...this.eventsBuffer];
  }

  private scheduleSync(force = false) {
    if (force) {
      this.flushSync();
      return;
    }
    if (this.syncTimer != null) {
      return;
    }
    this.syncTimer = window.setTimeout(() => this.flushSync(), SYNC_THROTTLE_MS);
  }

  private resetEvents() {
    if (this.syncTimer != null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.eventsBuffer = [];
    this.events = [];
  }

  private connect() {
    this.lastError = null;
    writeLocalStorage(STORAGE_GATEWAY_URL, this.gatewayUrl);
    writeSessionStorage(STORAGE_TOKEN, this.token);
    writeSessionStorage(STORAGE_PASSWORD, this.password);

    this.client?.stop();
    this.client = new GatewayWsClient({
      url: this.gatewayUrl,
      token: this.token || undefined,
      password: this.password || undefined,
      // `cli` is the most widely accepted client identity across gateway forks.
      clientId: "cli",
      clientMode: "cli",
      clientVersion: "routing-graph",
      displayName: "Routing Graph",
      onHello: (hello) => {
        this.connected = true;
        this.hello = hello;
        this.lastError = null;
        this.resetEvents();

        const ts = Date.now();
        const serverVersion = hello.server?.version || "";
        const role = hello.auth?.role || "";
        const scopeCount = hello.auth?.scopes?.length ?? 0;
        const eventCount = hello.features?.events?.length ?? 0;
        const methodCount = hello.features?.methods?.length ?? 0;

        const labelParts = [];
        if (serverVersion) labelParts.push(serverVersion);
        if (role) labelParts.push(role);
        if (scopeCount) labelParts.push(`${scopeCount} scopes`);
        if (eventCount) labelParts.push(`${eventCount} events`);

        this.eventsBuffer = trimEvents([
          {
            id: `viz_trace_hello_${ts}`,
            ts,
            kind: "rpc.connect",
            from: { kind: "client", id: "routing-graph", label: "routing-graph" },
            to: { kind: "gateway", id: "gateway", label: "gateway" },
            label: labelParts.join(" · ") || "hello-ok",
            data: {
              serverVersion: serverVersion || undefined,
              role: role || undefined,
              scopeCount,
              eventCount,
              methodCount,
            },
          },
          ...this.eventsBuffer,
        ]);
        this.scheduleSync(true);
      },
      onClose: ({ code, reason, error }) => {
        this.connected = false;
        this.hello = null;
        const suffix = error
          ? ` · ${error instanceof Error ? error.message : String(error)}`
          : "";
        this.lastError = `disconnected (${code}): ${reason || "no reason"}${suffix}`;
      },
      onGap: ({ expected, received }) => {
        this.lastError = `event gap detected (expected seq ${expected}, got ${received})`;
      },
      onEvent: (evt) => {
        if (this.paused) return;
        const next = traceEventsFromGatewayEvent(evt);
        if (next.length === 0) return;
        this.eventsBuffer = trimEvents([...next, ...this.eventsBuffer]);
        this.scheduleSync(false);
      },
    });
    this.client.start();
  }

  private disconnect() {
    this.client?.stop();
    this.client = null;
    this.connected = false;
    this.hello = null;
  }

  private filteredEvents() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const sessionKey = this.sessionKey.trim();
    const filtered = this.events
      .filter((evt) => {
        const ts = typeof evt.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : 0;
        if (ts < cutoff) return false;
        if (this.scope === "session" && sessionKey) {
          return evt.sessionKey === sessionKey;
        }
        return true;
      })
      .filter((evt) => shouldIncludeEvent(evt, this.filters))
      .sort((a, b) => b.ts - a.ts);
    return { now, cutoff, filtered };
  }

  private renderConnectionPill(): TemplateResult {
    if (this.connected) {
      const version = this.hello?.server?.version;
      return html`<span class="pill ok">Connected${version ? ` · ${version}` : ""}</span>`;
    }
    if (this.lastError) {
      return html`<span class="pill danger">Disconnected</span>`;
    }
    return html`<span class="pill warn">Idle</span>`;
  }

  private renderGraph() {
    const { now, filtered } = this.filteredEvents();
    const { nodes, edges, nodeByKey } = buildGraph(filtered, now);

    if (edges.length === 0) {
      return html`<div class="graph"><div style="padding: 16px; color: var(--muted);">No routing events in the current window.</div></div>`;
    }

    return html`
      <div class="graph">
        <svg viewBox="0 0 ${GRAPH_W} ${GRAPH_H}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker
              id="routingArrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"></path>
            </marker>
          </defs>

          ${edges.map((edge) => {
            const from = nodeByKey.get(edge.fromKey);
            const to = nodeByKey.get(edge.toKey);
            if (!from || !to) return nothing;
            const ageMs = now - edge.lastTs;
            const freshness = 1 - clamp(ageMs / this.windowMs, 0, 1);
            const opacity = 0.15 + freshness * 0.85;
            const width = 1 + Math.log10(edge.count + 1) * 2.5;
            const x1 = from.x;
            const y1 = from.y;
            const x2 = to.x;
            const y2 = to.y;
            const midX = (x1 + x2) / 2;
            const bend = clamp((x2 - x1) / 6, -60, 60);
            const cx1 = midX - bend;
            const cx2 = midX + bend;
            const d = `M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`;
            const color = colorForEventKind(edge.kind);
            return html`
              <path
                class="routing-edge"
                d=${d}
                stroke=${color}
                style=${`color: ${color};`}
                stroke-width=${width}
                stroke-opacity=${opacity}
                fill="none"
                marker-end="url(#routingArrow)"
              >
                <title>${formatEdgeTitle(edge, from, to)}</title>
              </path>
            `;
          })}

          ${nodes.map((node) => {
            const r = 10 + clamp(Math.log10(node.activity + 1) * 4, 0, 8);
            const textAnchor = node.x < GRAPH_W / 2 ? "start" : "end";
            const textX = node.x < GRAPH_W / 2 ? node.x + r + 8 : node.x - r - 8;
            return html`
              <g class="routing-node">
                <circle cx=${node.x} cy=${node.y} r=${r}>
                  <title>${formatNodeTitle(node)}</title>
                </circle>
                <text x=${textX} y=${node.y + 4} text-anchor=${textAnchor}>
                  ${truncateLabel(node.label)}
                </text>
              </g>
            `;
          })}
        </svg>
      </div>
    `;
  }

  private renderEventsList() {
    const { filtered } = this.filteredEvents();
    const rows = filtered.slice(0, EVENT_LIST_LIMIT);
    if (rows.length === 0) {
      return html`<div style="margin-top: 12px; color: var(--muted);">No events yet.</div>`;
    }

    const formatRow = (evt: GatewayTraceEvent) => {
      const from = evt.from?.label ?? evt.from?.id ?? "from";
      const to = evt.to?.label ?? evt.to?.id ?? "to";
      const label =
        typeof evt.label === "string" && evt.label.trim() ? ` — ${evt.label.trim()}` : "";
      return `${evt.kind} — ${from} → ${to}${label}`;
    };

    return html`
      <div class="events">
        ${rows.map(
          (evt) => html`
            <div class="event-row">
              <div class="event-top">
                <div class="event-kind">${evt.kind}</div>
                <div class="event-age">
                  ${new Date(evt.ts).toLocaleTimeString()} · ${formatRelativeTimestamp(evt.ts)}
                </div>
              </div>
              <div class="event-body">${formatRow(evt)}</div>
            </div>
          `,
        )}
      </div>
    `;
  }

  render() {
    const { filtered } = this.filteredEvents();
    const { nodes, edges } = buildGraph(filtered, Date.now());

    const windowOptions = [
      { label: "15s", ms: 15_000 },
      { label: "60s", ms: 60_000 },
      { label: "5m", ms: 5 * 60_000 },
    ];

    return html`
      <div class="header">
        <div>
          <div class="title">OpenClaw Routing Graph</div>
          <div class="sub">Live “routing map” for gateway trace + tool calls.</div>
        </div>
        <div class="row">
          <button class="btn" @click=${() => this.toggleTheme()}>
            Theme: ${this.theme === "dark" ? "Dark" : "Light"}
          </button>
          ${this.renderConnectionPill()}
          ${this.paused ? html`<span class="pill warn">Paused</span>` : nothing}
        </div>
      </div>

      <section class="card">
        <div class="grid" style="grid-template-columns: repeat(4, minmax(0, 1fr));">
          <label>
            Gateway URL
            <input
              .value=${this.gatewayUrl}
              @input=${(e: Event) => (this.gatewayUrl = (e.target as HTMLInputElement).value)}
              placeholder="ws://127.0.0.1:18789"
              spellcheck="false"
            />
          </label>

          <label>
            Token
            <input
              type="password"
              .value=${this.token}
              @input=${(e: Event) => (this.token = (e.target as HTMLInputElement).value)}
              placeholder="operator token (admin scope)"
              spellcheck="false"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              .value=${this.password}
              @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)}
              placeholder="gateway password (optional)"
              spellcheck="false"
            />
          </label>

          <div class="row" style="align-self: end; justify-content: flex-end;">
            ${
              this.connected
                ? html`<button class="btn danger" @click=${() => this.disconnect()}>
                    Disconnect
                  </button>`
                : html`<button class="btn primary" @click=${() => this.connect()}>Connect</button>`
            }
          </div>
        </div>

        ${
          this.lastError
            ? html`<div class="sub" style="margin-top: 10px; color: var(--danger);">
                ${this.lastError}
              </div>`
            : nothing
        }

        <div class="row" style="margin-top: 12px; justify-content: space-between;">
          <div class="sub">${filtered.length} events · ${nodes.length} nodes · ${edges.length} edges</div>
          <div class="row">
            <button class="btn" @click=${() => (this.paused = !this.paused)}>
              ${this.paused ? "Resume" : "Pause"}
            </button>
            <button class="btn danger" @click=${() => this.resetEvents()}>Clear</button>
          </div>
        </div>

        <div class="grid" style="margin-top: 14px;">
          <label>
            Scope
            <select
              .value=${this.scope}
              @change=${(e: Event) =>
                (this.scope = (e.target as HTMLSelectElement).value as "all" | "session")}
            >
              <option value="all">All sessions</option>
              <option value="session">Filter by sessionKey</option>
            </select>
          </label>

          <label>
            Session Key
            <input
              .value=${this.sessionKey}
              @input=${(e: Event) => (this.sessionKey = (e.target as HTMLInputElement).value)}
              placeholder="e.g. main"
              spellcheck="false"
            />
          </label>

          <label>
            Window
            <select
              .value=${String(this.windowMs)}
              @change=${(e: Event) => (this.windowMs = Number((e.target as HTMLSelectElement).value))}
            >
              ${windowOptions.map(
                (opt) => html`<option value=${String(opt.ms)}>${opt.label}</option>`,
              )}
            </select>
          </label>
        </div>

        <div class="row" style="margin-top: 12px; justify-content: space-between;">
          <div class="legend">
            <span class="legend-item"><span class="swatch rpc"></span>RPC</span>
            <span class="legend-item"><span class="swatch message"></span>Messages</span>
            <span class="legend-item"><span class="swatch tool"></span>Tools</span>
            <span class="legend-item"><span class="swatch"></span>Other</span>
          </div>
          <div class="row" style="gap: 10px;">
            <label class="row" style="gap: 8px; font-weight: 700; color: var(--muted);">
              <input
                type="checkbox"
                .checked=${this.filters.rpc}
                @change=${(e: Event) =>
                  (this.filters = {
                    ...this.filters,
                    rpc: (e.target as HTMLInputElement).checked,
                  })}
              />
              RPC
            </label>
            <label class="row" style="gap: 8px; font-weight: 700; color: var(--muted);">
              <input
                type="checkbox"
                .checked=${this.filters.messages}
                @change=${(e: Event) =>
                  (this.filters = {
                    ...this.filters,
                    messages: (e.target as HTMLInputElement).checked,
                  })}
              />
              Messages
            </label>
            <label class="row" style="gap: 8px; font-weight: 700; color: var(--muted);">
              <input
                type="checkbox"
                .checked=${this.filters.tools}
                @change=${(e: Event) =>
                  (this.filters = {
                    ...this.filters,
                    tools: (e.target as HTMLInputElement).checked,
                  })}
              />
              Tools
            </label>
          </div>
        </div>

        ${this.renderGraph()}
      </section>

      <section class="card" style="margin-top: 18px;">
        <div class="row" style="justify-content: space-between;">
          <div>
            <div class="title" style="font-size: 14px;">Latest Events</div>
            <div class="sub">Newest first (filtered).</div>
          </div>
        </div>
        ${this.renderEventsList()}
      </section>
    `;
  }
}

customElements.define("routing-graph-app", RoutingGraphApp);
