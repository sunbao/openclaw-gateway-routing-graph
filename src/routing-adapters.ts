import type { GatewayEventFrame } from "./gateway-client.ts";
import type { GatewayTraceEvent } from "./routing-types.ts";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildSyntheticId(parts: string[]) {
  const safe = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("_");
  return `viz_trace_${safe || "event"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function extractTs(payload: Record<string, unknown>): number {
  const direct = payload.ts;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  const legacy = payload.createdAtMs;
  if (typeof legacy === "number" && Number.isFinite(legacy)) {
    return legacy;
  }
  return Date.now();
}

function countKeys(value: unknown): number {
  if (!value) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length;
  }
  return 0;
}

function extractTsFromUnknown(payload: unknown): number {
  if (!isRecord(payload)) {
    return Date.now();
  }
  return extractTs(payload);
}

function traceFromAgentToolEvent(payload: unknown): GatewayTraceEvent[] {
  if (!isRecord(payload)) {
    return [];
  }
  const stream = normalizeText(payload.stream);
  if (stream !== "tool") {
    return [];
  }

  const runId = normalizeText(payload.runId);
  const ts = typeof payload.ts === "number" && Number.isFinite(payload.ts) ? payload.ts : Date.now();
  const sessionKey =
    normalizeText(payload.sessionKey) ||
    (isRecord(payload.data) ? normalizeText(payload.data.sessionKey) : "");
  const data = isRecord(payload.data) ? payload.data : {};

  const phase = normalizeText(data.phase);
  if (phase !== "start" && phase !== "result") {
    return [];
  }
  const name = normalizeText(data.name);
  if (!name) {
    return [];
  }
  const toolCallId = normalizeText(data.toolCallId);

  const sessionNode =
    sessionKey !== ""
      ? { kind: "session" as const, id: sessionKey, label: sessionKey }
      : runId
        ? { kind: "agent" as const, id: runId, label: runId }
        : { kind: "gateway" as const, id: "gateway", label: "gateway" };
  const toolNode = { kind: "tool" as const, id: name, label: name };

  const base = {
    ts,
    runId: runId || undefined,
    sessionKey: sessionKey || undefined,
    data: { toolCallId, name },
  };

  if (phase === "start") {
    return [
      {
        id: buildSyntheticId(["tool", "start", runId, toolCallId, String(ts)]),
        kind: "tool.start",
        from: sessionNode,
        to: toolNode,
        label: toolCallId || undefined,
        ...base,
      },
    ];
  }

  return [
    {
      id: buildSyntheticId(["tool", "result", runId, toolCallId, String(ts)]),
      kind: "tool.result",
      from: toolNode,
      to: sessionNode,
      label: toolCallId || undefined,
      ...base,
    },
  ];
}

function traceFromTickEvent(payload: unknown): GatewayTraceEvent[] {
  const ts = extractTsFromUnknown(payload);
  return [
    {
      id: buildSyntheticId(["tick", String(ts)]),
      ts,
      kind: "rpc.tick",
      from: { kind: "gateway", id: "gateway", label: "gateway" },
      to: { kind: "rpc", id: "tick", label: "tick" },
    },
  ];
}

function traceFromHeartbeatEvent(payload: unknown): GatewayTraceEvent[] {
  const ts = extractTsFromUnknown(payload);
  return [
    {
      id: buildSyntheticId(["heartbeat", String(ts)]),
      ts,
      kind: "rpc.heartbeat",
      from: { kind: "gateway", id: "gateway", label: "gateway" },
      to: { kind: "rpc", id: "heartbeat", label: "heartbeat" },
    },
  ];
}

function traceFromHealthEvent(payload: unknown): GatewayTraceEvent[] {
  if (!isRecord(payload)) {
    return [];
  }

  const ts = extractTs(payload);
  const channelCount = countKeys(payload.channels);
  const sessionCount = countKeys(payload.sessions);
  const agentCount = countKeys(payload.agents);

  const labelParts = [];
  if (channelCount) labelParts.push(`${channelCount} channels`);
  if (sessionCount) labelParts.push(`${sessionCount} sessions`);
  if (agentCount) labelParts.push(`${agentCount} agents`);
  const label = labelParts.length ? labelParts.join(", ") : undefined;

  return [
    {
      id: buildSyntheticId(["health", String(ts)]),
      ts,
      kind: "rpc.health",
      from: { kind: "gateway", id: "gateway", label: "gateway" },
      to: { kind: "rpc", id: "health", label: "health" },
      ...(label ? { label } : {}),
      data: { channelCount, sessionCount, agentCount },
    },
  ];
}

function traceFromChatEvent(payload: unknown): GatewayTraceEvent[] {
  if (!isRecord(payload)) {
    return [];
  }
  const runId = normalizeText(payload.runId);
  const sessionKey = normalizeText(payload.sessionKey);
  if (!runId || !sessionKey) {
    return [];
  }

  const state = normalizeText(payload.state) || "event";
  const ts = extractTs(payload);
  const seq = typeof payload.seq === "number" && Number.isFinite(payload.seq) ? payload.seq : null;

  const from = { kind: "agent" as const, id: runId, label: runId };
  const to = { kind: "session" as const, id: sessionKey, label: sessionKey };

  const kind = `message.chat.${state}`;
  const label = seq !== null ? `#${seq}` : undefined;

  const data: Record<string, unknown> = { state };
  if (typeof payload.stopReason === "string" && payload.stopReason.trim()) {
    data.stopReason = payload.stopReason.trim();
  }
  if (typeof payload.errorMessage === "string" && payload.errorMessage.trim()) {
    data.error = payload.errorMessage.trim().slice(0, 120);
  }

  // Avoid attaching full `message` bodies (can be large or sensitive).
  const hasMessage = payload.message !== undefined;
  if (hasMessage) {
    data.hasMessage = true;
  }

  return [
    {
      id: buildSyntheticId(["chat", state, runId, seq !== null ? String(seq) : "", String(ts)]),
      ts,
      kind,
      from,
      to,
      ...(label ? { label } : {}),
      sessionKey,
      runId,
      data,
    },
  ];
}

function traceFromNodeInvokeRequestEvent(payload: unknown): GatewayTraceEvent[] {
  if (!isRecord(payload)) {
    return [];
  }
  const id = normalizeText(payload.id);
  const nodeId = normalizeText(payload.nodeId);
  const command = normalizeText(payload.command);
  if (!nodeId || !command) {
    return [];
  }
  const ts = extractTs(payload);
  return [
    {
      id: buildSyntheticId(["node", "invoke", id || command, nodeId, String(ts)]),
      ts,
      kind: "rpc.node.invoke.request",
      from: { kind: "rpc", id: "node.invoke", label: "node.invoke" },
      to: { kind: "node", id: nodeId, label: nodeId },
      label: command,
      runId: id || undefined,
      data: { command },
    },
  ];
}

function traceFromExecApprovalEvent(event: string, payload: unknown): GatewayTraceEvent[] {
  if (!isRecord(payload)) {
    return [];
  }

  const id = normalizeText(payload.id);
  const request = isRecord(payload.request) ? payload.request : null;
  const sessionKey = request ? normalizeText(request.sessionKey) : "";
  const agentId = request ? normalizeText(request.agentId) : "";
  const command = request ? normalizeText(request.command) : "";
  const decision = normalizeText(payload.decision);

  const ts = extractTs(payload);
  const originNode =
    sessionKey !== ""
      ? { kind: "session" as const, id: sessionKey, label: sessionKey }
      : agentId !== ""
        ? { kind: "agent" as const, id: agentId, label: agentId }
        : { kind: "gateway" as const, id: "gateway", label: "gateway" };

  const approvalNode = { kind: "rpc" as const, id: "exec.approval", label: "exec.approval" };

  const kind = event === "exec.approval.resolved" ? "rpc.exec.approval.resolved" : "rpc.exec.approval.requested";
  const labelParts = [];
  if (command) labelParts.push(command);
  if (decision) labelParts.push(`decision=${decision}`);
  const label = labelParts.length ? labelParts.join(" ") : undefined;

  const from = event === "exec.approval.resolved" ? approvalNode : originNode;
  const to = event === "exec.approval.resolved" ? originNode : approvalNode;

  return [
    {
      id: buildSyntheticId(["exec", "approval", event, id, String(ts)]),
      ts,
      kind,
      from,
      to,
      ...(label ? { label } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(id ? { runId: id } : {}),
      data: {
        id: id || undefined,
        decision: decision || undefined,
        hasRequest: Boolean(request),
      },
    },
  ];
}

export function traceEventsFromGatewayEvent(evt: GatewayEventFrame): GatewayTraceEvent[] {
  if (evt.event === "trace") {
    return evt.payload ? [evt.payload as GatewayTraceEvent] : [];
  }
  if (evt.event === "agent") {
    return traceFromAgentToolEvent(evt.payload);
  }
  if (evt.event === "tick") {
    return traceFromTickEvent(evt.payload);
  }
  if (evt.event === "heartbeat") {
    return traceFromHeartbeatEvent(evt.payload);
  }
  if (evt.event === "chat") {
    return traceFromChatEvent(evt.payload);
  }
  if (evt.event === "health") {
    return traceFromHealthEvent(evt.payload);
  }
  if (evt.event === "node.invoke.request") {
    return traceFromNodeInvokeRequestEvent(evt.payload);
  }
  if (evt.event === "exec.approval.requested" || evt.event === "exec.approval.resolved") {
    return traceFromExecApprovalEvent(evt.event, evt.payload);
  }
  return [];
}
