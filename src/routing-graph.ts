import type { GatewayTraceEvent, GatewayTraceNode, RoutingFilters } from "./routing-types.ts";

export const GRAPH_W = 920;
export const GRAPH_H = 420;
export const GRAPH_PAD = 40;
export const EDGE_LIMIT = 120;

export type GraphNode = {
  key: string;
  kind: string;
  id: string;
  label: string;
  lastTs: number;
  activity: number;
  x: number;
  y: number;
};

export type GraphEdge = {
  key: string;
  kind: string;
  label: string | null;
  fromKey: string;
  toKey: string;
  count: number;
  lastTs: number;
};

function normalizeNodeLabel(node: GatewayTraceNode): string {
  const label = typeof node.label === "string" ? node.label.trim() : "";
  return label || node.id;
}

function nodeKey(node: GatewayTraceNode): string {
  return `${String(node.kind)}:${node.id}`;
}

function isRpcKind(kind: string): boolean {
  return kind.startsWith("rpc.");
}

function isMessageKind(kind: string): boolean {
  return kind.startsWith("message.");
}

function isToolKind(kind: string): boolean {
  return kind.startsWith("tool.");
}

export function shouldIncludeEvent(evt: GatewayTraceEvent, filters: RoutingFilters): boolean {
  if (isRpcKind(evt.kind)) {
    return filters.rpc;
  }
  if (isMessageKind(evt.kind)) {
    return filters.messages;
  }
  if (isToolKind(evt.kind)) {
    return filters.tools;
  }
  return true;
}

function resolveNodeGroup(kind: string): string {
  if (kind === "client") return "client";
  if (kind === "rpc") return "rpc";
  if (kind === "channel") return "channel";
  if (kind === "tool") return "tool";
  if (kind === "session" || kind === "agent" || kind === "gateway") return "session";
  if (kind === "node") return "node";
  return "other";
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function layoutNodes(nodes: Array<Omit<GraphNode, "x" | "y">>) {
  const groups = new Map<string, Array<Omit<GraphNode, "x" | "y">>>();
  for (const node of nodes) {
    const group = resolveNodeGroup(node.kind);
    const existing = groups.get(group) ?? [];
    existing.push(node);
    groups.set(group, existing);
  }

  const xByGroup: Record<string, number> = {
    client: 100,
    rpc: 290,
    session: 480,
    tool: 480,
    channel: 670,
    node: 850,
    other: 480,
  };

  const yRanges: Record<string, { top: number; bottom: number }> = {
    client: { top: GRAPH_PAD, bottom: GRAPH_H - GRAPH_PAD },
    rpc: { top: GRAPH_PAD, bottom: GRAPH_H - GRAPH_PAD },
    channel: { top: GRAPH_PAD, bottom: GRAPH_H - GRAPH_PAD },
    node: { top: GRAPH_PAD, bottom: GRAPH_H - GRAPH_PAD },
    session: { top: GRAPH_PAD, bottom: GRAPH_H * 0.55 },
    tool: { top: GRAPH_H * 0.62, bottom: GRAPH_H - GRAPH_PAD },
    other: { top: GRAPH_PAD, bottom: GRAPH_H - GRAPH_PAD },
  };

  const positions = new Map<string, { x: number; y: number }>();
  for (const [group, listRaw] of groups.entries()) {
    const list = [...listRaw].sort((a, b) => a.label.localeCompare(b.label));
    const x = xByGroup[group] ?? GRAPH_W / 2;
    const range = yRanges[group] ?? { top: GRAPH_PAD, bottom: GRAPH_H - GRAPH_PAD };
    const top = range.top;
    const bottom = Math.max(range.bottom, top);
    for (let i = 0; i < list.length; i++) {
      const t = list.length === 1 ? 0.5 : i / (list.length - 1);
      const y = top + t * (bottom - top);
      positions.set(list[i].key, { x, y });
    }
  }
  return positions;
}

export function buildGraph(events: GatewayTraceEvent[], now: number) {
  const nodes = new Map<string, Omit<GraphNode, "x" | "y">>();
  const edges = new Map<string, GraphEdge>();

  for (const evt of events) {
    const from = evt.from;
    const to = evt.to;
    if (!from || !to) continue;

    const ts = typeof evt.ts === "number" && Number.isFinite(evt.ts) ? evt.ts : now;
    const fromKey = nodeKey(from);
    const toKey = nodeKey(to);

    const upsertNode = (node: GatewayTraceNode, key: string) => {
      const existing = nodes.get(key);
      if (!existing) {
        nodes.set(key, {
          key,
          kind: String(node.kind),
          id: node.id,
          label: normalizeNodeLabel(node),
          lastTs: ts,
          activity: 1,
        });
        return;
      }
      existing.activity += 1;
      if (ts > existing.lastTs) {
        existing.lastTs = ts;
      }
    };
    upsertNode(from, fromKey);
    upsertNode(to, toKey);

    const edgeKind = evt.kind;
    const edgeLabel =
      typeof evt.label === "string" && evt.label.trim() ? evt.label.trim() : null;
    const edgeKey = `${fromKey}->${toKey}:${edgeKind}`;
    const existing = edges.get(edgeKey);
    if (!existing) {
      edges.set(edgeKey, {
        key: edgeKey,
        kind: edgeKind,
        label: edgeLabel,
        fromKey,
        toKey,
        count: 1,
        lastTs: ts,
      });
    } else {
      existing.count += 1;
      if (ts > existing.lastTs) {
        existing.lastTs = ts;
      }
      if (!existing.label && edgeLabel) {
        existing.label = edgeLabel;
      }
    }
  }

  const edgeList = [...edges.values()]
    .sort((a, b) => b.lastTs - a.lastTs)
    .slice(0, EDGE_LIMIT);

  const connectedNodeKeys = new Set<string>();
  for (const edge of edgeList) {
    connectedNodeKeys.add(edge.fromKey);
    connectedNodeKeys.add(edge.toKey);
  }

  const nodeList = [...nodes.values()]
    .filter((n) => connectedNodeKeys.has(n.key))
    .sort((a, b) => b.lastTs - a.lastTs);

  const layout = layoutNodes(nodeList);
  const laidOutNodes: GraphNode[] = nodeList.map((n) => ({
    ...n,
    x: layout.get(n.key)?.x ?? GRAPH_W / 2,
    y: layout.get(n.key)?.y ?? GRAPH_H / 2,
  }));

  const nodeByKey = new Map(laidOutNodes.map((n) => [n.key, n]));
  const laidOutEdges = edgeList.filter(
    (edge) => nodeByKey.has(edge.fromKey) && nodeByKey.has(edge.toKey),
  );

  return { nodes: laidOutNodes, edges: laidOutEdges, nodeByKey };
}

export function colorForEventKind(kind: string): string {
  if (isRpcKind(kind)) return "var(--routing-rpc)";
  if (isMessageKind(kind)) return "var(--routing-message)";
  if (isToolKind(kind)) return "var(--routing-tool)";
  return "var(--routing-other)";
}

export function truncateLabel(label: string, max = 24): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

export function formatRelativeTimestamp(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 1500) return "now";
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function formatEdgeTitle(edge: GraphEdge, from: GraphNode, to: GraphNode) {
  const age = formatRelativeTimestamp(edge.lastTs);
  const label = edge.label ? ` — ${edge.label}` : "";
  return `${edge.kind} (${edge.count}) — ${from.label} → ${to.label}${label} — ${age}`;
}

export function formatNodeTitle(node: GraphNode) {
  const age = formatRelativeTimestamp(node.lastTs);
  return `${node.kind}:${node.id} — ${node.activity} events — ${age}`;
}

