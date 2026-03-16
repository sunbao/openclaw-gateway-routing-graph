import { css, html, LitElement, nothing, svg, type TemplateResult } from "lit";
import { GatewayWsClient, type GatewayHelloOk } from "./gateway-client.ts";
import { ObserverStreamClient, type ObserverHealth } from "./observer-client.ts";
import type { GatewayTraceEvent, GatewayTraceNode, RoutingFilters } from "./routing-types.ts";
import { traceEventsFromGatewayEvent } from "./routing-adapters.ts";
import {
  GRAPH_H,
  GRAPH_W,
  buildGraph,
  clamp,
  colorForEventKind,
  fillForNodeKind,
  formatEdgeTitle,
  formatNodeTitle,
  formatRelativeTimestamp,
  shouldIncludeEvent,
  strokeForNodeKind,
  truncateLabel,
} from "./routing-graph.ts";

const STORAGE_GATEWAY_URL = "openclaw.routingGraph.gatewayUrl";
const STORAGE_TOKEN = "openclaw.routingGraph.token";
const STORAGE_PASSWORD = "openclaw.routingGraph.password";
const STORAGE_THEME = "openclaw.routingGraph.theme";
const STORAGE_AUTO_HEALTH = "openclaw.routingGraph.autoHealth";
const STORAGE_LIST_LIMIT = "openclaw.routingGraph.listLimit";
const STORAGE_LABEL_RULES = "openclaw.routingGraph.labelRules";

const EVENT_BUFFER_LIMIT = 2000;
const DEFAULT_EVENT_LIST_LIMIT = 200;
const SYNC_THROTTLE_MS = 80;
const AUTO_HEALTH_INTERVAL_MS = 5_000;
const GRAPH_HIGHLIGHT_MS = 7_000;
const DEFAULT_WINDOW_MS = 5_000;

type SessionSummary = {
  sessionKey: string;
  sessionLabel: string;
  channelId: string;
  chatType: string;
  updatedAt: number;
  inbound?: GatewayTraceEvent;
  outbound?: GatewayTraceEvent;
};

type LabelAliasMap = Map<string, string>;

type LabelRule = {
  kind: string;
  id: string;
  label: string;
};

type BaselineGraphNode = {
  key: string;
  kind: string;
  label: string;
  x: number;
  y: number;
};

type BaselineGraphEdge = {
  fromKey: string;
  toKey: string;
  kind: string;
};

const BASELINE_GRAPH_NODES: BaselineGraphNode[] = [
  { key: "client:source", kind: "client", label: "入口客户端", x: 90, y: 230 },
  { key: "gateway:gateway", kind: "gateway", label: "网关", x: 210, y: 230 },
  { key: "rpc:health", kind: "rpc", label: "RPC", x: 380, y: 130 },
  { key: "agent:agent", kind: "agent", label: "智能体", x: 560, y: 155 },
  { key: "tool:tool", kind: "tool", label: "工具", x: 680, y: 470 },
  { key: "session:session", kind: "session", label: "会话", x: 860, y: 230 },
  { key: "channel:channel", kind: "channel", label: "渠道", x: 1080, y: 230 },
  { key: "node:device", kind: "node", label: "设备/节点", x: 1190, y: 470 },
];

const BASELINE_GRAPH_EDGES: BaselineGraphEdge[] = [
  { fromKey: "client:source", toKey: "gateway:gateway", kind: "rpc.connect" },
  { fromKey: "gateway:gateway", toKey: "rpc:health", kind: "rpc.health" },
  { fromKey: "gateway:gateway", toKey: "agent:agent", kind: "message.chat.delta" },
  { fromKey: "agent:agent", toKey: "session:session", kind: "message.chat.final" },
  { fromKey: "channel:channel", toKey: "session:session", kind: "message.in" },
  { fromKey: "session:session", toKey: "channel:channel", kind: "message.out" },
  { fromKey: "session:session", toKey: "tool:tool", kind: "tool.start" },
  { fromKey: "tool:tool", toKey: "session:session", kind: "tool.result" },
  { fromKey: "channel:channel", toKey: "node:device", kind: "system.presence" },
];

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

function truncateText(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeJson(value: unknown, maxChars = 2400): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? "";
    if (raw.length <= maxChars) {
      return raw;
    }
    return `${raw.slice(0, maxChars)}\n…(已截断)`;
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

  if (info.code === 1006) {
    return {
      summary:
        "连接中断：浏览器 WebSocket 握手没有完成。常见原因是跨域、反向代理未透传 Upgrade，或网关地址不是可直连的 WS 地址。",
      raw,
    };
  }

  if (info.code === 1011) {
    if (reasonLower.includes("unexpected server response")) {
      return {
        summary: "连接失败：上游返回的不是 WebSocket 响应，请检查地址是否指向网关 WS 端点。",
        raw,
      };
    }
    if (reasonLower.includes("rejected websocket upgrade") || reasonLower.includes("http ")) {
      return {
        summary: "连接失败：网关拒绝了 WebSocket 升级请求，请检查反向代理和 Origin 校验。",
        raw,
      };
    }
    if (reasonLower.includes("econnrefused")) {
      return {
        summary: "连接失败：目标端口拒绝连接，请确认网关进程正在运行。",
        raw,
      };
    }
    if (reasonLower.includes("enotfound")) {
      return {
        summary: "连接失败：无法解析网关地址，请检查域名或 IP。",
        raw,
      };
    }
    if (reasonLower.includes("timed out") || reasonLower.includes("etimedout")) {
      return {
        summary: "连接失败：连接网关超时，请检查网络可达性。",
        raw,
      };
    }
    if (reasonLower.includes("upstream")) {
      return {
        summary: "连接失败：上游网关返回异常，请检查网关日志或代理配置。",
        raw,
      };
    }
    return {
      summary: "连接失败：网关上游发生内部错误。",
      raw,
    };
  }

  if (info.code === 1008) {
    if (reasonLower.includes("pairing required")) {
      return {
        summary: "连接失败：当前网关要求先完成设备配对（pairing）。",
        raw,
      };
    }
    if (reasonLower.includes("device identity required")) {
      return {
        summary: "连接失败：当前网关要求设备身份或更高权限的令牌。",
        raw,
      };
    }
  }

  if (info.code === 4008 || reasonLower.includes("connect failed")) {
    return {
      summary: "连接失败：网关 connect 握手未通过，请检查 Token、密码或权限范围。",
      raw,
    };
  }

  return {
    summary: `连接已断开（代码 ${info.code}）。`,
    raw,
  };
}

function readDataString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

function readDataNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readDataBoolean(data: Record<string, unknown>, key: string): boolean | null {
  const value = data[key];
  return typeof value === "boolean" ? value : null;
}

function readDataStringList(data: Record<string, unknown>, key: string, limit = 6): string[] {
  const value = data[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean)
    .slice(0, limit);
}

function isChannelIoEvent(evt: GatewayTraceEvent): boolean {
  return evt.kind === "message.in" || evt.kind === "message.out";
}

function channelIoDirectionLabel(kind: string): string {
  return kind === "message.in" ? "入口" : "出口";
}

function channelIoDirectionTone(kind: string): "in" | "out" {
  return kind === "message.in" ? "in" : "out";
}

function formatChatType(chatType: string): string {
  const normalized = chatType.trim().toLowerCase();
  if (["group", "channel", "room", "space"].includes(normalized)) {
    return "群聊";
  }
  if (["direct", "dm", "user"].includes(normalized)) {
    return "私聊";
  }
  if (normalized === "thread" || normalized === "topic") {
    return "话题";
  }
  return chatType || "未知";
}

function friendlyEventKind(kind: string): string {
  if (kind === "message.in") return "渠道入口消息";
  if (kind === "message.out") return "渠道出口消息";
  if (kind === "rpc.health") return "健康检查";
  if (kind === "rpc.connect") return "网关连接";
  if (kind === "rpc.health.request") return "健康探测请求";
  if (kind === "rpc.health.response") return "健康探测响应";
  if (kind === "health.channel") return "渠道状态";
  if (kind === "health.agent") return "智能体状态";
  if (kind === "health.session") return "会话状态";
  if (kind === "rpc.tick" || kind === "rpc.heartbeat") return "心跳";
  if (kind.startsWith("tool.")) return `工具事件 · ${kind.slice(5)}`;
  if (kind.startsWith("message.chat.")) return `会话输出 · ${kind.slice("message.chat.".length)}`;
  if (kind.startsWith("rpc.")) return `RPC · ${kind.slice(4)}`;
  if (kind.startsWith("system.")) return `系统事件 · ${kind.slice(7)}`;
  return kind;
}

function formatNodeLabel(node: GatewayTraceNode | undefined): string {
  if (!node) return "未知节点";
  return node.label?.trim() || node.id || node.kind;
}

function friendlyNodeKind(kind: string): string {
  if (kind === "client") return "入口";
  if (kind === "gateway") return "网关";
  if (kind === "rpc") return "RPC";
  if (kind === "agent") return "智能体";
  if (kind === "tool") return "工具";
  if (kind === "session") return "会话";
  if (kind === "channel") return "渠道";
  if (kind === "node") return "设备";
  return kind;
}

function graphLabelLimitByKind(kind: string): number {
  if (kind === "session") return 16;
  if (kind === "channel") return 10;
  if (kind === "tool") return 14;
  if (kind === "agent") return 15;
  if (kind === "rpc") return 10;
  return 12;
}

function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatWindowLabel(ms: number): string {
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)} 秒`;
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)} 分钟`;
  }
  return `${Math.round(ms / 3_600_000)} 小时`;
}

function formatChannelIoMeta(evt: GatewayTraceEvent): string[] {
  const data = evt.data ?? {};
  const channelId = readDataString(data, "channelId");
  const chatType = readDataString(data, "chatType");
  const from = readDataString(data, "from");
  const to = readDataString(data, "to");
  const accountId = readDataString(data, "accountId");
  const threadId = readDataString(data, "threadId");
  const sessionLabel = readDataString(data, "sessionLabel");

  const parts: string[] = [];
  if (channelId) parts.push(`渠道：${channelId}`);
  if (chatType) parts.push(`会话：${formatChatType(chatType)}`);
  if (from) parts.push(`来自：${from}`);
  if (to) parts.push(`去向：${to}`);
  if (accountId) parts.push(`账号：${accountId}`);
  if (threadId) parts.push(`线程：${threadId}`);
  if (sessionLabel) parts.push(`会话名：${sessionLabel}`);
  return parts;
}

function formatChannelIoPreview(evt: GatewayTraceEvent): string {
  const data = evt.data ?? {};
  const preview = readDataString(data, "preview");
  if (preview) {
    return preview;
  }
  if (typeof evt.label === "string" && evt.label.trim()) {
    return evt.label.trim();
  }
  return "（无预览内容）";
}

function formatEventSummary(evt: GatewayTraceEvent): string | null {
  const data = evt.data ?? {};
  const kind = evt.kind;

  if (kind === "rpc.connect") {
    const version = readDataString(data, "serverVersion");
    const role = readDataString(data, "role");
    const scopeCount = readDataNumber(data, "scopeCount");
    const eventCount = readDataNumber(data, "eventCount");
    const methodCount = readDataNumber(data, "methodCount");
    const parts: string[] = [];
    if (version) parts.push(`版本 ${version}`);
    if (role) parts.push(`角色 ${role}`);
    if (scopeCount !== null) parts.push(`权限 ${scopeCount}`);
    if (eventCount !== null) parts.push(`事件 ${eventCount}`);
    if (methodCount !== null) parts.push(`方法 ${methodCount}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (kind === "rpc.health") {
    const channelCount = readDataNumber(data, "channelCount");
    const sessionCount = readDataNumber(data, "sessionCount");
    const agentCount = readDataNumber(data, "agentCount");
    const durationMs = readDataNumber(data, "durationMs");
    const parts: string[] = [];
    if (channelCount !== null) parts.push(`渠道 ${channelCount}`);
    if (sessionCount !== null) parts.push(`会话 ${sessionCount}`);
    if (agentCount !== null) parts.push(`智能体 ${agentCount}`);
    if (durationMs !== null) parts.push(`耗时 ${durationMs}ms`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (kind === "health.channel") {
    const configured = readDataBoolean(data, "configured");
    const linked = readDataBoolean(data, "linked");
    const accountCount = readDataNumber(data, "accountCount");
    const parts: string[] = [];
    if (configured !== null) parts.push(configured ? "已配置" : "未配置");
    if (linked !== null) parts.push(linked ? "已连通" : "未连通");
    if (accountCount !== null) parts.push(`账号 ${accountCount}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (kind === "health.agent") {
    const isDefault = readDataBoolean(data, "isDefault");
    const sessionCount = readDataNumber(data, "sessionCount");
    const heartbeatEveryMs = readDataNumber(data, "heartbeatEveryMs");
    const parts: string[] = [];
    if (isDefault) parts.push("默认智能体");
    if (sessionCount !== null) parts.push(`会话 ${sessionCount}`);
    if (heartbeatEveryMs !== null) parts.push(`心跳 ${Math.round(heartbeatEveryMs / 1000)} 秒`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (kind === "health.session") {
    const sessionKey = readDataString(data, "sessionKey");
    const updatedAt = readDataNumber(data, "updatedAt");
    const parts: string[] = [];
    if (sessionKey) parts.push(`会话 ${sessionKey}`);
    if (updatedAt !== null) parts.push(`更新于 ${formatAbsoluteTime(updatedAt)}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (kind === "message.in" || kind === "message.out") {
    return formatChannelIoPreview(evt);
  }

  if (kind.startsWith("tool.")) {
    const name = readDataString(data, "name");
    const toolCallId = readDataString(data, "toolCallId");
    const ok = readDataBoolean(data, "ok");
    const parts: string[] = [];
    if (name) parts.push(`工具 ${name}`);
    if (toolCallId) parts.push(`调用 ${toolCallId}`);
    if (ok !== null) parts.push(ok ? "成功" : "失败");
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  if (kind.startsWith("message.chat.")) {
    const state = readDataString(data, "state");
    const seq = readDataNumber(data, "seq");
    const stopReason = readDataString(data, "stopReason");
    const error = readDataString(data, "error");
    const preview = readDataString(data, "messagePreview");
    const parts: string[] = [];
    if (state) parts.push(`状态 ${state}`);
    if (seq !== null) parts.push(`片段 ${seq}`);
    if (stopReason) parts.push(`结束原因 ${stopReason}`);
    if (error) parts.push(`错误 ${error}`);
    if (preview) parts.push(`内容 ${truncateText(preview, 80)}`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  return typeof evt.label === "string" && evt.label.trim() ? evt.label.trim() : null;
}

function buildSessionSummaries(events: GatewayTraceEvent[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();

  for (const evt of events) {
    if (!isChannelIoEvent(evt)) {
      continue;
    }
    const sessionKey = (evt.sessionKey || "").trim();
    if (!sessionKey) {
      continue;
    }

    const data = evt.data ?? {};
    const existing = sessions.get(sessionKey) ?? {
      sessionKey,
      sessionLabel: readDataString(data, "sessionLabel") || sessionKey,
      channelId: readDataString(data, "channelId"),
      chatType: readDataString(data, "chatType"),
      updatedAt: evt.ts,
    };

    existing.updatedAt = Math.max(existing.updatedAt, evt.ts);
    if (!existing.sessionLabel) {
      existing.sessionLabel = readDataString(data, "sessionLabel") || sessionKey;
    }
    if (!existing.channelId) {
      existing.channelId = readDataString(data, "channelId");
    }
    if (!existing.chatType) {
      existing.chatType = readDataString(data, "chatType");
    }
    if (evt.kind === "message.in" && !existing.inbound) {
      existing.inbound = evt;
    }
    if (evt.kind === "message.out" && !existing.outbound) {
      existing.outbound = evt;
    }

    sessions.set(sessionKey, existing);
  }

  return [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12);
}

function collectObservedChannelIds(events: GatewayTraceEvent[]): string[] {
  const ids = new Set<string>();
  for (const evt of events) {
    const data = evt.data ?? {};
    const channelId = readDataString(data, "channelId");
    if (channelId) {
      ids.add(channelId);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

function buildLabelAliasMap(rules: LabelRule[]): LabelAliasMap {
  const map: LabelAliasMap = new Map();
  for (const rule of rules) {
    map.set(`${rule.kind}:${rule.id}`.toLowerCase(), rule.label);
  }
  return map;
}

function normalizeLabelRule(rule: Partial<LabelRule> | null | undefined): LabelRule | null {
  if (!rule) {
    return null;
  }

  const kind = String(rule.kind ?? "").trim().toLowerCase();
  const id = String(rule.id ?? "").trim();
  const label = String(rule.label ?? "").trim();
  if (!kind || !id || !label) {
    return null;
  }

  return { kind, id, label };
}

function readStoredLabelRules(): LabelRule[] {
  const raw = readLocalStorage(STORAGE_LABEL_RULES).trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        return {
          kind: String((entry as Partial<LabelRule>).kind ?? ""),
          id: String((entry as Partial<LabelRule>).id ?? ""),
          label: String((entry as Partial<LabelRule>).label ?? ""),
        } satisfies LabelRule;
      })
      .filter((entry): entry is LabelRule => entry !== null);
  } catch {
    return [];
  }
}

export class RoutingGraphApp extends LitElement {
  static properties = {
    gatewayUrl: { state: true },
    token: { state: true },
    password: { state: true },
    labelEditorRules: { state: true },
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
    autoHealth: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      padding: 20px;
      max-width: 1320px;
      margin: 0 auto 32px;
    }

    .page {
      display: grid;
      gap: 16px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
    }

    .title {
      font-size: 24px;
      line-height: 1.2;
      font-weight: 900;
      color: var(--text-strong);
    }

    .sub {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, var(--card) 0%, var(--card-2) 100%);
      box-shadow: var(--shadow);
      padding: 16px;
      backdrop-filter: blur(10px);
    }

    .top-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
      align-items: stretch;
    }

    .toolbar-main {
      min-width: 0;
    }

    .toolbar-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .toolbar-status {
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    .toolbar-status-left,
    .toolbar-status-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .toolbar-tip {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }

    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--field-bg);
      color: var(--text);
      height: 46px;
      padding: 0 14px;
      outline: none;
      min-width: 0;
      font: inherit;
      line-height: 1.35;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: rgba(96, 165, 250, 0.6);
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.14);
    }

    input[type="password"] {
      font-family: var(--mono);
    }

    input::placeholder,
    textarea::placeholder {
      color: color-mix(in srgb, var(--muted) 82%, transparent);
    }

    select {
      appearance: none;
      -webkit-appearance: none;
      -moz-appearance: none;
      padding-right: 42px;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--muted) 50%),
        linear-gradient(135deg, var(--muted) 50%, transparent 50%);
      background-position:
        calc(100% - 20px) calc(50% - 2px),
        calc(100% - 14px) calc(50% - 2px);
      background-size: 6px 6px, 6px 6px;
      background-repeat: no-repeat;
    }

    textarea {
      min-height: 120px;
      height: auto;
      padding: 12px 14px;
      resize: vertical;
      line-height: 1.55;
    }

    .btn {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--field-bg);
      color: var(--text-strong);
      padding: 11px 14px;
      min-height: 44px;
      min-width: 96px;
      font-weight: 900;
      white-space: nowrap;
      flex: 0 0 auto;
      cursor: pointer;
      transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
    }

    .btn:hover {
      transform: translateY(-1px);
    }

    .btn.primary {
      background: rgba(37, 99, 235, 0.14);
      border-color: rgba(37, 99, 235, 0.28);
    }

    .btn.danger {
      background: rgba(225, 29, 72, 0.12);
      border-color: rgba(225, 29, 72, 0.26);
    }

    .btn.compact {
      min-width: 72px;
      min-height: 40px;
      padding: 9px 12px;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      font-size: 12px;
      font-weight: 900;
      white-space: nowrap;
    }

    .pill.ok {
      color: #15803d;
      border-color: rgba(34, 197, 94, 0.35);
      background: rgba(34, 197, 94, 0.12);
    }

    .pill.warn {
      color: #b45309;
      border-color: rgba(245, 158, 11, 0.35);
      background: rgba(245, 158, 11, 0.12);
    }

    .pill.danger {
      color: #be123c;
      border-color: rgba(244, 63, 94, 0.35);
      background: rgba(244, 63, 94, 0.12);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
    }

    .stat-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--card) 88%, transparent);
    }

    .stat-label {
      font-size: 12px;
      color: var(--muted);
      font-weight: 800;
    }

    .stat-value {
      margin-top: 8px;
      font-size: 30px;
      line-height: 1;
      font-weight: 900;
      color: var(--text-strong);
    }

    .stat-sub {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }

    .snapshot-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }

    .snapshot-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--card) 90%, transparent);
    }

    .snapshot-title {
      font-size: 14px;
      font-weight: 900;
      color: var(--text-strong);
    }

    .snapshot-time {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }

    .snapshot-content {
      margin-top: 12px;
      font-size: 15px;
      line-height: 1.7;
      color: var(--text-strong);
      word-break: break-word;
    }

    .snapshot-meta {
      margin-top: 12px;
      display: grid;
      gap: 8px;
      color: var(--text);
      font-size: 13px;
      line-height: 1.55;
    }

    .snapshot-empty {
      margin-top: 12px;
      color: var(--muted);
      line-height: 1.6;
    }

    .section-title {
      font-size: 18px;
      font-weight: 900;
      color: var(--text-strong);
    }

    .section-subtitle {
      margin-top: 4px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }

    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
    }

    .section-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }

    .io-panel {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--card) 90%, transparent);
    }

    .io-panel-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 900;
      color: var(--text-strong);
    }

    .io-panel-subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }

    .io-list {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }

    .io-row {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      background: var(--field-bg);
    }

    .io-row-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .io-direction {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 900;
      border: 1px solid transparent;
    }

    .io-direction.in {
      color: #1d4ed8;
      background: rgba(37, 99, 235, 0.12);
      border-color: rgba(37, 99, 235, 0.22);
    }

    .io-direction.out {
      color: #b45309;
      background: rgba(217, 119, 6, 0.12);
      border-color: rgba(217, 119, 6, 0.22);
    }

    .io-age {
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }

    .io-preview {
      margin-top: 10px;
      font-size: 14px;
      line-height: 1.6;
      color: var(--text-strong);
      word-break: break-word;
    }

    .io-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      font-family: var(--mono);
      word-break: break-word;
    }

    .session-card-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }

    .session-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--card) 92%, transparent);
      overflow-wrap: anywhere;
    }

    .session-card-title {
      font-size: 14px;
      font-weight: 900;
      color: var(--text-strong);
    }

    .session-card-subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
      line-height: 1.5;
    }

    .session-card-line {
      margin-top: 10px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--text);
    }

    .session-card-line strong {
      color: var(--text-strong);
    }

    .graph-shell {
      margin-top: 14px;
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: auto;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 740px;
      padding: 16px 20px;
      background:
        radial-gradient(circle at 15% 10%, rgba(124, 58, 237, 0.05), transparent 26%),
        radial-gradient(circle at 80% 10%, rgba(37, 99, 235, 0.04), transparent 26%),
        color-mix(in srgb, var(--card) 97%, transparent);
    }

    svg.graph-svg {
      display: block;
      width: 1320px;
      max-width: none;
      height: auto;
      margin: 0 auto;
    }

    .graph-axis-label {
      fill: var(--muted);
      font-size: 11px;
      font-weight: 800;
      opacity: 0.7;
    }

    .graph-node-label {
      fill: var(--text-strong);
      font-size: 11px;
      font-weight: 900;
      paint-order: stroke;
      stroke: var(--text-outline);
      stroke-width: 3px;
      stroke-linejoin: round;
    }

    .graph-node-sub {
      fill: var(--muted);
      font-size: 10px;
      font-weight: 700;
      paint-order: stroke;
      stroke: var(--text-outline);
      stroke-width: 2px;
    }

    .edge-dot {
      filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.7));
    }

    .graph-edge-label {
      fill: var(--text-strong);
      font-size: 10px;
      font-weight: 800;
      paint-order: stroke;
      stroke: var(--text-outline);
      stroke-width: 3px;
      stroke-linejoin: round;
    }

    .baseline-edge {
      opacity: 0.08;
    }

    .baseline-node {
      opacity: 0.18;
    }

    .graph-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 14px;
    }

    .summary-box {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      background: var(--field-bg);
    }

    .summary-box-title {
      font-size: 13px;
      font-weight: 900;
      color: var(--text-strong);
    }

    .summary-list {
      margin: 10px 0 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 8px;
    }

    .summary-item {
      color: var(--text);
      font-size: 12px;
      line-height: 1.55;
      word-break: break-word;
    }

    .graph-empty {
      margin-top: 12px;
      padding: 14px;
      border: 1px dashed var(--border-strong);
      border-radius: 14px;
      color: var(--muted);
      background: var(--field-bg);
      line-height: 1.6;
    }

    details {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px 14px;
      background: color-mix(in srgb, var(--card) 92%, transparent);
    }

    details > summary {
      cursor: pointer;
      font-weight: 900;
      color: var(--text-strong);
      list-style: none;
    }

    details > summary::-webkit-details-marker {
      display: none;
    }

    .advanced-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      margin-top: 12px;
      align-items: end;
    }

    .inline-check {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      padding-top: 22px;
    }

    .inline-check input {
      width: auto;
      flex: 0 0 auto;
    }

    .action-slot {
      display: flex;
      align-items: end;
      min-height: 66px;
    }

    .full-span {
      grid-column: 1 / -1;
    }

    .rule-help {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
    }

    .rule-editor {
      margin-top: 12px;
      display: grid;
      gap: 10px;
    }

    .rule-preview-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--text-strong);
      font-size: 13px;
      font-weight: 900;
    }

    .rule-list {
      display: grid;
      gap: 8px;
    }

    .rule-table-head,
    .rule-editor-row {
      display: grid;
      grid-template-columns: 160px minmax(220px, 1.5fr) minmax(200px, 1.2fr) 84px;
      gap: 10px;
      align-items: center;
    }

    .rule-table-head {
      color: var(--muted);
      font-size: 12px;
      font-weight: 900;
      padding: 0 4px;
    }

    .rule-editor-row {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      background: var(--field-bg);
    }

    .rule-editor-row input {
      font-size: 13px;
    }

    .rule-empty {
      border: 1px dashed var(--border);
      border-radius: 12px;
      padding: 16px;
      color: var(--muted);
      background: rgba(148, 163, 184, 0.08);
      font-size: 13px;
      line-height: 1.6;
    }

    .rule-kind {
      color: var(--text-strong);
      font-weight: 900;
      text-transform: uppercase;
    }

    .rule-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .rule-id,
    .rule-label {
      min-width: 0;
      overflow-wrap: anywhere;
      color: var(--text);
      font-family: var(--mono);
    }

    .events {
      margin-top: 12px;
      display: grid;
      gap: 10px;
    }

    .event-row {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      background: var(--field-bg);
      overflow-wrap: anywhere;
    }

    .event-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
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

    .event-route {
      margin-top: 8px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: baseline;
      color: var(--text);
      font-family: var(--mono);
      font-size: 12px;
    }

    .event-arrow {
      color: var(--muted);
      font-weight: 900;
    }

    .event-body {
      margin-top: 8px;
      font-size: 13px;
      line-height: 1.6;
      color: var(--text);
    }

    .event-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      font-family: var(--mono);
    }

    details.event-details {
      margin-top: 8px;
    }

    details.event-details pre {
      margin: 10px 0 0;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(15, 23, 42, 0.05);
      color: var(--text);
      overflow: auto;
      max-height: 280px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .error-box {
      margin-top: 12px;
      border: 1px solid rgba(225, 29, 72, 0.18);
      border-radius: 14px;
      padding: 14px;
      background: rgba(225, 29, 72, 0.08);
      color: #9f1239;
    }

    @media (max-width: 1080px) {
      .section-grid,
      .stats-grid,
      .snapshot-grid,
      .session-card-grid,
      .advanced-grid,
      .graph-summary {
        grid-template-columns: 1fr;
      }

      .toolbar-actions {
        justify-content: flex-start;
      }

      .toolbar-status {
        align-items: flex-start;
      }

      .graph-shell {
        min-height: 560px;
        padding: 10px 12px;
      }

      .rule-table-head {
        display: none;
      }

      .rule-editor-row {
        grid-template-columns: 1fr;
      }
    }
  `;

  private client: GatewayWsClient | null = null;
  private observerClient: ObserverStreamClient | null = null;
  private eventsBuffer: GatewayTraceEvent[] = [];
  private syncTimer: number | null = null;
  private autoHealthTimer: number | null = null;
  private autoHealthInFlight = false;
  hello: GatewayHelloOk | null = null;
  lastError: string | null = null;
  lastErrorRaw: string | null = null;
  gatewayUrl = (() => {
    const saved = readLocalStorage(STORAGE_GATEWAY_URL).trim();
    if (saved) {
      return saved;
    }

    const host = window.location.hostname.toLowerCase();
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (isLoopback) {
      return "ws://127.0.0.1:18789";
    }
    return `http://${window.location.hostname}:17777`;
  })();
  token = readSessionStorage(STORAGE_TOKEN) || "";
  password = readSessionStorage(STORAGE_PASSWORD) || "";
  labelEditorRules = readStoredLabelRules();
  connected = false;
  paused = false;
  theme: "light" | "dark" = (() => {
    const saved = readLocalStorage(STORAGE_THEME).trim();
    if (saved === "dark" || saved === "light") {
      return saved;
    }
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  })();
  autoHealth = (() => {
    const saved = readLocalStorage(STORAGE_AUTO_HEALTH).trim();
    if (saved === "0") return false;
    if (saved === "1") return true;
    return true;
  })();
  scope: "all" | "session" = "all";
  sessionKey = "";
  windowMs = DEFAULT_WINDOW_MS;
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

  disconnectedCallback() {
    super.disconnectedCallback();
    this.disconnect();
    if (this.syncTimer != null) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private applyTheme(next: "light" | "dark") {
    this.theme = next;
    writeLocalStorage(STORAGE_THEME, next);
    document.documentElement.dataset.theme = next;
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
    this.autoHealthTimer = window.setInterval(() => void this.requestHealth(), AUTO_HEALTH_INTERVAL_MS);
  }

  private stopAutoHealth() {
    if (this.autoHealthTimer == null) {
      return;
    }
    clearInterval(this.autoHealthTimer);
    this.autoHealthTimer = null;
  }

  private pushSyntheticEvent(evt: GatewayTraceEvent) {
    this.eventsBuffer = this.prependEvents([evt]);
    this.scheduleSync(false);
  }

  private prependEvents(events: GatewayTraceEvent[]) {
    if (events.length === 0) {
      return this.eventsBuffer;
    }
    const incomingIds = new Set(events.map((evt) => evt.id));
    const dedupedExisting = this.eventsBuffer.filter((evt) => !incomingIds.has(evt.id));
    return trimEvents([...events, ...dedupedExisting]);
  }

  private isObserverMode() {
    return /^https?:\/\//i.test(this.gatewayUrl.trim());
  }

  private applyObserverHealth(health: ObserverHealth) {
    const connected = health.connected !== false;
    this.connected = connected;
    this.hello = {
      type: "hello-ok",
      protocol: 3,
      server: {
        version: health.hello?.server?.version || "observer",
        connId: health.hello?.server?.connId || "observer",
      },
      features: { methods: [], events: [] },
      auth: { role: "observer", scopes: [] },
    };
    this.lastError = connected ? null : (health.lastError ?? null);
    this.lastErrorRaw = connected ? null : (health.lastError ?? null);
  }

  private async requestHealth() {
    if (this.isObserverMode()) {
      const observer = this.observerClient;
      if (!observer || !observer.connected) {
        return;
      }
      try {
        const health = await observer.fetchHealth();
        this.applyObserverHealth(health);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError = `观察器健康检查失败：${msg}`;
        this.lastErrorRaw = msg;
      }
      return;
    }

    const client = this.client;
    if (!client || !client.connected || this.autoHealthInFlight) {
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
        label: truncateText(msg, 80),
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

  private connect() {
    this.lastError = null;
    this.lastErrorRaw = null;
    writeLocalStorage(STORAGE_GATEWAY_URL, this.gatewayUrl);
    writeSessionStorage(STORAGE_TOKEN, this.token);
    writeSessionStorage(STORAGE_PASSWORD, this.password);

    this.resetEvents();
    this.stopAutoHealth();
    this.observerClient?.stop();
    this.observerClient = null;
    this.client?.stop();
    this.client = new GatewayWsClient({
      url: this.gatewayUrl,
      token: this.token || undefined,
      password: this.password || undefined,
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
        const labelParts = [];
        if (hello.server?.version) labelParts.push(hello.server.version);
        if (hello.auth?.role) labelParts.push(hello.auth.role);
        if (hello.auth?.scopes?.length) labelParts.push(`${hello.auth.scopes.length} scopes`);
        if (hello.features?.events?.length) labelParts.push(`${hello.features.events.length} events`);

        this.eventsBuffer = this.prependEvents([
          {
            id: `viz_trace_hello_${ts}`,
            ts,
            kind: "rpc.connect",
            from: { kind: "client", id: "routing-graph", label: "routing-graph" },
            to: { kind: "gateway", id: "gateway", label: "gateway" },
            label: labelParts.join(" · ") || "hello-ok",
            data: {
              serverVersion: hello.server?.version || undefined,
              role: hello.auth?.role || undefined,
              scopeCount: hello.auth?.scopes?.length ?? 0,
              eventCount: hello.features?.events?.length ?? 0,
              methodCount: hello.features?.methods?.length ?? 0,
            },
          },
        ]);
        this.scheduleSync(true);
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
        this.lastError = `事件序列出现跳号：期望 ${expected}，实际收到 ${received}`;
        this.lastErrorRaw = null;
      },
      onEvent: (evt) => {
        if (this.paused) return;
        const next = traceEventsFromGatewayEvent(evt);
        if (next.length === 0) return;
        this.eventsBuffer = this.prependEvents(next);
        this.scheduleSync(false);
      },
    });
    this.client.start();
  }

  private connectObserver() {
    this.lastError = null;
    this.lastErrorRaw = null;
    writeLocalStorage(STORAGE_GATEWAY_URL, this.gatewayUrl);

    this.resetEvents();
    this.stopAutoHealth();
    this.client?.stop();
    this.client = null;
    this.observerClient?.stop();
    this.observerClient = new ObserverStreamClient({
      url: this.gatewayUrl,
      onOpen: (health) => {
        this.applyObserverHealth(health);
        if (this.autoHealth) {
          this.startAutoHealth();
        }
      },
      onClose: ({ message }) => {
        this.connected = false;
        this.hello = null;
        this.lastError = "观察器连接已断开";
        this.lastErrorRaw = message;
      },
      onEvent: (evt) => {
        if (this.paused) return;
        this.eventsBuffer = this.prependEvents([evt]);
        this.scheduleSync(false);
      },
    });
    void this.observerClient.start().catch((err: unknown) => {
      this.connected = false;
      this.hello = null;
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = `观察器连接失败：${msg}`;
      this.lastErrorRaw = msg;
    });
  }

  private disconnect() {
    this.client?.stop();
    this.client = null;
    this.observerClient?.stop();
    this.observerClient = null;
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
    return { now, filtered };
  }

  private getLabelRules(): LabelRule[] {
    return this.labelEditorRules
      .map((rule) => normalizeLabelRule(rule))
      .filter((rule): rule is LabelRule => rule !== null);
  }

  private getLabelAliasMap(): LabelAliasMap {
    return buildLabelAliasMap(this.getLabelRules());
  }

  private persistLabelEditorRules(next: LabelRule[]) {
    this.labelEditorRules = next;
    writeLocalStorage(STORAGE_LABEL_RULES, JSON.stringify(next));
  }

  private updateLabelEditorRule(index: number, patch: Partial<LabelRule>) {
    const next = this.labelEditorRules.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...patch } : rule,
    );
    this.persistLabelEditorRules(next);
  }

  private addLabelEditorRule() {
    this.persistLabelEditorRules([...this.labelEditorRules, { kind: "", id: "", label: "" }]);
  }

  private removeLabelEditorRule(index: number) {
    this.persistLabelEditorRules(this.labelEditorRules.filter((_, ruleIndex) => ruleIndex !== index));
  }

  private resolveAlias(kind: string, id: string, fallback = ""): string {
    const cleanKind = kind.trim().toLowerCase();
    const cleanId = id.trim();
    const cleanFallback = fallback.trim();
    if (!cleanId) {
      return cleanFallback;
    }

    const aliasMap = this.getLabelAliasMap();
    return aliasMap.get(`${cleanKind}:${cleanId}`.toLowerCase()) ?? cleanFallback ?? cleanId;
  }

  private aliasNode(node: GatewayTraceNode | undefined): GatewayTraceNode | undefined {
    if (!node) {
      return undefined;
    }
    return {
      ...node,
      label: this.resolveAlias(String(node.kind), node.id, node.label?.trim() || node.id),
    };
  }

  private aliasEvent(evt: GatewayTraceEvent): GatewayTraceEvent {
    return {
      ...evt,
      from: this.aliasNode(evt.from) ?? evt.from,
      to: this.aliasNode(evt.to) ?? evt.to,
    };
  }

  private formatAliasedChannelIoMeta(evt: GatewayTraceEvent): string[] {
    const data = evt.data ?? {};
    const channelId = readDataString(data, "channelId");
    const chatType = readDataString(data, "chatType");
    const from = readDataString(data, "from");
    const to = readDataString(data, "to");
    const accountId = readDataString(data, "accountId");
    const threadId = readDataString(data, "threadId");
    const sessionLabel = readDataString(data, "sessionLabel");

    const parts: string[] = [];
    if (channelId) parts.push(`渠道：${this.resolveAlias("channel", channelId, channelId)}`);
    if (chatType) parts.push(`会话：${formatChatType(chatType)}`);
    if (from) parts.push(`来自：${from}`);
    if (to) parts.push(`去向：${to}`);
    if (accountId) parts.push(`账号：${this.resolveAlias("account", accountId, accountId)}`);
    if (threadId) parts.push(`线程：${this.resolveAlias("thread", threadId, threadId)}`);
    if (sessionLabel || evt.sessionKey) {
      const base = sessionLabel || evt.sessionKey || "";
      parts.push(`会话名：${this.resolveAlias("session", evt.sessionKey || base, base)}`);
    }
    return parts;
  }

  private latestChannelEvent(kind: "message.in" | "message.out") {
    return this.events
      .filter((evt) => evt.kind === kind)
      .sort((a, b) => b.ts - a.ts)[0];
  }

  private renderBusinessSnapshot(
    title: string,
    kind: "message.in" | "message.out",
    emptyText: string,
  ) {
    const evt = this.latestChannelEvent(kind);
    if (!evt) {
      return html`
        <div class="snapshot-card">
          <div class="snapshot-title">${title}</div>
          <div class="snapshot-empty">${emptyText}</div>
        </div>
      `;
    }

    const data = evt.data ?? {};
    const channelId = readDataString(data, "channelId");
    const sessionKey = (evt.sessionKey || "").trim();
    const sessionLabel = readDataString(data, "sessionLabel") || sessionKey;
    const actor =
      kind === "message.in" ? readDataString(data, "from") || "外部渠道" : readDataString(data, "to") || "外部渠道";

    return html`
      <div class="snapshot-card">
        <div class="snapshot-title">${title}</div>
        <div class="snapshot-time">${formatAbsoluteTime(evt.ts)} · ${formatRelativeTimestamp(evt.ts)}</div>
        <div class="snapshot-content">${formatChannelIoPreview(evt)}</div>
        <div class="snapshot-meta">
          <div><strong>渠道：</strong>${channelId ? this.resolveAlias("channel", channelId, channelId) : "未识别"}</div>
          <div><strong>会话：</strong>${sessionKey ? this.resolveAlias("session", sessionKey, sessionLabel) : "未识别"}</div>
          <div><strong>${kind === "message.in" ? "发送方" : "接收方"}：</strong>${actor || "未识别"}</div>
        </div>
      </div>
    `;
  }

  private renderConnectionPill(): TemplateResult {
    if (this.connected) {
      const version = this.hello?.server?.version;
      return html`<span class="pill ok">已连接${version ? ` · ${version}` : ""}</span>`;
    }
    if (this.lastError) {
      return html`<span class="pill danger">连接异常</span>`;
    }
    return html`<span class="pill warn">未连接</span>`;
  }

  private renderOverviewPanel(filtered: GatewayTraceEvent[]) {
    const inboundCount = filtered.filter((evt) => evt.kind === "message.in").length;
    const outboundCount = filtered.filter((evt) => evt.kind === "message.out").length;
    const activeSessions = new Set(
      filtered.map((evt) => (evt.sessionKey || "").trim()).filter(Boolean),
    ).size;
    const observedChannels = collectObservedChannelIds(this.events);

    const cards = [
      {
        label: `最近 ${formatWindowLabel(this.windowMs)} 入口消息`,
        value: inboundCount,
        sub: "表示进入 OpenClaw 的真实渠道消息数量。",
      },
      {
        label: `最近 ${formatWindowLabel(this.windowMs)} 出口消息`,
        value: outboundCount,
        sub: "表示 OpenClaw 返回给渠道的真实输出数量。",
      },
      {
        label: `最近 ${formatWindowLabel(this.windowMs)} 活跃会话`,
        value: activeSessions,
        sub: "当前窗口内实际发生消息或工具链路的会话数。",
      },
      {
        label: "已观测渠道",
        value: observedChannels.length,
        sub:
          observedChannels.length > 0
            ? `缓存中已看到：${observedChannels
                .slice(0, 4)
                .map((channelId) => this.resolveAlias("channel", channelId, channelId))
                .join("、")}${observedChannels.length > 4 ? "…" : ""}`
            : "暂未从事件中识别到渠道信息。",
      },
    ];

    return html`
      <section class="card">
        <div class="section-head">
          <div>
            <div class="section-title">关键概览</div>
            <div class="section-subtitle">优先展示业务状态，先看消息入口、出口和会话活跃度。</div>
          </div>
          <span class="pill warn">当前窗口：${formatWindowLabel(this.windowMs)}</span>
        </div>
        <div class="stats-grid" style="margin-top: 14px;">
          ${cards.map(
            (card) => html`
              <div class="stat-card">
                <div class="stat-label">${card.label}</div>
                <div class="stat-value">${card.value}</div>
                <div class="stat-sub">${card.sub}</div>
              </div>
            `,
          )}
        </div>
      </section>
    `;
  }

  private renderChannelIoPanel() {
    const channelEvents = this.events.filter(isChannelIoEvent);
    const sessionCards = buildSessionSummaries(channelEvents);

    return html`
      <section class="card">
        <div class="section-head">
          <div>
            <div class="section-title">关键信息</div>
            <div class="section-subtitle">直接看最新入口消息、最新出口消息，以及当前活跃会话。</div>
          </div>
          <span class="pill ok">最近采集：${channelEvents.length} 条业务消息</span>
        </div>

        <div class="snapshot-grid">
          ${this.renderBusinessSnapshot("最新入口消息", "message.in", "还没有收到进入 OpenClaw 的渠道消息。")}
          ${this.renderBusinessSnapshot("最新出口消息", "message.out", "还没有看到 OpenClaw 发回渠道的消息。")}
        </div>

        <div class="io-panel" style="margin-top: 14px;">
          <div class="io-panel-title">
            <span>活跃会话</span>
            <span class="io-age">${sessionCards.length} 个</span>
          </div>
          <div class="io-panel-subtitle">每张卡片代表一个会话，只保留最关键的业务信息。</div>
          <div class="session-card-grid">
            ${sessionCards.length === 0
              ? html`
                  <div class="session-card">
                    <div class="io-panel-subtitle">当前还没有可展示的活跃会话。</div>
                  </div>
                `
              : sessionCards.map((session) => {
                  const aliasedSessionLabel = this.resolveAlias(
                    "session",
                    session.sessionKey,
                    session.sessionLabel || session.sessionKey,
                  );
                  const meta = [
                    session.channelId
                      ? this.resolveAlias("channel", session.channelId, session.channelId)
                      : "",
                    session.chatType ? formatChatType(session.chatType) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return html`
                    <div class="session-card">
                      <div class="session-card-title">${aliasedSessionLabel}</div>
                      <div class="session-card-subtitle">
                        ${meta || "未识别渠道信息"} · ${formatAbsoluteTime(session.updatedAt)} ·
                        ${formatRelativeTimestamp(session.updatedAt)}
                      </div>
                      <div class="session-card-line">
                        <strong>入口：</strong>
                        ${session.inbound ? formatChannelIoPreview(session.inbound) : "暂无"}
                      </div>
                      <div class="session-card-line">
                        <strong>出口：</strong>
                        ${session.outbound ? formatChannelIoPreview(session.outbound) : "暂无"}
                      </div>
                      <div class="session-card-subtitle" style="margin-top: 10px;">ID：${session.sessionKey}</div>
                    </div>
                  `;
                })}
          </div>
        </div>
      </section>
    `;
  }

  private renderGraph(filtered: GatewayTraceEvent[], now: number) {
    const displayFiltered = filtered.map((evt) => this.aliasEvent(evt));
    const { nodes, edges, nodeByKey } = buildGraph(displayFiltered, now);
    const baselineNodeByKey = new Map(BASELINE_GRAPH_NODES.map((node) => [node.key, node]));
    const recentBusiness = displayFiltered
      .filter((evt) => evt.kind === "message.in" || evt.kind === "message.out" || evt.kind.startsWith("tool."))
      .slice(0, 6);
    const activeSessionKeys = new Set(
      filtered
        .map((evt) =>
          evt.sessionKey ? this.resolveAlias("session", evt.sessionKey, evt.sessionKey) : "",
        )
        .filter(Boolean),
    );
    const activeChannelIds = collectObservedChannelIds(filtered).map((channelId) =>
      this.resolveAlias("channel", channelId, channelId),
    );
    const hasRenderableGraph = nodes.length > 0 && edges.length > 0;
    const graphSubtitle =
      filtered.length === 0
        ? "默认先完整陈列链路骨架；一旦有新事件进入，再在对应节点和连线上做动态高亮。"
        : hasRenderableGraph
          ? "新的业务事件会让节点和连线一起高亮，方便快速判断消息从哪里进、往哪里走。"
          : "当前只有零散事件，先显示完整链路骨架；形成真实流转后会在对应路径上动态点亮。";
    const graphPill = hasRenderableGraph
      ? html`<span class="pill warn">${filtered.length} 条事件 · ${nodes.length} 个节点 · ${edges.length} 条连线</span>`
      : html`<span class="pill warn">骨架常显 · 等待实时数据</span>`;

    return html`
      <section class="card">
        <div class="section-head">
          <div>
            <div class="section-title">实时链路图</div>
            <div class="section-subtitle">${graphSubtitle}</div>
          </div>
          ${graphPill}
        </div>

        <div class="graph-shell">
          ${svg`
            <svg
              class="graph-svg"
              viewBox="0 0 ${GRAPH_W} ${GRAPH_H}"
              xmlns="http://www.w3.org/2000/svg"
              role="img"
              aria-label="OpenClaw 实时链路图"
            >
              <defs>
                <linearGradient id="grid-fade" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stop-color="rgba(148, 163, 184, 0.05)" />
                  <stop offset="50%" stop-color="rgba(148, 163, 184, 0.12)" />
                  <stop offset="100%" stop-color="rgba(148, 163, 184, 0.05)" />
                </linearGradient>
              </defs>

              <g opacity="0.18">
                ${[90, 210, 380, 560, 680, 860, 1080, 1190].map(
                  (x) =>
                    svg`<line x1="${x}" y1="28" x2="${x}" y2="${GRAPH_H - 28}" stroke="url(#grid-fade)" stroke-width="1" />`,
                )}
              </g>

              <text class="graph-axis-label" x="90" y="18" text-anchor="middle">入口/客户端</text>
              <text class="graph-axis-label" x="210" y="18" text-anchor="middle">网关</text>
              <text class="graph-axis-label" x="380" y="18" text-anchor="middle">RPC</text>
              <text class="graph-axis-label" x="560" y="18" text-anchor="middle">智能体</text>
              <text class="graph-axis-label" x="680" y="18" text-anchor="middle">工具</text>
              <text class="graph-axis-label" x="860" y="18" text-anchor="middle">会话</text>
              <text class="graph-axis-label" x="1080" y="18" text-anchor="middle">渠道</text>
              <text class="graph-axis-label" x="1190" y="18" text-anchor="middle">设备/其他</text>

              ${BASELINE_GRAPH_EDGES.map((edge) => {
                const from = baselineNodeByKey.get(edge.fromKey);
                const to = baselineNodeByKey.get(edge.toKey);
                if (!from || !to) return nothing;
                return svg`
                  <line
                    class="baseline-edge"
                    x1="${from.x}"
                    y1="${from.y}"
                    x2="${to.x}"
                    y2="${to.y}"
                    stroke="${colorForEventKind(edge.kind)}"
                    stroke-width="2"
                    stroke-dasharray="7 7"
                    stroke-linecap="round"
                  />
                `;
              })}

              ${BASELINE_GRAPH_NODES.map((node) => svg`
                <g class="baseline-node" transform="translate(${node.x}, ${node.y})">
                  <circle
                    r="18"
                    fill="${fillForNodeKind(node.kind)}"
                    stroke="${strokeForNodeKind(node.kind)}"
                    stroke-width="2"
                  />
                  <text class="graph-node-label" text-anchor="middle" y="-2">
                    ${node.label}
                  </text>
                  <text class="graph-node-sub" text-anchor="middle" y="12">
                    ${friendlyNodeKind(node.kind)}
                  </text>
                </g>
              `)}

              ${edges.map((edge) => {
                const from = nodeByKey.get(edge.fromKey);
                const to = nodeByKey.get(edge.toKey);
                if (!from || !to) return nothing;

                const animateAt = edge.lastAnimatedTs ?? edge.lastTs;
                const highlighted = now - animateAt <= GRAPH_HIGHLIGHT_MS;
                const stroke = colorForEventKind(edge.kind);
                const width = clamp(1.6 + Math.log2(edge.count + 1), 1.6, 4.8);
                const path = `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
                const midX = (from.x + to.x) / 2;
                const midY = (from.y + to.y) / 2;
                const labelY = midY + (from.y <= to.y ? -10 : 14);
                const showEdgeLabel =
                  highlighted &&
                  !!edge.label &&
                  (edge.kind === "message.in" ||
                    edge.kind === "message.out" ||
                    edge.kind.startsWith("tool.") ||
                    edge.kind.startsWith("message.chat."));

                return svg`
                  <g>
                    <title>${formatEdgeTitle(edge, from, to)}</title>
                    <line
                      x1="${from.x}"
                      y1="${from.y}"
                      x2="${to.x}"
                      y2="${to.y}"
                      stroke="${stroke}"
                      stroke-width="${width}"
                      stroke-opacity="${highlighted ? "0.88" : "0.26"}"
                      stroke-linecap="round"
                      stroke-dasharray="${highlighted ? "8 6" : "5 7"}"
                    />
                    ${
                      highlighted
                        ? svg`
                            <circle class="edge-dot" r="${Math.max(3, width)}" fill="${stroke}">
                              <animateMotion dur="1.3s" repeatCount="indefinite" path="${path}" />
                            </circle>
                          `
                        : nothing
                    }
                    ${showEdgeLabel
                      ? svg`
                          <text class="graph-edge-label" x="${midX}" y="${labelY}" text-anchor="middle">
                            ${truncateLabel(edge.label ?? "", 14)}
                          </text>
                        `
                      : nothing}
                  </g>
                `;
              })}

              ${nodes.map((node) => {
                const highlighted =
                  node.lastAnimatedTs != null && now - node.lastAnimatedTs <= GRAPH_HIGHLIGHT_MS;
                const radius = clamp(15 + Math.log2(node.activity + 1) * 4, 15, 26);
                return svg`
                  <g transform="translate(${node.x}, ${node.y})">
                    <title>${formatNodeTitle(node)}</title>
                    ${
                      highlighted
                        ? svg`
                            <circle r="${radius + 8}" fill="${strokeForNodeKind(node.kind)}" opacity="0.12">
                              <animate attributeName="r" values="${radius + 6};${radius + 10};${radius + 6}" dur="1.3s" repeatCount="indefinite" />
                              <animate attributeName="opacity" values="0.10;0.20;0.10" dur="1.3s" repeatCount="indefinite" />
                            </circle>
                          `
                        : nothing
                    }
                    <circle
                      r="${radius}"
                      fill="${fillForNodeKind(node.kind)}"
                      stroke="${strokeForNodeKind(node.kind)}"
                      stroke-width="${highlighted ? 3.2 : 2.4}"
                      opacity="${highlighted ? "0.96" : "0.9"}"
                    />
                    <text class="graph-node-label" text-anchor="middle" y="-2">
                      ${truncateLabel(node.label, graphLabelLimitByKind(node.kind))}
                    </text>
                  </g>
                `;
              })}
            </svg>
          `}
        </div>

        <div class="graph-summary">
          <div class="summary-box">
            <div class="summary-box-title">最近高亮链路</div>
            <ul class="summary-list">
              ${recentBusiness.length === 0
                ? html`<li class="summary-item">当前窗口里还没有业务链路。</li>`
                : recentBusiness.map((evt) => html`
                    <li class="summary-item">
                      ${friendlyEventKind(evt.kind)}：${formatNodeLabel(evt.from)}
                      → ${formatNodeLabel(evt.to)}
                    </li>
                  `)}
            </ul>
          </div>

          <div class="summary-box">
            <div class="summary-box-title">当前活跃会话</div>
            <ul class="summary-list">
              ${activeSessionKeys.size === 0
                ? html`<li class="summary-item">没有会话事件。</li>`
                : [...activeSessionKeys]
                    .slice(0, 6)
                    .map((sessionKey) => html`<li class="summary-item">${sessionKey}</li>`)}
            </ul>
          </div>

          <div class="summary-box">
            <div class="summary-box-title">当前涉及渠道</div>
            <ul class="summary-list">
              ${activeChannelIds.length === 0
                ? html`<li class="summary-item">当前窗口未识别到渠道。</li>`
                : activeChannelIds.slice(0, 6).map((channelId) => html`<li class="summary-item">${channelId}</li>`)}
            </ul>
          </div>
        </div>
      </section>
    `;
  }

  private renderEventsList(filtered: GatewayTraceEvent[]) {
    const rows = filtered.slice(0, this.eventListLimit);
    if (rows.length === 0) {
      return html`<div class="graph-empty">当前窗口内没有可显示的事件。</div>`;
    }

    return html`
      <div class="events">
        ${rows.map((evt) => {
          const aliasedEvt = this.aliasEvent(evt);
          const label = typeof evt.label === "string" ? evt.label.trim() : "";
          const summary = formatEventSummary(evt);
          const metaParts: string[] = [];
          if (evt.sessionKey) metaParts.push(`session=${evt.sessionKey}`);
          if (evt.runId) metaParts.push(`runId=${evt.runId}`);
          const meta = metaParts.join(" · ");
          return html`
            <div class="event-row">
              <div class="event-top">
                <div class="event-kind">${friendlyEventKind(evt.kind)}</div>
                <div class="event-age">${formatAbsoluteTime(evt.ts)} · ${formatRelativeTimestamp(evt.ts)}</div>
              </div>
              <div class="event-route">
                <span>${formatNodeLabel(aliasedEvt.from)}</span>
                <span class="event-arrow">→</span>
                <span>${formatNodeLabel(aliasedEvt.to)}</span>
                ${label ? html`<span class="event-arrow">·</span><span>${label}</span>` : nothing}
              </div>
              ${summary ? html`<div class="event-body">${summary}</div>` : nothing}
              ${meta ? html`<div class="event-meta">${meta}</div>` : nothing}
              ${evt.data
                ? html`
                    <details class="event-details">
                      <summary>技术详情</summary>
                      <pre>${safeJson(evt.data)}</pre>
                    </details>
                  `
                : nothing}
            </div>
          `;
        })}
      </div>
    `;
  }

  render() {
    const { now, filtered } = this.filteredEvents();
    const windowOptions = [
      { label: "5 秒", ms: 5_000 },
      { label: "15 秒", ms: 15_000 },
      { label: "30 秒", ms: 30_000 },
      { label: "1 分钟", ms: 60_000 },
      { label: "5 分钟", ms: 5 * 60_000 },
    ];

    return html`
      <div class="page">
        <section class="header">
          <div>
            <div class="title">OpenClaw 网关路由看板</div>
            <div class="sub">
              先看业务，再看技术。上面优先显示消息入口、消息出口、会话摘要和实时链路；底部技术事件默认折叠。
            </div>
          </div>
          <div class="top-actions">
            <button class="btn" @click=${() => this.toggleTheme()}>
              主题：${this.theme === "dark" ? "柔和深色" : "浅色"}
            </button>
          </div>
        </section>

        <section class="card">
          <div class="toolbar">
            <label class="toolbar-main">
              网关地址或观察器地址
              <input
                .value=${this.gatewayUrl}
                @input=${(e: Event) => (this.gatewayUrl = (e.target as HTMLInputElement).value)}
                placeholder="例如：http://127.0.0.1:17777 或 ws://127.0.0.1:18789"
                spellcheck="false"
              />
            </label>
            <div class="toolbar-actions">
              ${
                this.connected
                  ? html`<button class="btn danger" @click=${() => this.disconnect()}>断开</button>`
                  : html`
                      <button
                        class="btn primary"
                        @click=${() => (this.isObserverMode() ? this.connectObserver() : this.connect())}
                      >
                        连接
                      </button>
                    `
              }
              <button class="btn" @click=${() => (this.paused = !this.paused)}>
                ${this.paused ? "继续采集" : "暂停采集"}
              </button>
              <button class="btn danger" @click=${() => this.resetEvents()}>清空缓存</button>
            </div>
            <div class="row toolbar-status">
              <div class="toolbar-status-left">
                ${this.renderConnectionPill()}
                ${this.paused ? html`<span class="pill warn">已暂停采集</span>` : nothing}
              </div>
              <div class="toolbar-status-right">
                <span class="toolbar-tip">驾驶舱主视图会固定显示在下方，方便持续盯看链路变化。</span>
              </div>
            </div>
          </div>

          ${this.lastError
            ? html`
                <div class="error-box">
                  <div><strong>连接提示：</strong>${this.lastError}</div>
                  ${this.lastErrorRaw
                    ? html`
                        <details class="event-details">
                          <summary>查看技术详情</summary>
                          <pre>${this.lastErrorRaw}</pre>
                        </details>
                      `
                    : nothing}
                </div>
              `
            : nothing}

        </section>

        ${this.renderGraph(filtered, now)}
        ${this.renderOverviewPanel(filtered)}
        ${this.renderChannelIoPanel()}

        <section class="card">
          <details style="margin-top: 0;">
            <summary>高级设置</summary>
            <div class="sub" style="margin-top: 8px;">
              这里放过滤、认证、健康探测等技术选项，默认折叠，避免影响业务观察。
            </div>
            <div class="advanced-grid">
              <label>
                Token
                <input
                  type="password"
                  .value=${this.token}
                  @input=${(e: Event) => (this.token = (e.target as HTMLInputElement).value)}
                  placeholder="可选：operator token"
                  spellcheck="false"
                />
              </label>

              <label>
                密码
                <input
                  type="password"
                  .value=${this.password}
                  @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)}
                  placeholder="可选：网关密码"
                  spellcheck="false"
                />
              </label>

              <label>
                查看范围
                <select
                  .value=${this.scope}
                  @change=${(e: Event) =>
                    (this.scope = (e.target as HTMLSelectElement).value as "all" | "session")}
                >
                  <option value="all">全部会话</option>
                  <option value="session">指定会话</option>
                </select>
              </label>

              <label>
                指定 sessionKey
                <input
                  .value=${this.sessionKey}
                  @input=${(e: Event) => (this.sessionKey = (e.target as HTMLInputElement).value)}
                  placeholder="仅在“指定会话”时生效"
                  spellcheck="false"
                />
              </label>

              <label>
                时间窗口
                <select
                  .value=${String(this.windowMs)}
                  @change=${(e: Event) => (this.windowMs = Number((e.target as HTMLSelectElement).value))}
                >
                  ${windowOptions.map((option) => html`<option value=${String(option.ms)}>${option.label}</option>`)}
                </select>
              </label>

              <label>
                事件列表条数
                <select
                  .value=${String(this.eventListLimit)}
                  @change=${(e: Event) => {
                    const value = Number((e.target as HTMLSelectElement).value);
                    this.eventListLimit = value;
                    writeLocalStorage(STORAGE_LIST_LIMIT, String(value));
                  }}
                >
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="200">200</option>
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                </select>
              </label>

              <label class="inline-check">
                <input
                  type="checkbox"
                  .checked=${this.autoHealth}
                  @change=${(e: Event) => this.setAutoHealth((e.target as HTMLInputElement).checked)}
                />
                每 5 秒自动做一次健康检查
              </label>

              <div class="action-slot">
                <button class="btn" ?disabled=${!this.connected} @click=${() => void this.requestHealth()}>
                  立即健康检查
                </button>
              </div>

              <label class="full-span">
                标签规则
                <div class="rule-help">
                  只支持最新规则：每条规则都必须填写“类型 / 原始ID / 中文名”。不兼容旧写法，也不做兜底匹配。
                </div>
                <div class="rule-editor">
                  <div class="rule-preview-header">
                    <span>已解析规则：${this.getLabelRules().length} 条</span>
                    <span class="toolbar-tip">保存在当前浏览器，填写后立即生效，图、会话卡、事件路线会直接用中文名。</span>
                  </div>
                  <div class="rule-list">
                    <div class="rule-table-head">
                      <div>类型</div>
                      <div>原始ID</div>
                      <div>中文名</div>
                      <div>操作</div>
                    </div>
                    ${this.labelEditorRules.length === 0
                      ? html`<div class="rule-empty">
                          还没有规则。点击“新增规则”后，直接填写类型、原始 ID 和中文名即可。
                        </div>`
                      : this.labelEditorRules.map(
                          (rule, index) => html`
                            <div class="rule-editor-row">
                              <input
                                list="label-rule-kind-options"
                                .value=${rule.kind}
                                @input=${(e: Event) =>
                                  this.updateLabelEditorRule(index, {
                                    kind: (e.target as HTMLInputElement).value,
                                  })}
                                placeholder="例如 channel"
                                spellcheck="false"
                              />
                              <input
                                .value=${rule.id}
                                @input=${(e: Event) =>
                                  this.updateLabelEditorRule(index, {
                                    id: (e.target as HTMLInputElement).value,
                                  })}
                                placeholder="例如 feishu"
                                spellcheck="false"
                              />
                              <input
                                .value=${rule.label}
                                @input=${(e: Event) =>
                                  this.updateLabelEditorRule(index, {
                                    label: (e.target as HTMLInputElement).value,
                                  })}
                                placeholder="例如 飞书渠道"
                                spellcheck="false"
                              />
                              <button
                                type="button"
                                class="btn danger compact"
                                @click=${() => this.removeLabelEditorRule(index)}
                              >
                                删除
                              </button>
                            </div>
                          `,
                        )}
                  </div>
                  <div class="rule-actions">
                    <button type="button" class="btn compact" @click=${() => this.addLabelEditorRule()}>
                      新增规则
                    </button>
                    <span class="toolbar-tip">
                      建议优先填写 channel、session、agent、tool、account、thread 等业务对象。
                    </span>
                  </div>
                </div>
                <datalist id="label-rule-kind-options">
                  <option value="channel"></option>
                  <option value="session"></option>
                  <option value="agent"></option>
                  <option value="tool"></option>
                  <option value="account"></option>
                  <option value="thread"></option>
                  <option value="client"></option>
                  <option value="gateway"></option>
                  <option value="rpc"></option>
                  <option value="node"></option>
                </datalist>
              </label>
            </div>

            <div class="row" style="margin-top: 12px;">
              <label class="row">
                <input
                  style="width: auto;"
                  type="checkbox"
                  .checked=${this.filters.rpc}
                  @change=${(e: Event) =>
                    (this.filters = { ...this.filters, rpc: (e.target as HTMLInputElement).checked })}
                />
                显示 RPC
              </label>
              <label class="row">
                <input
                  style="width: auto;"
                  type="checkbox"
                  .checked=${this.filters.messages}
                  @change=${(e: Event) =>
                    (this.filters = { ...this.filters, messages: (e.target as HTMLInputElement).checked })}
                />
                显示消息
              </label>
              <label class="row">
                <input
                  style="width: auto;"
                  type="checkbox"
                  .checked=${this.filters.tools}
                  @change=${(e: Event) =>
                    (this.filters = { ...this.filters, tools: (e.target as HTMLInputElement).checked })}
                />
                显示工具
              </label>
            </div>
          </details>
        </section>

        <section class="card">
          <details>
            <summary>技术事件明细</summary>
            <div class="section-subtitle" style="margin-top: 8px;">
              这里保留完整的技术视角，便于排障或核对采集结果；平时验收时可以不用一直展开。
            </div>
            ${this.renderEventsList(filtered)}
          </details>
        </section>
      </div>
    `;
  }
}

if (!customElements.get("routing-graph-app")) {
  customElements.define("routing-graph-app", RoutingGraphApp);
}
