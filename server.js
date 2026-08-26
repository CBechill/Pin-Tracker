"use strict";

// Zero-dependency static file + JSON API server for Pin Tracker.
// Serves index.html/style.css/app.js and persists three resources to
// JSON files on disk, so multiple devices on the same network share one
// history: compounds (peptides you track, each with its own half-life),
// entries (pins logged against a compound), and weight (body-weight log).
//
// Usage: PORT=3000 DATA_DIR=./data node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const DEFAULT_COMPOUNDS = [
  { id: "retatrutide", name: "Retatrutide", halfLifeDays: 6 },
  { id: "tirzepatide", name: "Tirzepatide", halfLifeDays: 5 },
  { id: "semaglutide", name: "Semaglutide", halfLifeDays: 7 },
  { id: "cagrilintide", name: "Cagrilintide", halfLifeDays: 8 },
];

// ---------- generic JSON-file resource store ----------

function ensureFile(file, initial) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2) + "\n");
}

function readJson(file, initial) {
  ensureFile(file, initial);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : initial;
  } catch {
    return initial;
  }
}

function writeJson(file, value) {
  ensureFile(file, []);
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(value, null, 2));
  fs.renameSync(tmpFile, file);
}

const compoundsFile = path.join(DATA_DIR, "compounds.json");
const entriesFile = path.join(DATA_DIR, "entries.json");
const weightFile = path.join(DATA_DIR, "weight.json");

const readCompounds = () => readJson(compoundsFile, DEFAULT_COMPOUNDS);
const writeCompounds = (v) => writeJson(compoundsFile, v);
const readEntries = () => readJson(entriesFile, []);
const writeEntries = (v) => writeJson(entriesFile, v);
const readWeight = () => readJson(weightFile, []);
const writeWeight = (v) => writeJson(weightFile, v);

function isValidCompound(body) {
  return (
    body &&
    typeof body.name === "string" &&
    body.name.trim().length > 0 &&
    body.name.length <= 60 &&
    typeof body.halfLifeDays === "number" &&
    Number.isFinite(body.halfLifeDays) &&
    body.halfLifeDays > 0
  );
}

function isValidEntry(body) {
  return (
    body &&
    typeof body.compoundId === "string" &&
    body.compoundId.length > 0 &&
    typeof body.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.date) &&
    typeof body.dose === "number" &&
    Number.isFinite(body.dose) &&
    body.dose >= 0 &&
    (body.note === undefined || typeof body.note === "string")
  );
}

function isValidWeight(body) {
  return (
    body &&
    typeof body.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.date) &&
    typeof body.weight === "number" &&
    Number.isFinite(body.weight) &&
    body.weight > 0 &&
    (body.unit === "lb" || body.unit === "kg") &&
    (body.note === undefined || typeof body.note === "string")
  );
}

// ---------- http plumbing ----------

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
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // already rejected - drain and discard the rest
      size += chunk.length;
      if (size > 1e6) {
        tooLarge = true;
        // Note: intentionally not req.destroy() here - that severs the
        // socket res shares with req, so the error response below could
        // never actually reach the client (confirmed: it was silently
        // dropping the connection instead of returning 400).
        reject(new Error("Request body too large"));
        return;
      }
      data += chunk;
    });
    req.on("end", () => { if (!tooLarge) resolve(data); });
    req.on("error", reject);
  });
}

// Explicit allowlist, not a directory serve - this repo checkout also holds
// server.js, README.md, .git/, and (at runtime) data/*.json with the user's
// actual logged entries. Serving PUBLIC_DIR generically would expose all of
// that to anyone on the LAN; only these exact app files are ever served.
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/style.css": "style.css",
  "/app.js": "app.js",
};

function serveStatic(req, res, pathname) {
  const file = STATIC_FILES[pathname];
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const fullPath = path.join(PUBLIC_DIR, file);
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

// Handles GET (list) + POST (create) on /api/<name>, and PUT/DELETE on
// /api/<name>/:id, for a resource backed by a single JSON array file.
async function handleResource(req, res, pathname, { base, read, write, isValid, buildRecord, onDelete }) {
  if (pathname === base && req.method === "GET") {
    sendJson(res, 200, read());
    return true;
  }

  if (pathname === base && req.method === "POST") {
    const body = JSON.parse(await readRequestBody(req));
    if (!isValid(body)) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    const items = read();
    const record = buildRecord(body);
    items.push(record);
    write(items);
    sendJson(res, 201, record);
    return true;
  }

  const match = pathname.match(new RegExp(`^${base}/([^/]+)$`));
  if (match && (req.method === "PUT" || req.method === "DELETE")) {
    const id = decodeURIComponent(match[1]);
    const items = read();
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) {
      sendJson(res, 404, { error: "Not found" });
      return true;
    }

    if (req.method === "DELETE") {
      if (onDelete) {
        const blocked = onDelete(id);
        if (blocked) {
          sendJson(res, 409, { error: blocked });
          return true;
        }
      }
      items.splice(idx, 1);
      write(items);
      sendJson(res, 200, { ok: true });
      return true;
    }

    const body = JSON.parse(await readRequestBody(req));
    if (!isValid(body)) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    items[idx] = { ...buildRecord(body), id };
    write(items);
    sendJson(res, 200, items[idx]);
    return true;
  }

  return false; // not handled by this resource
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith("/api/compounds")) {
      const handled = await handleResource(req, res, pathname, {
        base: "/api/compounds",
        read: readCompounds,
        write: writeCompounds,
        isValid: isValidCompound,
        buildRecord: (b) => ({ id: crypto.randomUUID(), name: b.name.trim(), halfLifeDays: b.halfLifeDays }),
        onDelete: (id) => {
          const inUse = readEntries().some((e) => e.compoundId === id);
          return inUse ? "Delete or reassign that compound's entries first" : null;
        },
      });
      if (handled) return;
    }

    if (pathname.startsWith("/api/entries")) {
      const handled = await handleResource(req, res, pathname, {
        base: "/api/entries",
        read: readEntries,
        write: writeEntries,
        isValid: isValidEntry,
        buildRecord: (b) => ({ id: crypto.randomUUID(), compoundId: b.compoundId, date: b.date, dose: b.dose, note: b.note || "" }),
      });
      if (handled) return;
    }

    if (pathname.startsWith("/api/weight")) {
      const handled = await handleResource(req, res, pathname, {
        base: "/api/weight",
        read: readWeight,
        write: writeWeight,
        isValid: isValidWeight,
        buildRecord: (b) => ({ id: crypto.randomUUID(), date: b.date, weight: b.weight, unit: b.unit, note: b.note || "" }),
      });
      if (handled) return;
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
  console.log(`Pin Tracker listening on http://0.0.0.0:${PORT} (data: ${DATA_DIR})`);
});
