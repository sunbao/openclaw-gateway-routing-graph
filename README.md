# OpenClaw Gateway Routing Graph (Standalone)

This is a standalone, real-time routing visualization for an OpenClaw gateway.

It connects to the gateway WebSocket, listens for:

- `trace` events (gateway-side routing trace stream)
- `agent` events (tool stream), and synthesizes `tool.start` / `tool.result` edges

and renders a live SVG “routing map” (nodes + edges) plus a recent-events list.

## Run (dev)

From this folder:

```bash
pnpm install
pnpm dev
```

Open the page, then set:

- **Gateway URL** (example: `ws://127.0.0.1:18789`)
- **Token** (an operator token with `operator.admin` scope if you want `trace`)

## Notes

- The gateway must broadcast `trace` events for full routing visibility (RPC + message in/out).
  If you only have `agent` tool events, you’ll still see tool edges, but not full message routing.
- This UI intentionally avoids rendering full message bodies / tool outputs; it prefers small metadata
  so the graph stays readable and safer to run.

