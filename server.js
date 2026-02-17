const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const geoip = require("geoip-lite");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.ANALYTICS_API_KEY || "replace-with-your-key";
const DATA_FILE = path.join(__dirname, "visits.json");

const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const SPARKLINE_BUCKET_MS = 5 * 60 * 1000;
const SPARKLINE_POINTS = 10;
const MAX_ROWS = 200000;

let visits = [];
let writeQueue = Promise.resolve();

app.use(cors());
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));

function getClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    return xForwardedFor.split(",")[0].trim().replace(/^::ffff:/, "");
  }

  const rawIp = req.ip || req.socket?.remoteAddress || "";
  return String(rawIp).replace(/^::ffff:/, "");
}

function isBotUserAgent(userAgent = "") {
  return /(bot|crawl|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|preview|wget|curl)/i.test(
    userAgent
  );
}

function requireApiKey(req, res, next) {
  const keyFromQuery = req.query.apiKey;
  const keyFromHeader = req.headers["x-api-key"];
  const providedKey = typeof keyFromQuery === "string" ? keyFromQuery : keyFromHeader;

  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid apiKey" });
  }

  return next();
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

app.get("/track", requireApiKey, async (req, res) => {
  const userAgent = req.get("user-agent") || "";
  if (isBotUserAgent(userAgent)) {
    return res.json({ ok: true, ignored: "bot" });
  }

  const ip = getClientIp(req);
  const geo = geoip.lookup(ip);
  const country = geo?.country || "UN";
  const pageUrl =
    (typeof req.query.url === "string" && req.query.url.slice(0, 2048)) ||
    (req.get("referer") || "");

  const visit = {
    timestamp: new Date().toISOString(),
    ip,
    country,
    pageUrl
  };

  visits.push(visit);
  await queuePersist();

  return res.json({ ok: true });
});

app.get("/api/stats", requireApiKey, (req, res) => {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const onlineThreshold = now - ONLINE_WINDOW_MS;

  let totalViews = 0;
  let todayViews = 0;
  let currentOnline = 0;
  const countryCounts = new Map();

  const sparkline = Array.from({ length: SPARKLINE_POINTS }, () => 0);
  const sparklineStart = now - SPARKLINE_POINTS * SPARKLINE_BUCKET_MS;

  for (const row of visits) {
    const ts = Date.parse(row.timestamp);
    if (Number.isNaN(ts)) {
      continue;
    }

    totalViews += 1;

    if (ts >= todayStartMs) {
      todayViews += 1;
    }

    if (ts >= onlineThreshold) {
      currentOnline += 1;
    }

    const country = row.country || "UN";
    countryCounts.set(country, (countryCounts.get(country) || 0) + 1);

    if (ts >= sparklineStart && ts <= now) {
      const offset = ts - sparklineStart;
      const bucket = Math.min(
        SPARKLINE_POINTS - 1,
        Math.max(0, Math.floor(offset / SPARKLINE_BUCKET_MS))
      );
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

  return res.json({
    totalViews,
    todayViews,
    currentOnline,
    topCountry,
    sparkline
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

ensureDataFile()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Analytics server listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
