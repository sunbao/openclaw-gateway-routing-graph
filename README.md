# OpenClaw Gateway Routing Graph (Standalone)

This is a standalone, real-time routing visualization for an OpenClaw gateway.

It connects to the gateway WebSocket, listens for:

- `trace` events (gateway-side routing trace stream)
- `agent` events (tool stream), and synthesizes `tool.start` / `tool.result` edges

and renders a live SVG routing map (nodes + edges) plus a recent-events list.

## Run (dev)

From this folder:

```bash
pnpm install
pnpm dev
```

If you don't use pnpm:

```bash
npm install
npm run dev
```

Open the page, then set:

- **Gateway URL** (example: `ws://127.0.0.1:18789`)
- **Token** (an operator token with `operator.admin` scope if you want `trace`)
- **Password** (optional; use if your gateway is configured for password auth)

### Remote gateway (recommended: SSH tunnel)

If your gateway is on another host, prefer an SSH tunnel instead of exposing the
admin WebSocket port to your LAN.

On your laptop/desktop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@<gateway-host>
```

Then use:

- **Gateway URL**: `ws://127.0.0.1:18789`
- **Token/Password**: same values as the gateway host config (`gateway.auth.token` /
  `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD`)

## Browser disconnected (1006)? Use the built-in WS proxy

Some gateway forks reject cross-origin browser WebSockets (often as an HTTP 403
upgrade failure, which the browser reports as close code `1006` with no reason).

This project includes a same-origin WS proxy that strips the browser `Origin`
header from the upstream gateway connection:

```bash
# build the UI and start a local server with a WS proxy
GATEWAY_URL=ws://127.0.0.1:18789 npm run serve:build
```

Then in the UI, set:

- **Gateway URL**: `ws://<ui-host>:5173/__routing_graph/ws`

## Notes

- The gateway must broadcast `trace` events for full routing visibility (RPC + message in/out).
  If you only have `agent` tool events, you'll still see tool edges, but not full message routing.
- This UI intentionally avoids rendering full message bodies / tool outputs; it prefers small metadata
  so the graph stays readable and safer to run.
