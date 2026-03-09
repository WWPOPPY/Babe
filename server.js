const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ANALYTICS_API_KEY || "replace-with-your-key";
const DATA_FILE = path.join(__dirname, "visits.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const INDEX_FILE = path.join(__dirname, "index.html");

const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const SPARKLINE_BUCKET_MS = 5 * 60 * 1000;
const SPARKLINE_POINTS = 10;
const MAX_ROWS = 200000;

const STATIC_MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8"
};

let visits = [];
let writeQueue = Promise.resolve();

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function sendFile(res, filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = STATIC_MIME_TYPES[ext] || "application/octet-stream";
    const data = await fs.readFile(filePath);
    setCorsHeaders(res);
    res.writeHead(200, { "Content-Type": mimeType });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Not Found");
      return;
    }
    console.error("Failed to read static file:", error);
    sendText(res, 500, "Internal Server Error");
  }
}

function getClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    return xForwardedFor.split(",")[0].trim().replace(/^::ffff:/, "");
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim()) {
    return realIp.trim().replace(/^::ffff:/, "");
  }

  const rawIp = req.socket?.remoteAddress || "";
  return String(rawIp).replace(/^::ffff:/, "");
}

function getCountryCode(req) {
  const raw =
    req.headers["x-vercel-ip-country"] ||
    req.headers["cf-ipcountry"] ||
    req.headers["cloudfront-viewer-country"] ||
    req.headers["x-country-code"] ||
    "";

  if (typeof raw !== "string") return "UN";
  const value = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : "UN";
}

function isBotUserAgent(userAgent = "") {
  return /(bot|crawl|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|preview|wget|curl)/i.test(
    userAgent
  );
}

function readApiKeyFromRequest(urlObject, req) {
  const keyFromQuery = urlObject.searchParams.get("apiKey");
  const headerValue = req.headers["x-api-key"];
  const keyFromHeader = typeof headerValue === "string" ? headerValue : "";
  return keyFromQuery || keyFromHeader || "";
}

function isApiKeyValid(urlObject, req) {
  const providedKey = readApiKeyFromRequest(urlObject, req);
  return Boolean(providedKey) && providedKey === API_KEY;
}

async function ensureDataFile() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    visits = Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      visits = [];
      await fs.writeFile(DATA_FILE, "[]", "utf8");
      return;
    }
    throw error;
  }
}

function queuePersist() {
  const snapshot = visits.slice(-MAX_ROWS);
  visits = snapshot;

  writeQueue = writeQueue
    .then(() => fs.writeFile(DATA_FILE, JSON.stringify(snapshot, null, 2), "utf8"))
    .catch((error) => {
      console.error("Failed to persist visits:", error);
    });

  return writeQueue;
}

async function handleTrack(urlObject, req, res) {
  if (!isApiKeyValid(urlObject, req)) {
    sendJson(res, 401, { ok: false, error: "Invalid apiKey" });
    return;
  }

  const userAgent = req.headers["user-agent"] || "";
  if (isBotUserAgent(userAgent)) {
    sendJson(res, 200, { ok: true, ignored: "bot" });
    return;
  }

  const pageUrl = (urlObject.searchParams.get("url") || req.headers.referer || "").slice(0, 2048);
  const visit = {
    timestamp: new Date().toISOString(),
    ip: getClientIp(req),
    country: getCountryCode(req),
    pageUrl
  };

  visits.push(visit);
  await queuePersist();
  sendJson(res, 200, { ok: true });
}

function handleStats(urlObject, req, res) {
  if (!isApiKeyValid(urlObject, req)) {
    sendJson(res, 401, { ok: false, error: "Invalid apiKey" });
    return;
  }

  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const onlineThreshold = now - ONLINE_WINDOW_MS;

  let totalViews = 0;
  let todayViews = 0;
  const onlineIps = new Set();
  const countryCounts = new Map();
  const sparkline = Array.from({ length: SPARKLINE_POINTS }, () => 0);
  const sparklineStart = now - SPARKLINE_POINTS * SPARKLINE_BUCKET_MS;

  for (const row of visits) {
    const ts = Date.parse(row.timestamp);
    if (Number.isNaN(ts)) continue;

    totalViews += 1;

    if (ts >= todayStartMs) {
      todayViews += 1;
    }

    if (ts >= onlineThreshold && row.ip) {
      onlineIps.add(row.ip);
    }

    const country = row.country || "UN";
    countryCounts.set(country, (countryCounts.get(country) || 0) + 1);

    if (ts >= sparklineStart && ts <= now) {
      const offset = ts - sparklineStart;
      const bucket = Math.min(SPARKLINE_POINTS - 1, Math.max(0, Math.floor(offset / SPARKLINE_BUCKET_MS)));
      sparkline[bucket] += 1;
    }
  }

  let topCountry = "N/A";
  let topCount = 0;
  for (const [country, count] of countryCounts.entries()) {
    if (count > topCount) {
      topCount = count;
      topCountry = country;
    }
  }

  sendJson(res, 200, {
    totalViews,
    todayViews,
    currentOnline: onlineIps.size,
    topCountry,
    sparkline
  });
}

function handlePublicAsset(res, pathname) {
  const relativePath = pathname.replace(/^\/public\//, "");
  const decoded = decodeURIComponent(relativePath);
  const safePath = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  sendFile(res, filePath);
}

async function requestHandler(req, res) {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObject = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = urlObject.pathname;

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    return;
  }

  if (pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/track") {
    await handleTrack(urlObject, req, res);
    return;
  }

  if (pathname === "/api/stats") {
    handleStats(urlObject, req, res);
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    await sendFile(res, INDEX_FILE);
    return;
  }

  if (pathname.startsWith("/public/")) {
    handlePublicAsset(res, pathname);
    return;
  }

  sendText(res, 404, "Not Found");
}

ensureDataFile()
  .then(() => {
    const server = http.createServer((req, res) => {
      requestHandler(req, res).catch((error) => {
        console.error("Unexpected server error:", error);
        sendJson(res, 500, { ok: false, error: "Internal Server Error" });
      });
    });

    server.listen(PORT, () => {
      console.log(`Analytics server listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
