const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { rateLimit } = require("express-rate-limit");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const CAMERA_SECRET = process.env.CAMERA_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
const USERS_FILE = path.join(__dirname, "users.json");
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_VIEWER_BUFFER_BYTES = 2 * 1024 * 1024;

if (!JWT_SECRET || Buffer.byteLength(JWT_SECRET) < 32) {
  throw new Error("JWT_SECRET must be set to at least 32 bytes.");
}
if (!CAMERA_SECRET || Buffer.byteLength(CAMERA_SECRET) < 32) {
  throw new Error("CAMERA_SECRET must be set to at least 32 bytes.");
}

function loadUsers() {
  const users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  if (!Array.isArray(users)) {
    throw new Error("server/users.json must contain an array.");
  }
  for (const user of users) {
    if (
      typeof user.username !== "string" ||
      !user.username.trim() ||
      typeof user.passwordHash !== "string" ||
      !/^\$2[aby]\$/.test(user.passwordHash)
    ) {
      throw new Error(
        "Each whitelist entry needs a username and bcrypt passwordHash."
      );
    }
  }
  return users;
}

let users = loadUsers();
const dummyHash = bcrypt.hashSync(crypto.randomUUID(), 10);
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_FRAME_BYTES + 8 });
const viewers = new Set();
let publisher = null;
let cameraClockOffsetMs = null;
let nextSyncId = 1;

app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}
app.use(helmet());
app.use(
  cors({
    origin: process.env.WEB_ORIGIN
      ? process.env.WEB_ORIGIN.split(",").map((origin) => origin.trim())
      : "http://localhost:5173",
  })
);
app.use(express.json({ limit: "16kb" }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.post("/api/login", loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 128 ||
      password.length > 1024
    ) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    users = loadUsers();
    const user = users.find((entry) => entry.username === username.trim());
    const passwordMatches = await bcrypt.compare(
      password,
      user ? user.passwordHash : dummyHash
    );
    if (!user || !passwordMatches) {
      return res.status(401).json({ error: "Invalid username or password." });
    }

    const token = jwt.sign(
      { sub: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN, issuer: "surveillance-relay" }
    );
    return res.json({ token, expiresIn: JWT_EXPIRES_IN });
  } catch (error) {
    return next(error);
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    publisherConnected: Boolean(publisher),
    viewers: viewers.size,
    timestamp: Date.now(),
  });
});

const frontendDist = path.resolve(__dirname, "..", "frontend", "dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { index: false }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path === "/health") {
      return next();
    }
    return res.sendFile(path.join(frontendDist, "index.html"));
  });
}

app.use((error, _req, res, _next) => {
  console.error("HTTP request failed:", error.message);
  res.status(500).json({ error: "Internal server error." });
});

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const viewer of viewers) {
    if (viewer.readyState === WebSocket.OPEN) {
      viewer.send(message);
    }
  }
}

function safeSecretEquals(provided) {
  if (typeof provided !== "string") return false;
  const expectedBuffer = Buffer.from(CAMERA_SECRET);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function authenticateViewer(token) {
  try {
    const claims = jwt.verify(token, JWT_SECRET, {
      issuer: "surveillance-relay",
    });
    return (
      typeof claims.sub === "string" &&
      loadUsers().some((user) => user.username === claims.sub)
    )
      ? claims
      : null;
  } catch {
    return null;
  }
}

function handlePublisherMessage(socket, data, isBinary) {
  if (isBinary) {
    if (data.length < 9 || data.length > MAX_FRAME_BYTES + 8) return;
    socket.lastFrameAt = Date.now();
    for (const viewer of viewers) {
      if (
        viewer.readyState === WebSocket.OPEN &&
        viewer.bufferedAmount <= MAX_VIEWER_BUFFER_BYTES
      ) {
        viewer.send(data, { binary: true });
      }
    }
    return;
  }

  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }

  if (message.type === "TIME_SYNC" && Number.isInteger(message.id)) {
    const t4 = Date.now();
    const t1 = socket.pendingTimeSync?.get(message.id);
    const t2 = Number(message.deviceReceiveMs);
    const t3 = Number(message.deviceSendMs);
    if (
      Number.isFinite(t1) &&
      Number.isFinite(t2) &&
      t2 >= 0 &&
      t3 >= t2
    ) {
      cameraClockOffsetMs = Math.round(((t1 - t2) + (t4 - t3)) / 2);
      socket.pendingTimeSync.delete(message.id);
      broadcast({
        type: "CLOCK_SYNC",
        serverTime: t4,
        cameraClockOffsetMs,
      });
    }
    return;
  }

  if (message.type === "STATUS" || message.type === "RESOLUTION_ACK") {
    broadcast(message);
  }
}

function synchronizePublisher(socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  for (const [id, sentAt] of socket.pendingTimeSync) {
    if (now - sentAt > 60000) socket.pendingTimeSync.delete(id);
  }
  const id = nextSyncId++;
  socket.pendingTimeSync.set(id, now);
  sendJson(socket, { type: "TIME_SYNC", id, serverSendMs: now });
}

function onConnection(socket) {
  socket.isAlive = true;
  socket.authenticated = false;
  socket.pendingTimeSync = new Map();
  const authTimeout = setTimeout(() => {
    if (!socket.authenticated) socket.close(4001, "Authentication required");
  }, 5000);

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (data, isBinary) => {
    if (!socket.authenticated) {
      if (isBinary) {
        socket.close(4001, "Authenticate first");
        return;
      }
      let auth;
      try {
        auth = JSON.parse(data.toString());
      } catch {
        socket.close(4001, "Invalid authentication message");
        return;
      }

      if (auth.type === "AUTH_PUBLISHER" && safeSecretEquals(auth.secret)) {
        if (publisher && publisher.readyState === WebSocket.OPEN) {
          const lastPublisherActivity = publisher.lastFrameAt || publisher.authenticatedAt;
          if (Date.now() - lastPublisherActivity < 10000) {
            socket.close(4003, "Publisher already connected");
            return;
          }
          publisher.close(4000, "Replacing stale camera connection");
        }
        publisher = socket;
        socket.role = "publisher";
        socket.authenticated = true;
        socket.authenticatedAt = Date.now();
        socket.lastFrameAt = socket.authenticatedAt;
        clearTimeout(authTimeout);
        sendJson(socket, { type: "AUTH_OK", role: "publisher" });
        synchronizePublisher(socket);
        socket.timeSyncTimer = setInterval(
          () => synchronizePublisher(socket),
          30000
        );
        broadcast({ type: "STATUS", status: "camera_connected" });
        return;
      }

      if (auth.type === "AUTH_VIEWER" && typeof auth.token === "string") {
        const username = authenticateViewer(auth.token);
        if (!username) {
          socket.close(4001, "Invalid or expired token");
          return;
        }
        socket.role = "viewer";
        socket.username = username.sub;
        socket.authenticated = true;
        clearTimeout(authTimeout);
        socket.authExpiryTimer = setTimeout(
          () => socket.close(4001, "Session expired"),
          Math.max(0, username.exp * 1000 - Date.now())
        );
        viewers.add(socket);
        sendJson(socket, {
          type: "AUTH_OK",
          role: "viewer",
          serverTime: Date.now(),
          clientPerf: Number.isFinite(auth.clientPerf) ? auth.clientPerf : null,
          cameraClockOffsetMs,
          cameraConnected: Boolean(publisher && publisher.readyState === WebSocket.OPEN),
        });
        return;
      }

      socket.close(4001, "Invalid credentials");
      return;
    }

    if (socket.role === "publisher") {
      handlePublisherMessage(socket, data, isBinary);
      return;
    }
    if (socket.role !== "viewer" || isBinary) return;

    let command;
    try {
      command = JSON.parse(data.toString());
    } catch {
      sendJson(socket, { type: "ERROR", error: "Invalid JSON command." });
      return;
    }
    const validResolution =
      command.type === "SET_RESOLUTION" &&
      ["QQVGA", "QVGA", "VGA", "SVGA", "XGA"].includes(command.value);
    const validTorch =
      command.type === "SET_TORCH" && typeof command.value === "boolean";
    if (!validResolution && !validTorch) {
      sendJson(socket, { type: "ERROR", error: "Unsupported camera command." });
      return;
    }
    if (!publisher || publisher.readyState !== WebSocket.OPEN) {
      sendJson(socket, { type: "ERROR", error: "Camera is offline." });
      return;
    }
    sendJson(publisher, command);
  });

  socket.on("close", () => {
    clearTimeout(authTimeout);
    clearTimeout(socket.authExpiryTimer);
    clearInterval(socket.timeSyncTimer);
    if (socket.role === "viewer") viewers.delete(socket);
    if (socket.role === "publisher" && publisher === socket) {
      publisher = null;
      cameraClockOffsetMs = null;
      broadcast({ type: "STATUS", status: "camera_disconnected" });
    }
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
}

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (webSocket) => {
    wss.emit("connection", webSocket, request);
  });
});

wss.on("connection", onConnection);

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Surveillance relay listening on port ${PORT}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, "Server shutting down");
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
