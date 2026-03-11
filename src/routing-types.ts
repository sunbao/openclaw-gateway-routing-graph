export type GatewayTraceNodeKind =
  | "gateway"
  | "client"
  | "rpc"
  | "session"
  | "agent"
  | "tool"
  | "channel"
  | "node"
  | (string & {});

export type GatewayTraceNode = {
  kind: GatewayTraceNodeKind;
  id: string;
  label?: string;
};

export type GatewayTraceEvent = {
  id: string;
  ts: number;
  kind: string;
  from: GatewayTraceNode;
  to: GatewayTraceNode;
  label?: string;
  sessionKey?: string;
  runId?: string;
  data?: Record<string, unknown>;
};

export type RoutingFilters = {
  rpc: boolean;
  messages: boolean;
  tools: boolean;
};

