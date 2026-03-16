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

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncateText(value: string, max = 180) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function extractMessagePreview(message: unknown): string {
  if (typeof message === "string") {
    return truncateText(message, 180);
  }
  if (!isRecord(message)) {
    return "";
  }

  const direct = [message.text, message.content, message.preview]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);
  if (direct) {
    return truncateText(direct, 180);
  }

  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (isRecord(part) && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
  return text ? truncateText(text, 180) : "";
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
  const channels = isRecord(payload.channels) ? payload.channels : {};
  const sessions = isRecord(payload.sessions) ? payload.sessions : {};
  const agentsRaw = Array.isArray(payload.agents) ? payload.agents : [];
  const channelCount = Array.isArray(payload.channelOrder)
    ? payload.channelOrder.filter((value) => typeof value === "string" && value.trim()).length
    : countKeys(channels);
  const sessionCount =
    readFiniteNumber(sessions.count) ??
    (Array.isArray(sessions.recent) ? sessions.recent.length : countKeys(sessions));
  const agentCount = agentsRaw.length;
  const durationMs = readFiniteNumber(payload.durationMs);
  const heartbeatSeconds = readFiniteNumber(payload.heartbeatSeconds);
  const defaultAgentId = normalizeText(payload.defaultAgentId);
  const channelLabels = isRecord(payload.channelLabels) ? payload.channelLabels : {};

  const channelIdsRaw = Array.isArray(payload.channelOrder) ? payload.channelOrder : Object.keys(channels);
  const channelIds = channelIdsRaw
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
  const channelIdsPreview = channelIds.slice(0, 20);
  const channelNames = channelIdsPreview.map((channelId) => {
    const label = normalizeText(channelLabels[channelId]);
    return label ? `${channelId}(${label})` : channelId;
  });
  const sessionsRecent = Array.isArray(sessions.recent) ? sessions.recent : [];
  const sessionKeys = sessionsRecent
    .map((entry) => (isRecord(entry) ? normalizeText(entry.key) : ""))
    .filter(Boolean)
    .slice(0, 8);
  const agentIds = agentsRaw
    .map((entry) => (isRecord(entry) ? normalizeText(entry.agentId) : ""))
    .filter(Boolean)
    .slice(0, 8);

  const labelParts = [];
  if (channelCount) labelParts.push(`${channelCount} channels`);
  if (sessionCount) labelParts.push(`${sessionCount} sessions`);
  if (agentCount) labelParts.push(`${agentCount} agents`);
  const label = labelParts.length ? labelParts.join(", ") : undefined;
  const events: GatewayTraceEvent[] = [
    {
      id: buildSyntheticId(["health", String(ts)]),
      ts,
      kind: "rpc.health",
      from: { kind: "gateway", id: "gateway", label: "gateway" },
      to: { kind: "rpc", id: "health", label: "health" },
      ...(label ? { label } : {}),
      data: {
        channelCount,
        sessionCount,
        agentCount,
        durationMs,
        heartbeatSeconds,
        defaultAgentId: defaultAgentId || undefined,
        channelIds: channelIdsPreview,
        channelNames,
        channelIdsTruncated:
          channelIds.length > channelIdsPreview.length ? channelIds.length - channelIdsPreview.length : 0,
        sessionKeys,
        agentIds,
      },
    },
  ];

  const gatewayNode = { kind: "gateway" as const, id: "gateway", label: "gateway" };
  for (const channelId of channelIds.slice(0, 16)) {
    const summary = isRecord(channels[channelId]) ? channels[channelId] : {};
    const channelName = normalizeText(channelLabels[channelId]) || channelId;
    const accounts = isRecord(summary.accounts) ? summary.accounts : {};
    const accountIds = Object.keys(accounts).filter(Boolean);
    const configured = readBoolean(summary.configured);
    const linked = readBoolean(summary.linked);
    const accountCount = accountIds.length || (normalizeText(summary.accountId) ? 1 : 0);
    const channelLabelParts = [];
    if (channelName !== channelId) channelLabelParts.push(channelName);
    if (configured !== undefined) channelLabelParts.push(configured ? "configured" : "not configured");
    if (linked !== undefined) channelLabelParts.push(linked ? "linked" : "not linked");
    if (accountCount > 0) channelLabelParts.push(`${accountCount} accounts`);

    events.push({
      id: buildSyntheticId(["health", "channel", channelId, String(ts)]),
      ts,
      kind: "health.channel",
      from: gatewayNode,
      to: { kind: "channel", id: channelId, label: channelName },
      label: channelLabelParts.length ? channelLabelParts.join(" · ") : undefined,
      data: {
        channelId,
        channelName,
        configured,
        linked,
        accountCount,
        accountIds: accountIds.slice(0, 8),
        selectedAccountId: normalizeText(summary.accountId) || undefined,
        lastProbeAt: readFiniteNumber(summary.lastProbeAt),
      },
    });
  }

  const agentEntries = [...agentsRaw];
  if (
    defaultAgentId &&
    !agentEntries.some((entry) => isRecord(entry) && normalizeText(entry.agentId) === defaultAgentId)
  ) {
    agentEntries.unshift({ agentId: defaultAgentId, isDefault: true, sessions });
  }

  let sessionEdgeCount = 0;
  for (const entry of agentEntries.slice(0, 12)) {
    if (!isRecord(entry)) {
      continue;
    }
    const agentId = normalizeText(entry.agentId);
    if (!agentId) {
      continue;
    }
    const agentName = normalizeText(entry.name);
    const heartbeat = isRecord(entry.heartbeat) ? entry.heartbeat : {};
    const agentSessions = isRecord(entry.sessions) ? entry.sessions : {};
    const recentSessions = Array.isArray(agentSessions.recent) ? agentSessions.recent : [];
    const heartbeatEveryMs = readFiniteNumber(heartbeat.everyMs);
    const agentSessionCount = readFiniteNumber(agentSessions.count) ?? recentSessions.length;
    const isDefault =
      readBoolean(entry.isDefault) === true || (defaultAgentId !== "" && agentId === defaultAgentId);
    const recentSessionKeys = recentSessions
      .map((sessionEntry) => (isRecord(sessionEntry) ? normalizeText(sessionEntry.key) : ""))
      .filter(Boolean)
      .slice(0, 8);
    const agentLabelParts = [];
    if (isDefault) agentLabelParts.push("default");
    if (heartbeatEveryMs !== undefined && heartbeatEveryMs > 0) {
      agentLabelParts.push(`heartbeat ${Math.round(heartbeatEveryMs / 1000)}s`);
    }
    if (agentSessionCount > 0) agentLabelParts.push(`${agentSessionCount} sessions`);

    events.push({
      id: buildSyntheticId(["health", "agent", agentId, String(ts)]),
      ts,
      kind: "health.agent",
      from: gatewayNode,
      to: {
        kind: "agent",
        id: agentId,
        label: agentName ? `${agentName} (${agentId})` : agentId,
      },
      label: agentLabelParts.length ? agentLabelParts.join(" · ") : undefined,
      data: {
        agentId,
        agentName: agentName || undefined,
        isDefault,
        heartbeatEveryMs,
        sessionCount: agentSessionCount,
        sessionPath: normalizeText(agentSessions.path) || undefined,
        recentSessionKeys,
      },
    });

    for (const sessionEntry of recentSessions.slice(0, 6)) {
      if (!isRecord(sessionEntry)) {
        continue;
      }
      const sessionKey = normalizeText(sessionEntry.key);
      if (!sessionKey) {
        continue;
      }
      const ageMs = readFiniteNumber(sessionEntry.age);
      const updatedAt = readFiniteNumber(sessionEntry.updatedAt);
      const sessionLabel =
        ageMs !== undefined
          ? ageMs < 60_000
            ? `${Math.max(1, Math.round(ageMs / 1000))}s ago`
            : ageMs < 3_600_000
              ? `${Math.max(1, Math.round(ageMs / 60_000))}m ago`
              : ageMs < 86_400_000
                ? `${Math.max(1, Math.round(ageMs / 3_600_000))}h ago`
                : `${Math.max(1, Math.round(ageMs / 86_400_000))}d ago`
          : undefined;

      events.push({
        id: buildSyntheticId(["health", "session", agentId, sessionKey, String(ts)]),
        ts,
        kind: "health.session",
        from: {
          kind: "agent",
          id: agentId,
          label: agentName ? `${agentName} (${agentId})` : agentId,
        },
        to: { kind: "session", id: sessionKey, label: sessionKey },
        label: sessionLabel,
        sessionKey,
        runId: agentId,
        data: {
          agentId,
          sessionKey,
          updatedAt,
          ageMs,
        },
      });
      sessionEdgeCount += 1;
      if (sessionEdgeCount >= 24) {
        return events;
      }
    }
  }

  return events;
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
  if (seq !== null) {
    data.seq = seq;
  }
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
  const messagePreview = extractMessagePreview(payload.message);
  if (messagePreview) {
    data.messagePreview = messagePreview;
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
      data: { nodeId, command },
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
        agentId: agentId || undefined,
        sessionKey: sessionKey || undefined,
        command: command ? command.slice(0, 180) : undefined,
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
