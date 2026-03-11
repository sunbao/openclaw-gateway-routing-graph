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

export function traceEventsFromGatewayEvent(evt: GatewayEventFrame): GatewayTraceEvent[] {
  if (evt.event === "trace") {
    return evt.payload ? [evt.payload as GatewayTraceEvent] : [];
  }
  if (evt.event === "agent") {
    return traceFromAgentToolEvent(evt.payload);
  }
  return [];
}

