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
const logLevel = (process.env.LOG_LEVEL || "info").toLowerCase();

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

function safeNowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return "now";
  }
}

function logInfo(msg, meta) {
  if (logLevel === "silent" || logLevel === "error") return;
  if (meta) {
    console.log(`[routing-graph] ${safeNowIso()} ${msg}`, meta);
    return;
  }
  console.log(`[routing-graph] ${safeNowIso()} ${msg}`);
}

function logWarn(msg, meta) {
  if (logLevel === "silent" || logLevel === "error") return;
  if (meta) {
    console.warn(`[routing-graph] ${safeNowIso()} ${msg}`, meta);
    return;
  }
  console.warn(`[routing-graph] ${safeNowIso()} ${msg}`);
}

function logError(msg, meta) {
  if (logLevel === "silent") return;
  if (meta) {
    console.error(`[routing-graph] ${safeNowIso()} ${msg}`, meta);
    return;
  }
  console.error(`[routing-graph] ${safeNowIso()} ${msg}`);
}

function sanitizeWsUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    // Best-effort: strip query string to avoid leaking tokens.
    return raw.split("?")[0].trim();
  }
}

function shorten(str, max = 120) {
  const s = String(str || "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatUpstreamFailure(err, extra) {
  const code = err && typeof err === "object" ? err.code : undefined;
  const message = err instanceof Error ? err.message : err ? String(err) : "";

  // ws client handshake failures commonly look like: "Unexpected server response: 200"
  const m = message.match(/Unexpected server response: (\\d{3})/i);
  if (m) {
    const status = m[1];
    return shorten(
      `gateway rejected WebSocket upgrade (HTTP ${status}) — check GATEWAY_URL (${sanitizeWsUrl(
        extra?.gatewayUrl || gatewayUrl,
      )})`,
      120,
    );
  }

  if (typeof code === "string" && code) {
    if (code === "ECONNREFUSED") return "cannot reach gateway (ECONNREFUSED) — is it running?";
    if (code === "ENOTFOUND") return "cannot resolve gateway host (ENOTFOUND) — check URL/DNS";
    if (code === "ETIMEDOUT") return "gateway connect timed out (ETIMEDOUT)";
    if (code === "EHOSTUNREACH") return "gateway host unreachable (EHOSTUNREACH)";
    if (code === "ECONNRESET") return "gateway connection reset (ECONNRESET)";
    return shorten(`gateway upstream error (${code})${message ? `: ${message}` : ""}`, 120);
  }

  if (message) {
    return shorten(`gateway upstream error: ${message}`, 120);
  }

  return "gateway upstream error";
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
  const connId = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  const upstreamWs = new WebSocket(gatewayUrl, {
    // Do NOT forward browser Origin headers.
    perMessageDeflate: false,
  });

  const pendingToUpstream = [];
  logInfo("ws proxy client connected", { connId });

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
    logInfo("ws proxy upstream connected", { connId, gatewayUrl: sanitizeWsUrl(gatewayUrl) });
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

  upstreamWs.on("unexpected-response", (_req, res) => {
    clearTimeout(connectTimer);
    const status = res && typeof res.statusCode === "number" ? res.statusCode : 0;
    const statusMessage = res && typeof res.statusMessage === "string" ? res.statusMessage : "";
    const msg = shorten(
      `gateway rejected WebSocket upgrade (HTTP ${status || "?"}${statusMessage ? ` ${statusMessage}` : ""})`,
      120,
    );
    logError("ws proxy upstream unexpected-response", {
      connId,
      status,
      statusMessage,
      gatewayUrl: sanitizeWsUrl(gatewayUrl),
    });
    closeBoth(1011, msg);
    try {
      upstreamWs.terminate();
    } catch {
      // ignore
    }
  });

  upstreamWs.on("close", (code, reasonRaw) => {
    clearTimeout(connectTimer);
    const reason = typeof reasonRaw === "string" ? reasonRaw : reasonRaw?.toString?.() || "";
    logWarn("ws proxy upstream closed", { connId, code, reason: shorten(reason, 200) });
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        clientWs.close(code, reason);
      } catch {
        // ignore
      }
    }
  });

  upstreamWs.on("error", (err) => {
    clearTimeout(connectTimer);
    const msg = formatUpstreamFailure(err, { gatewayUrl });
    logError("ws proxy upstream error", {
      connId,
      gatewayUrl: sanitizeWsUrl(gatewayUrl),
      error: err instanceof Error ? { message: err.message, code: err.code } : String(err),
      closeReason: msg,
    });
    closeBoth(1011, msg);
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
    logInfo("ws proxy client closed", { connId, code, reason: shorten(reason, 200) });
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
    logWarn("ws proxy client error", { connId });
    try {
      upstreamWs.terminate();
    } catch {
      // ignore
    }
  });
});

server.listen(port, host, () => {
  logInfo(`serving ${distDir} at http://${host}:${port}`);
  logInfo(
    `ws proxy at ws://${host}:${port}${proxyPath} -> ${sanitizeWsUrl(gatewayUrl)}`,
  );
});
