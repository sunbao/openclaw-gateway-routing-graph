const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const distDir = process.env.DIST_DIR || path.join(process.cwd(), "dist");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 5173);

// WebSocket proxy endpoint (same origin as UI). This is useful when the gateway
// rejects cross-origin browser WebSockets (commonly seen as: disconnected (1006)).
const proxyPath = process.env.PROXY_PATH || "/__routing_graph/ws";
const gatewayUrl = process.env.GATEWAY_URL || "ws://127.0.0.1:18789";
const connectTimeoutMs = Math.max(
  500,
  Math.min(30_000, Number(process.env.GATEWAY_CONNECT_TIMEOUT_MS || 8000)),
);
const maxPending = Math.max(0, Math.min(2000, Number(process.env.MAX_PENDING || 200)));

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendNotFound(res) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("not found");
}

function safeJoin(root, urlPath) {
  const rel = path.posix.normalize(urlPath).replace(/^\/+/, "/");
  const joined = path.join(root, rel);
  if (!joined.startsWith(root)) return null;
  return joined;
}

const server = http.createServer((req, res) => {
  try {
    if (!req.url) {
      res.statusCode = 400;
      res.end("bad request");
      return;
    }

    if (req.url === "/__routing_graph/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, gatewayUrl, proxyPath }));
      return;
    }

    const urlPath = req.url.split("?")[0].split("#")[0];
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(urlPath);
    } catch {
      res.statusCode = 400;
      res.end("bad url");
      return;
    }

    let normalizedPath = decodedPath;
    if (normalizedPath === "/" || normalizedPath === "") normalizedPath = "/index.html";

    const filePath = safeJoin(distDir, normalizedPath);
    if (!filePath) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback: serve index.html for unknown routes.
        if (normalizedPath !== "/index.html") {
          fs.readFile(path.join(distDir, "index.html"), (err2, data2) => {
            if (err2) return sendNotFound(res);
            res.statusCode = 200;
            res.setHeader("Content-Type", mime[".html"]);
            res.setHeader("Cache-Control", "no-store");
            res.end(data2);
          });
          return;
        }
        return sendNotFound(res);
      }

      const ext = path.extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.end(data);
    });
  } catch {
    res.statusCode = 500;
    res.end("internal error");
  }
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  clientTracking: false,
});

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname !== proxyPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on("connection", (clientWs) => {
  const upstreamWs = new WebSocket(gatewayUrl, {
    // Do NOT forward browser Origin headers.
    perMessageDeflate: false,
  });

  const pendingToUpstream = [];

  const connectTimer = setTimeout(() => {
    try {
      clientWs.close(1011, "gateway connect timeout");
    } catch {
      // ignore
    }
    try {
      upstreamWs.terminate();
    } catch {
      // ignore
    }
  }, connectTimeoutMs);

  const closeBoth = (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.close(code, reason);
      } catch {
        // ignore
      }
    }
    if (upstreamWs.readyState === WebSocket.OPEN) {
      try {
        upstreamWs.close(code, reason);
      } catch {
        // ignore
      }
    }
  };

  upstreamWs.on("open", () => {
    clearTimeout(connectTimer);
    for (const item of pendingToUpstream) {
      try {
        upstreamWs.send(item.data, { binary: item.isBinary });
      } catch {
        // ignore
      }
    }
    pendingToUpstream.length = 0;
  });

  upstreamWs.on("message", (data, isBinary) => {
    if (clientWs.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      clientWs.send(data, { binary: isBinary });
    } catch {
      // ignore
    }
  });

  upstreamWs.on("close", (code, reasonRaw) => {
    clearTimeout(connectTimer);
    const reason = typeof reasonRaw === "string" ? reasonRaw : reasonRaw?.toString?.() || "";
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.close(code, reason);
      } catch {
        // ignore
      }
    }
  });

  upstreamWs.on("error", () => {
    clearTimeout(connectTimer);
    closeBoth(1011, "gateway upstream error");
  });

  clientWs.on("message", (data, isBinary) => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      try {
        upstreamWs.send(data, { binary: isBinary });
      } catch {
        // ignore
      }
      return;
    }
    if (pendingToUpstream.length < maxPending) {
      pendingToUpstream.push({ data, isBinary });
      return;
    }
    closeBoth(1013, "proxy overloaded");
  });

  clientWs.on("close", (code, reasonRaw) => {
    clearTimeout(connectTimer);
    const reason = typeof reasonRaw === "string" ? reasonRaw : reasonRaw?.toString?.() || "";
    if (upstreamWs.readyState === WebSocket.OPEN) {
      try {
        upstreamWs.close(code, reason);
      } catch {
        // ignore
      }
    } else {
      try {
        upstreamWs.terminate();
      } catch {
        // ignore
      }
    }
  });

  clientWs.on("error", () => {
    clearTimeout(connectTimer);
    try {
      upstreamWs.terminate();
    } catch {
      // ignore
    }
  });
});

server.listen(port, host, () => {
  console.log(`[routing-graph] serving ${distDir} at http://${host}:${port}`);
  console.log(`[routing-graph] ws proxy at ws://${host}:${port}${proxyPath} -> ${gatewayUrl}`);
});

