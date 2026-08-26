"use strict";

// Zero-dependency static file + JSON API server for Reta Tracker.
// Serves index.html/style.css/app.js and persists entries to a JSON file
// on disk, so multiple devices on the same network share one history.
//
// Usage: PORT=3000 DATA_DIR=./data node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "entries.json");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, "[]\n");
}

function readEntries() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  ensureDataFile();
  const tmpFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(entries, null, 2));
  fs.renameSync(tmpFile, DATA_FILE);
}

function isValidEntry(body) {
  return (
    body &&
    typeof body.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.date) &&
    typeof body.dose === "number" &&
    Number.isFinite(body.dose) &&
    body.dose >= 0 &&
    (body.note === undefined || typeof body.note === "string")
  );
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(fullPath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/api/entries" && req.method === "GET") {
      return sendJson(res, 200, readEntries());
    }

    if (pathname === "/api/entries" && req.method === "POST") {
      const body = JSON.parse(await readRequestBody(req));
      if (!isValidEntry(body)) return sendJson(res, 400, { error: "Invalid entry" });
      const entries = readEntries();
      const entry = { id: crypto.randomUUID(), date: body.date, dose: body.dose, note: body.note || "" };
      entries.push(entry);
      writeEntries(entries);
      return sendJson(res, 201, entry);
    }

    const entryMatch = pathname.match(/^\/api\/entries\/([^/]+)$/);
    if (entryMatch && (req.method === "PUT" || req.method === "DELETE")) {
      const id = decodeURIComponent(entryMatch[1]);
      const entries = readEntries();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return sendJson(res, 404, { error: "Not found" });

      if (req.method === "DELETE") {
        entries.splice(idx, 1);
        writeEntries(entries);
        return sendJson(res, 200, { ok: true });
      }

      const body = JSON.parse(await readRequestBody(req));
      if (!isValidEntry(body)) return sendJson(res, 400, { error: "Invalid entry" });
      entries[idx] = { id, date: body.date, dose: body.dose, note: body.note || "" };
      writeEntries(entries);
      return sendJson(res, 200, entries[idx]);
    }

    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "Not found" });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(405);
    res.end("Method not allowed");
  } catch (err) {
    sendJson(res, 400, { error: "Bad request" });
  }
});

server.listen(PORT, () => {
  console.log(`Reta Tracker listening on http://0.0.0.0:${PORT} (data: ${DATA_FILE})`);
});
