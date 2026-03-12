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
const STORAGE_AUTO_HEALTH = "openclaw.routingGraph.autoHealth";
const STORAGE_LIST_LIMIT = "openclaw.routingGraph.listLimit";

const EVENT_BUFFER_LIMIT = 2000;
const DEFAULT_EVENT_LIST_LIMIT = 200;
const SYNC_THROTTLE_MS = 80;
const AUTO_HEALTH_INTERVAL_MS = 5_000;

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

function safeJson(value: unknown, maxChars = 2400): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? "";
    if (raw.length <= maxChars) {
      return raw;
    }
    return `${raw.slice(0, maxChars)}\n…(truncated)`;
  } catch {
    return String(value);
  }
}

function normalizeErrorMessage(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  return String(err);
}

function describeDisconnect(info: {
  code: number;
  reason: string;
  error?: unknown;
}): { summary: string; raw: string } {
  const reason = info.reason || "no reason";
  const errorMsg = normalizeErrorMessage(info.error);
  const raw = `disconnected (${info.code}): ${reason}${errorMsg ? ` · ${errorMsg}` : ""}`;

  const reasonLower = reason.toLowerCase();

  // Friendly summary first; technical details are shown separately.
  if (info.code === 1006) {
    return {
      summary:
        "连接失败：浏览器 WebSocket 握手被中断（常见原因：跨域 Origin 被拒绝 / 网关未暴露 WS）。建议使用同源 WS proxy（/__routing_graph/ws）。",
      raw,
    };
  }

  if (info.code === 1011) {
    if (reasonLower.includes("unexpected server response")) {
      return {
        summary:
          "连接失败：上游返回的不是 WebSocket（可能是 HTTP 页面/反向代理/URL 写错）。请检查 GATEWAY_URL 是否指向网关 WS 地址。",
        raw,
      };
    }
    if (reasonLower.includes("rejected websocket upgrade") || reasonLower.includes("http ")) {
      return {
        summary:
          "连接失败：网关拒绝 WebSocket 握手（HTTP 非 101）。常见原因：URL 写错、反向代理未透传 Upgrade、鉴权/Origin 校验失败。",
        raw,
      };
    }
    if (reasonLower.includes("econnrefused")) {
      return {
        summary:
          "连接失败：网关拒绝连接（ECONNREFUSED）。请确认网关进程运行、端口可达、未被防火墙拦截。",
        raw,
      };
    }
    if (reasonLower.includes("enotfound")) {
      return {
        summary: "连接失败：无法解析网关地址（ENOTFOUND）。请检查域名/DNS 或 GATEWAY_URL。",
        raw,
      };
    }
    if (reasonLower.includes("timed out") || reasonLower.includes("etimedout")) {
      return {
        summary: "连接失败：连接网关超时。请检查网关地址、网络连通性，或稍后重试。",
        raw,
      };
    }
    if (reasonLower.includes("upstream")) {
      return {
        summary:
          "连接失败：无法连接到上游网关（upstream error）。请检查 GATEWAY_URL / 网关端口 / 网络。",
        raw,
      };
    }
    return {
      summary: "连接失败：网关上游异常（1011）。请检查后端日志（WS proxy / 网关服务）。",
      raw,
    };
  }

  if (info.code === 1008) {
    if (reasonLower.includes("pairing required")) {
      return {
        summary:
          "连接失败：网关要求设备配对（pairing required）。请先在 Control UI 完成 device pairing 或使用有效的 operator token。",
        raw,
      };
    }
    if (reasonLower.includes("device identity required")) {
      return {
        summary:
          "连接失败：网关要求设备身份（device identity required）。请使用 operator token（role=operator）或先完成设备配对后再连接。",
        raw,
      };
    }
  }

  if (info.code === 4008 || reasonLower.includes("connect failed")) {
    return {
      summary:
        "连接失败：网关 connect 握手失败。请检查 Token/Password 是否正确、权限 scopes 是否足够。",
      raw,
    };
  }

  return { summary: `连接已断开（${info.code}）`, raw };
}

function truncateText(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function readDataString(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v.trim() : "";
}

function readDataNumber(data: Record<string, unknown>, key: string): number | null {
  const v = data[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function formatEventSummary(evt: GatewayTraceEvent): string | null {
  const data = evt.data ?? {};
  const kind = String(evt.kind || "");

  if (kind === "rpc.connect") {
    const serverVersion = readDataString(data, "serverVersion");
    const role = readDataString(data, "role");
    const scopeCount = readDataNumber(data, "scopeCount");
    const eventCount = readDataNumber(data, "eventCount");
    const methodCount = readDataNumber(data, "methodCount");

    const parts = [];
    if (serverVersion) parts.push(`server=${serverVersion}`);
    if (role) parts.push(`role=${role}`);
    if (scopeCount !== null) parts.push(`scopes=${scopeCount}`);
    if (eventCount !== null) parts.push(`events=${eventCount}`);
    if (methodCount !== null) parts.push(`methods=${methodCount}`);
    return parts.length ? truncateText(parts.join(" · ")) : null;
  }

  if (kind === "rpc.health") {
    const channelCount = readDataNumber(data, "channelCount");
    const sessionCount = readDataNumber(data, "sessionCount");
    const agentCount = readDataNumber(data, "agentCount");
    const durationMs = readDataNumber(data, "durationMs");
    const heartbeatSeconds = readDataNumber(data, "heartbeatSeconds");
    const defaultAgentId = readDataString(data, "defaultAgentId");

    const parts = [];
    if (channelCount !== null) parts.push(`channels=${channelCount}`);
    if (sessionCount !== null) parts.push(`sessions=${sessionCount}`);
    if (agentCount !== null) parts.push(`agents=${agentCount}`);
    if (durationMs !== null) parts.push(`durationMs=${durationMs}`);
    if (heartbeatSeconds !== null) parts.push(`heartbeatSeconds=${heartbeatSeconds}`);
    if (defaultAgentId) parts.push(`defaultAgent=${defaultAgentId}`);
    return parts.length ? truncateText(parts.join(" · ")) : null;
  }

  if (kind.startsWith("tool.")) {
    const name = readDataString(data, "name");
    const toolCallId = readDataString(data, "toolCallId");
    const ok = typeof data.ok === "boolean" ? data.ok : null;

    const parts = [];
    if (name) parts.push(`tool=${name}`);
    if (toolCallId) parts.push(`callId=${toolCallId}`);
    if (ok !== null) parts.push(`ok=${ok ? "true" : "false"}`);
    return parts.length ? truncateText(parts.join(" · ")) : null;
  }

  if (kind.startsWith("message.chat.")) {
    const state = readDataString(data, "state");
    const seq = readDataNumber(data, "seq");
    const stopReason = readDataString(data, "stopReason");
    const error = readDataString(data, "error");

    const parts = [];
    if (state) parts.push(`state=${state}`);
    if (seq !== null) parts.push(`seq=${seq}`);
    if (stopReason) parts.push(`stopReason=${stopReason}`);
    if (error) parts.push(`error=${error}`);
    return parts.length ? truncateText(parts.join(" · ")) : null;
  }

  if (kind.startsWith("rpc.exec.approval.")) {
    const decision = readDataString(data, "decision");
    const command = readDataString(data, "command");
    const id = readDataString(data, "id");

    const parts = [];
    if (command) parts.push(`command=${command}`);
    if (decision) parts.push(`decision=${decision}`);
    if (id) parts.push(`id=${id}`);
    return parts.length ? truncateText(parts.join(" · ")) : null;
  }

  return null;
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
    lastErrorRaw: { state: true },
    eventListLimit: { state: true },
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
      height: 460px;
      max-height: 70vh;
    }

    svg {
      width: 100%;
      height: 100%;
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

    .graph-summary {
      margin-top: 10px;
      display: grid;
      gap: 6px;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }

    .graph-summary-title {
      font-family: var(--sans);
      font-weight: 900;
      color: var(--text-strong);
      font-size: 12px;
      letter-spacing: 0.2px;
    }

    .graph-summary-row {
      display: flex;
      gap: 8px;
      align-items: baseline;
      flex-wrap: wrap;
    }

    .graph-summary-kind {
      font-weight: 900;
      color: var(--text-strong);
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

    .event-route {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: baseline;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--text);
    }

    .event-arrow {
      color: var(--muted);
      font-weight: 900;
    }

    .event-meta {
      margin-top: 6px;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }

    details.event-details {
      margin-top: 8px;
    }

    details.event-details summary {
      cursor: pointer;
      color: var(--text-strong);
      font-weight: 900;
      font-family: var(--sans);
      font-size: 12px;
    }

    details.event-details pre {
      margin: 8px 0 0;
      padding: 10px 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--field-bg);
      color: var(--text);
      overflow: auto;
      max-height: 260px;
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
  private autoHealthTimer: number | null = null;
  private autoHealthInFlight = false;

  hello: GatewayHelloOk | null = null;
  lastError: string | null = null;
  lastErrorRaw: string | null = null;
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
  autoHealth = (() => {
    const saved = readLocalStorage(STORAGE_AUTO_HEALTH).trim();
    if (saved === "0") return false;
    if (saved === "1") return true;
    return true;
  })();
  scope: "all" | "session" = "all";
  sessionKey = "";
  windowMs = 60_000;
  filters: RoutingFilters = { rpc: true, messages: true, tools: true };
  events: GatewayTraceEvent[] = [];
  eventListLimit = (() => {
    const raw = readLocalStorage(STORAGE_LIST_LIMIT).trim();
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_EVENT_LIST_LIMIT;
    return Math.max(20, Math.min(2000, parsed));
  })();

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

  private setAutoHealth(enabled: boolean) {
    this.autoHealth = enabled;
    writeLocalStorage(STORAGE_AUTO_HEALTH, enabled ? "1" : "0");

    if (enabled && this.connected) {
      this.startAutoHealth();
      return;
    }
    this.stopAutoHealth();
  }

  private startAutoHealth() {
    if (this.autoHealthTimer != null) {
      return;
    }
    const intervalMs = AUTO_HEALTH_INTERVAL_MS;
    this.autoHealthTimer = window.setInterval(() => void this.requestHealth(), intervalMs);
  }

  private stopAutoHealth() {
    if (this.autoHealthTimer == null) {
      return;
    }
    clearInterval(this.autoHealthTimer);
    this.autoHealthTimer = null;
  }

  private pushSyntheticEvent(evt: GatewayTraceEvent) {
    this.eventsBuffer = trimEvents([evt, ...this.eventsBuffer]);
    this.scheduleSync(false);
  }

  private async requestHealth() {
    const client = this.client;
    if (!client || !client.connected) {
      return;
    }
    if (this.autoHealthInFlight) {
      return;
    }
    this.autoHealthInFlight = true;

    const ts = Date.now();
    const clientNode = { kind: "client" as const, id: "routing-graph", label: "routing-graph" };
    const rpcNode = { kind: "rpc" as const, id: "health", label: "health" };

    this.pushSyntheticEvent({
      id: `viz_trace_health_req_${ts}`,
      ts,
      kind: "rpc.health.request",
      from: clientNode,
      to: rpcNode,
    });

    try {
      await client.request("health");
      const doneTs = Date.now();
      this.pushSyntheticEvent({
        id: `viz_trace_health_res_${doneTs}`,
        ts: doneTs,
        kind: "rpc.health.response",
        from: rpcNode,
        to: clientNode,
        label: "ok",
      });
    } catch (err: unknown) {
      const doneTs = Date.now();
      const msg = err instanceof Error ? err.message : String(err);
      this.pushSyntheticEvent({
        id: `viz_trace_health_res_${doneTs}`,
        ts: doneTs,
        kind: "rpc.health.response",
        from: rpcNode,
        to: clientNode,
        label: msg.slice(0, 80),
        data: { error: msg },
      });
    } finally {
      this.autoHealthInFlight = false;
    }
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

  private loadDemo() {
    const now = Date.now();
    const sessionKey = "demo";
    const runId = "demo-run";

    const client = { kind: "client" as const, id: "routing-graph", label: "routing-graph" };
    const gateway = { kind: "gateway" as const, id: "gateway", label: "gateway" };
    const channel = { kind: "channel" as const, id: "feishu", label: "feishu" };
    const session = { kind: "session" as const, id: sessionKey, label: sessionKey };
    const agent = { kind: "agent" as const, id: "agent-1", label: "agent-1" };
    const tool = { kind: "tool" as const, id: "browser.search", label: "browser.search" };

    const demoEvents: GatewayTraceEvent[] = [
      {
        id: `demo_${now}_1`,
        ts: now - 4_200,
        kind: "rpc.connect",
        from: client,
        to: gateway,
        label: "demo",
      },
      {
        id: `demo_${now}_2`,
        ts: now - 3_600,
        kind: "message.in",
        from: channel,
        to: session,
        label: "hello",
        sessionKey,
        runId,
        data: { channel: "feishu" },
      },
      {
        id: `demo_${now}_3`,
        ts: now - 2_900,
        kind: "tool.start",
        from: session,
        to: tool,
        label: "call_1",
        sessionKey,
        runId,
        data: { toolCallId: "call_1", name: "browser.search" },
      },
      {
        id: `demo_${now}_4`,
        ts: now - 2_000,
        kind: "tool.result",
        from: tool,
        to: session,
        label: "call_1",
        sessionKey,
        runId,
        data: { toolCallId: "call_1", name: "browser.search", ok: true },
      },
      {
        id: `demo_${now}_5`,
        ts: now - 1_300,
        kind: "message.chat.final",
        from: agent,
        to: session,
        label: "#1",
        sessionKey,
        runId,
        data: { state: "final", seq: 1 },
      },
      {
        id: `demo_${now}_6`,
        ts: now - 700,
        kind: "message.out",
        from: session,
        to: channel,
        label: "reply",
        sessionKey,
        runId,
        data: { channel: "feishu" },
      },
    ];

    this.lastError = null;
    this.lastErrorRaw = null;
    this.paused = false;
    this.stopAutoHealth();

    this.eventsBuffer = trimEvents([...demoEvents].sort((a, b) => b.ts - a.ts));
    this.scheduleSync(true);
  }

  private connect() {
    this.lastError = null;
    this.lastErrorRaw = null;
    writeLocalStorage(STORAGE_GATEWAY_URL, this.gatewayUrl);
    writeSessionStorage(STORAGE_TOKEN, this.token);
    writeSessionStorage(STORAGE_PASSWORD, this.password);

    this.resetEvents();
    this.stopAutoHealth();
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
        this.lastErrorRaw = null;

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

        // Kick a first health request so the graph is never "empty" right after connect.
        void this.requestHealth();

        if (this.autoHealth) {
          this.startAutoHealth();
        }
      },
      onClose: ({ code, reason, error }) => {
        this.connected = false;
        this.hello = null;
        this.stopAutoHealth();
        const described = describeDisconnect({ code, reason, error });
        this.lastError = described.summary;
        this.lastErrorRaw = described.raw;
      },
      onGap: ({ expected, received }) => {
        this.lastError = `event gap detected (expected seq ${expected}, got ${received})`;
        this.lastErrorRaw = null;
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
    this.stopAutoHealth();
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
      return html`
        <div class="graph">
          <div style="padding: 16px; color: var(--muted);">
            No routing edges in the current window.
            <div style="margin-top: 8px; font-family: var(--mono); font-size: 12px;">
              ${filtered.length} events in window · try “Ping health” or enable “Auto health”
            </div>
          </div>
        </div>
      `;
    }

    const previewRows = edges.slice(0, 12).map((edge) => {
      const from = nodeByKey.get(edge.fromKey);
      const to = nodeByKey.get(edge.toKey);
      if (!from || !to) {
        return nothing;
      }
      return html`
        <div class="graph-summary-row">
          <span class="graph-summary-kind">${edge.kind}</span>
          <span>(${edge.count})</span>
          <span>${from.label}</span>
          <span>→</span>
          <span>${to.label}</span>
          ${edge.label ? html`<span>— ${edge.label}</span>` : nothing}
        </div>
      `;
    });

    return html`
      <div>
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
                <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path>
              </marker>
            </defs>

            ${edges.map((edge) => {
              const from = nodeByKey.get(edge.fromKey);
              const to = nodeByKey.get(edge.toKey);
              if (!from || !to) return nothing;
              const ageMs = now - edge.lastTs;
              const freshness = 1 - clamp(ageMs / this.windowMs, 0, 1);
              const opacity = 0.25 + freshness * 0.75;
              const width = 1.5 + Math.log10(edge.count + 1) * 2.8;
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

        <div class="graph-summary">
          <div class="graph-summary-title">Edge Preview</div>
          ${previewRows}
        </div>
      </div>
    `;
  }

  private renderEventsList() {
    const { filtered } = this.filteredEvents();
    const rows = filtered.slice(0, this.eventListLimit);
    if (rows.length === 0) {
      return html`<div style="margin-top: 12px; color: var(--muted);">No events yet.</div>`;
    }

    return html`
      <div class="events">
        ${rows.map(
          (evt) => {
            const from = evt.from?.label ?? evt.from?.id ?? "from";
            const to = evt.to?.label ?? evt.to?.id ?? "to";
            const label = typeof evt.label === "string" ? evt.label.trim() : "";
            const metaParts = [];
            if (evt.runId) metaParts.push(`runId=${evt.runId}`);
            if (evt.sessionKey) metaParts.push(`session=${evt.sessionKey}`);
            const meta = metaParts.join(" · ");
            const summary = formatEventSummary(evt);
            const hasData = Boolean(evt.data && Object.keys(evt.data).length > 0);
            return html`
              <div class="event-row">
                <div class="event-top">
                  <div class="event-kind">${evt.kind}</div>
                  <div class="event-age">
                    ${new Date(evt.ts).toLocaleTimeString()} · ${formatRelativeTimestamp(evt.ts)}
                  </div>
                </div>
                <div class="event-body">
                  <div class="event-route">
                    <span>${from}</span>
                    <span class="event-arrow">→</span>
                    <span>${to}</span>
                    ${label ? html`<span class="event-arrow">—</span><span>${label}</span>` : nothing}
                  </div>
                  ${meta ? html`<div class="event-meta">${meta}</div>` : nothing}
                  ${summary ? html`<div class="event-meta">${summary}</div>` : nothing}
                  ${
                    hasData
                      ? html`<details class="event-details">
                          <summary>data</summary>
                          <pre>${safeJson(evt.data)}</pre>
                        </details>`
                      : nothing
                  }
                </div>
              </div>
            `;
          },
        )}
      </div>
    `;
  }

  render() {
    const { filtered } = this.filteredEvents();
    const { nodes, edges } = buildGraph(filtered, Date.now());

    const windowOptions = [
      { label: "5s", ms: 5_000 },
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

        ${this.lastError
          ? html`<div class="sub" style="margin-top: 10px; color: var(--danger);">
              <div>${this.lastError}</div>
              ${this.lastErrorRaw
                ? html`<details class="event-details" style="margin-top: 8px;">
                    <summary>technical details</summary>
                    <pre>${this.lastErrorRaw}</pre>
                  </details>`
                : nothing}
            </div>`
          : nothing}

        <div class="row" style="margin-top: 12px; justify-content: space-between;">
          <div class="sub">${filtered.length} events · ${nodes.length} nodes · ${edges.length} edges</div>
          <div class="row">
            <button class="btn" @click=${() => this.loadDemo()}>Demo</button>
            <button class="btn" ?disabled=${!this.connected} @click=${() => void this.requestHealth()}>
              Ping health
            </button>
            <label class="row" style="gap: 8px; font-weight: 700; color: var(--muted);">
              <input
                type="checkbox"
                .checked=${this.autoHealth}
                @change=${(e: Event) =>
                  this.setAutoHealth((e.target as HTMLInputElement).checked)}
              />
              Auto health (5s)
            </label>
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

          <label>
            List limit
            <select
              .value=${String(this.eventListLimit)}
              @change=${(e: Event) => {
                const v = Number((e.target as HTMLSelectElement).value);
                this.eventListLimit = v;
                writeLocalStorage(STORAGE_LIST_LIMIT, String(v));
              }}
            >
              <option value="50">50</option>
              <option value="200">200</option>
              <option value="500">500</option>
              <option value="1000">1000</option>
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
