// Telegram assistant for Pin Tracker.
//
// Talks to Telegram by long polling (outbound only - no open ports), uses
// Claude with tools to read/write the tracker through its own HTTP API
// (server.js stays the single writer of the data files), and sends a daily
// look-ahead each morning. Only the Telegram user in TELEGRAM_ALLOWED_USER_ID
// gets responses; everyone else is ignored.
//
// Config comes from environment variables - see deploy/bot.env.example.

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID ? Number(process.env.TELEGRAM_ALLOWED_USER_ID) : null;
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const TRACKER_URL = (process.env.TRACKER_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const TIME_ZONE = process.env.TIME_ZONE || "America/New_York";
const LOOKAHEAD_HOUR = Number(process.env.LOOKAHEAD_HOUR || 8);
// BOT_-prefixed so they can't collide with CLAUDE_* vars other Claude tooling sets.
const MODEL = process.env.BOT_CLAUDE_MODEL || "claude-opus-5";
const EFFORT = process.env.BOT_CLAUDE_EFFORT || "medium";
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const STATE_FILE = path.join(DATA_DIR, "bot-state.json");

const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // new conversation after 2h of quiet
const SESSION_MAX_MESSAGES = 80;
const MAX_AGENT_STEPS = 12;
const TELEGRAM_MAX_LEN = 4000;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set - see deploy/bot.env.example");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set - see deploy/bot.env.example");
  process.exit(1);
}

const client = new Anthropic();

// ---------- small utils ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function zonedParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

const todayStr = () => zonedParts().date;

function nowStamp() {
  return new Date().toLocaleString("en-US", {
    timeZone: TIME_ZONE, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateToMs = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const msToDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const round2 = (n) => Math.round(n * 100) / 100;

// Serialize everything that touches the conversation (incoming messages and
// the scheduled look-ahead) so two turns never interleave in one history.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- persistent bot state ----------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
const state = loadState();

// ---------- tracker API client ----------

async function tracker(method, route, body) {
  const res = await fetch(`${TRACKER_URL}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Tracker returned ${res.status}`);
  return data;
}

function resolveCompound(compounds, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { error: "No compound given." };
  const byId = compounds.find((c) => c.id.toLowerCase() === q);
  if (byId) return { compound: byId };
  const exact = compounds.filter((c) => c.name.toLowerCase() === q);
  if (exact.length === 1) return { compound: exact[0] };
  const partial = compounds.filter((c) => c.name.toLowerCase().startsWith(q) || (q.length >= 3 && c.name.toLowerCase().includes(q)));
  if (partial.length === 1) return { compound: partial[0] };
  const names = compounds.map((c) => c.name).join(", ");
  return { error: partial.length > 1 ? `"${query}" matches several compounds: ${partial.map((c) => c.name).join(", ")}.` : `No compound matches "${query}". Tracked compounds: ${names}.` };
}

function levelAt(tMs, pins, halfLifeDays) {
  let level = 0;
  for (const p of pins) {
    const doseMs = dateToMs(p.date);
    if (tMs >= doseMs) level += p.dose * Math.pow(0.5, (tMs - doseMs) / 86400000 / halfLifeDays);
  }
  return level;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- tools ----------

const TOOLS = [
  {
    name: "get_status",
    description: "Snapshot of everything tracked: every compound with its half-life, estimated amount in system today, last pin, usual pin interval and next expected pin date; plus latest weigh-ins. Call this first for summaries, look-aheads, or 'how am I doing' questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_pins",
    description: "List logged pins (injections), newest first, with their ids. Use to answer history questions or to find an entry id before deleting it.",
    input_schema: {
      type: "object",
      properties: {
        compound: { type: "string", description: "Optional compound name or partial name to filter by, e.g. 'reta'." },
        days: { type: "integer", description: "How many days back to include. Default 30." },
      },
    },
  },
  {
    name: "log_pin",
    description: "Record a pin (injection). Returns the saved entry including its id.",
    input_schema: {
      type: "object",
      properties: {
        compound: { type: "string", description: "Compound name or partial name, e.g. 'reta', 'tirzepatide'." },
        dose_mg: { type: "number", description: "Dose in milligrams. Convert mcg to mg (1000 mcg = 1 mg) before calling." },
        date: { type: "string", description: "YYYY-MM-DD. Omit for today. Resolve words like 'yesterday' against the timestamp on the user's message." },
        note: { type: "string", description: "Optional note, e.g. injection site." },
      },
      required: ["compound", "dose_mg"],
    },
  },
  {
    name: "delete_pin",
    description: "Delete a pin by id (from log_pin or list_pins). Use for 'undo' or corrections.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "log_weight",
    description: "Record a weigh-in. Returns the saved entry including its id.",
    input_schema: {
      type: "object",
      properties: {
        weight: { type: "number" },
        unit: { type: "string", enum: ["lb", "kg"], description: "Default lb." },
        date: { type: "string", description: "YYYY-MM-DD. Omit for today." },
        note: { type: "string" },
      },
      required: ["weight"],
    },
  },
  {
    name: "list_weights",
    description: "List weigh-ins, newest first, with their ids.",
    input_schema: { type: "object", properties: { days: { type: "integer", description: "How many days back. Default 60." } } },
  },
  {
    name: "delete_weight",
    description: "Delete a weigh-in by id.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "add_compound",
    description: "Start tracking a new compound. Only when the user asks to add one.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        half_life_days: { type: "number", description: "Half-life in days (hours / 24)." },
      },
      required: ["name", "half_life_days"],
    },
  },
  {
    name: "project_level",
    description: "Estimate how much of a compound will be (or was) in the system on a given date, from the logged pins only (assumes no additional pins).",
    input_schema: {
      type: "object",
      properties: { compound: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["compound", "date"],
    },
  },
];

function checkDate(date) {
  if (date === undefined || date === null || date === "") return todayStr();
  if (!DATE_RE.test(date)) throw new Error(`Date must be YYYY-MM-DD, got "${date}".`);
  return date;
}

const toolHandlers = {
  async get_status() {
    const [compounds, entries, weights] = await Promise.all([
      tracker("GET", "/api/compounds"), tracker("GET", "/api/entries"), tracker("GET", "/api/weight"),
    ]);
    const today = todayStr();
    const todayMs = dateToMs(today);
    const compoundStatus = compounds.map((c) => {
      const pins = entries.filter((e) => e.compoundId === c.id).sort((a, b) => a.date.localeCompare(b.date));
      const out = { name: c.name, half_life_days: c.halfLifeDays, pin_count: pins.length };
      if (pins.length === 0) return out;
      const last = pins[pins.length - 1];
      out.estimated_mg_in_system_today = round2(levelAt(todayMs, pins, c.halfLifeDays));
      out.last_pin = { date: last.date, dose_mg: last.dose, days_ago: Math.round((todayMs - dateToMs(last.date)) / 86400000) };
      const gaps = [];
      for (let i = Math.max(1, pins.length - 5); i < pins.length; i++) {
        const d = (dateToMs(pins[i].date) - dateToMs(pins[i - 1].date)) / 86400000;
        if (d > 0) gaps.push(d);
      }
      if (gaps.length) {
        const usual = median(gaps);
        out.usual_interval_days = usual;
        out.next_expected_pin = msToDate(dateToMs(last.date) + usual * 86400000);
      }
      return out;
    });
    const sortedW = [...weights].sort((a, b) => b.date.localeCompare(a.date));
    return {
      today,
      compounds: compoundStatus,
      recent_weigh_ins: sortedW.slice(0, 5).map((w) => ({ date: w.date, weight: w.weight, unit: w.unit })),
    };
  },

  async list_pins({ compound, days }) {
    const [compounds, entries] = await Promise.all([tracker("GET", "/api/compounds"), tracker("GET", "/api/entries")]);
    let filterId = null;
    if (compound) {
      const r = resolveCompound(compounds, compound);
      if (r.error) throw new Error(r.error);
      filterId = r.compound.id;
    }
    const since = dateToMs(todayStr()) - (Number.isInteger(days) && days > 0 ? days : 30) * 86400000;
    const nameOf = (id) => (compounds.find((c) => c.id === id) || {}).name || "Unknown";
    return entries
      .filter((e) => (!filterId || e.compoundId === filterId) && dateToMs(e.date) >= since)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((e) => ({ id: e.id, compound: nameOf(e.compoundId), date: e.date, dose_mg: e.dose, note: e.note || "" }));
  },

  async log_pin({ compound, dose_mg, date, note }) {
    if (typeof dose_mg !== "number" || !Number.isFinite(dose_mg) || dose_mg < 0) throw new Error("dose_mg must be a non-negative number.");
    const compounds = await tracker("GET", "/api/compounds");
    const r = resolveCompound(compounds, compound);
    if (r.error) throw new Error(r.error);
    const saved = await tracker("POST", "/api/entries", { compoundId: r.compound.id, date: checkDate(date), dose: dose_mg, note: note || "" });
    return { saved: { id: saved.id, compound: r.compound.name, date: saved.date, dose_mg: saved.dose, note: saved.note } };
  },

  async delete_pin({ id }) {
    await tracker("DELETE", `/api/entries/${encodeURIComponent(id)}`);
    return { deleted: id };
  },

  async log_weight({ weight, unit, date, note }) {
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) throw new Error("weight must be a positive number.");
    const u = unit || "lb";
    if (u !== "lb" && u !== "kg") throw new Error('unit must be "lb" or "kg".');
    const saved = await tracker("POST", "/api/weight", { date: checkDate(date), weight, unit: u, note: note || "" });
    return { saved };
  },

  async list_weights({ days }) {
    const weights = await tracker("GET", "/api/weight");
    const since = dateToMs(todayStr()) - (Number.isInteger(days) && days > 0 ? days : 60) * 86400000;
    return weights.filter((w) => dateToMs(w.date) >= since).sort((a, b) => b.date.localeCompare(a.date));
  },

  async delete_weight({ id }) {
    await tracker("DELETE", `/api/weight/${encodeURIComponent(id)}`);
    return { deleted: id };
  },

  async add_compound({ name, half_life_days }) {
    if (typeof half_life_days !== "number" || !(half_life_days > 0)) throw new Error("half_life_days must be a positive number.");
    return { saved: await tracker("POST", "/api/compounds", { name: String(name || "").trim(), halfLifeDays: half_life_days }) };
  },

  async project_level({ compound, date }) {
    if (!DATE_RE.test(date || "")) throw new Error("date must be YYYY-MM-DD.");
    const [compounds, entries] = await Promise.all([tracker("GET", "/api/compounds"), tracker("GET", "/api/entries")]);
    const r = resolveCompound(compounds, compound);
    if (r.error) throw new Error(r.error);
    const pins = entries.filter((e) => e.compoundId === r.compound.id);
    return { compound: r.compound.name, date, estimated_mg: round2(levelAt(dateToMs(date), pins, r.compound.halfLifeDays)) };
  },
};

async function runTool(block) {
  const handler = toolHandlers[block.name];
  try {
    if (!handler) throw new Error(`Unknown tool ${block.name}`);
    const input = block.input && typeof block.input === "object" ? block.input : {};
    const result = await handler(input);
    return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
  } catch (err) {
    return { type: "tool_result", tool_use_id: block.id, is_error: true, content: err.message };
  }
}

// ---------- Claude conversation ----------

const SYSTEM_PROMPT = `You are the user's personal assistant, reached by texting over Telegram. Right now your job is their health tracker: peptide injections ("pins") across several compounds, each with its own half-life, plus body-weight weigh-ins. Everything you record shows up in their Pin Tracker web app.

Each user message starts with a timestamp in their local time zone - use it to resolve "today", "yesterday", "last night", weekdays, and so on into YYYY-MM-DD dates.

How to work:
- Use the tools for every fact about their data. Never guess or invent numbers, dates, or entries.
- When they report a pin or a weigh-in, log it right away, then confirm in one short line what was saved (compound, dose, date). If something essential is missing or ambiguous (which compound, the dose), ask one short question instead of guessing.
- Doses are stored in mg. Convert mcg to mg before logging.
- For "undo" or corrections, delete the wrong entry (and log the right one if needed), then confirm.
- Amounts "in system" are estimates from a simple half-life decay model of their logged pins, not lab values. Say so briefly if they seem to treat it as exact.
- You are not their doctor. If they ask whether to change a dose, share the relevant numbers from their data and suggest checking with their prescriber rather than recommending a dose.

Style: this is texting. Keep replies short and scannable, in plain text - no markdown headers, tables, or bold. Short lines and simple dashes are fine. Latency-sensitive; begin your visible answer immediately.

Daily look-ahead: when a message says it is the automated morning check-in, call get_status and write a brief look-ahead for today: for each compound they actually pin, the estimated amount in system now and whether a pin is due today, overdue, or when the next one is expected (from their usual interval); then their latest weight and the recent trend. Calendar access is not connected yet, so don't mention a schedule. Keep it to a handful of lines.`;

let history = [];
let lastActivity = 0;

function resetSession() {
  history = [];
  lastActivity = 0;
}

function textOf(content) {
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

async function callClaude() {
  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: history,
    output_config: { effort: EFFORT },
    cache_control: { type: "ephemeral" },
  };
  if (MODEL === "claude-opus-5") {
    // Server-side refusal fallback: if Opus 5 declines, the API re-runs the
    // request on Anthropic's recommended fallback model instead of refusing.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return client.beta.messages.create(params);
}

// Runs one user turn through the tool loop and returns the reply text.
// History is append-only within a session; any failure starts a fresh session
// so a half-finished tool exchange can never poison later requests.
async function converse(userText) {
  if (Date.now() - lastActivity > SESSION_IDLE_MS || history.length > SESSION_MAX_MESSAGES) resetSession();
  lastActivity = Date.now();
  history.push({ role: "user", content: `[${nowStamp()}]\n${userText}` });

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const response = await callClaude();

      if (response.stop_reason === "refusal") {
        resetSession();
        return "Sorry, I can't help with that one.";
      }

      history.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        return textOf(response.content) || "Done.";
      }

      const results = await Promise.all(toolUses.map(runTool));
      history.push({ role: "user", content: results });
    }
    resetSession();
    return "That took more steps than I allow for one message - try asking in smaller pieces.";
  } catch (err) {
    resetSession();
    throw err;
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "My Claude API key was rejected. Check ANTHROPIC_API_KEY in the bot config, then restart the bot.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The Claude API denied access - check the key's workspace permissions and billing.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate-limiting me right now. Give it a minute and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "I couldn't reach Claude - is the container online?";
  if (err instanceof Anthropic.APIError) return `Claude API error (${err.status}). Try again in a bit.`;
  return `Something went wrong: ${err.message}`;
}

// ---------- Telegram ----------

async function telegram(method, body) {
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(70_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

async function sendText(chatId, text) {
  for (let i = 0; i < text.length; i += TELEGRAM_MAX_LEN) {
    await telegram("sendMessage", { chat_id: chatId, text: text.slice(i, i + TELEGRAM_MAX_LEN) });
  }
}

async function withTyping(chatId, fn) {
  const ping = () => telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  ping();
  const timer = setInterval(ping, 4500);
  try { return await fn(); } finally { clearInterval(timer); }
}

const HELP = `Text me like you'd text a person:
- "pinned 2.5 reta left thigh"
- "weighed 181.4 this morning"
- "how much tirz is in my system?"
- "undo that"

Commands:
/summary - today's look-ahead now
/new - start a fresh conversation
/help - this message`;

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const fromId = msg.from && msg.from.id;

  if (ALLOWED_USER_ID === null) {
    await sendText(chatId, `Your Telegram user ID is ${fromId}. Put TELEGRAM_ALLOWED_USER_ID=${fromId} in the bot config and restart the bot - until then I won't respond to anything else.`);
    return;
  }
  if (fromId !== ALLOWED_USER_ID || msg.chat.type !== "private") {
    console.log(`Ignored message from unauthorized user ${fromId}`);
    return;
  }
  if (typeof msg.text !== "string") {
    await sendText(chatId, "I can only read text messages for now.");
    return;
  }

  const text = msg.text.trim();
  const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : null;

  if (command === "/start" || command === "/help") {
    await sendText(chatId, HELP);
    return;
  }
  if (command === "/new") {
    await exclusive(async () => resetSession());
    await sendText(chatId, "Fresh start - I've cleared our conversation. Your tracker data is untouched.");
    return;
  }
  if (command === "/summary") {
    await sendLookahead({ manual: true });
    return;
  }

  await exclusive(async () => {
    try {
      const reply = await withTyping(chatId, () => converse(text));
      await sendText(chatId, reply);
    } catch (err) {
      console.error("Turn failed:", err.message);
      await sendText(chatId, describeError(err));
    }
  });
}

async function pollLoop() {
  let offset = state.telegramOffset || 0;
  let backoff = 2000;
  for (;;) {
    try {
      const updates = await telegram("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      backoff = 2000;
      for (const update of updates) {
        offset = update.update_id + 1;
        state.telegramOffset = offset;
        saveState(state);
        if (update.message) {
          await handleMessage(update.message).catch((err) => console.error("Handler error:", err.message));
        }
      }
    } catch (err) {
      console.error("Polling error:", err.message);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

// ---------- daily look-ahead ----------

let lastLookaheadAttempt = 0;

async function sendLookahead({ manual = false } = {}) {
  if (ALLOWED_USER_ID === null) return;
  await exclusive(async () => {
    try {
      resetSession();
      const reply = await withTyping(ALLOWED_USER_ID, () =>
        converse(manual
          ? "Give me today's look-ahead (the same summary as the automated morning check-in)."
          : "This is the automated morning check-in. Write today's look-ahead."));
      await sendText(ALLOWED_USER_ID, reply);
      if (!manual) {
        state.lastLookaheadDate = todayStr();
        saveState(state);
      }
    } catch (err) {
      console.error("Look-ahead failed:", err.message);
      if (manual) await sendText(ALLOWED_USER_ID, describeError(err)).catch(() => {});
    }
  });
}

function scheduleLookahead() {
  setInterval(() => {
    const now = zonedParts();
    // 4-hour window: a container rebooted mid-afternoon shouldn't send a "morning" summary.
    const due = now.hour >= LOOKAHEAD_HOUR && now.hour < LOOKAHEAD_HOUR + 4 && state.lastLookaheadDate !== now.date;
    // Retry a failed send at most every 10 minutes until the window closes.
    if (due && Date.now() - lastLookaheadAttempt > 10 * 60 * 1000) {
      lastLookaheadAttempt = Date.now();
      sendLookahead().catch(() => {});
    }
  }, 30_000);
}

// ---------- start ----------

console.log(`Pin Tracker bot starting (model ${MODEL}, tracker ${TRACKER_URL}, look-ahead ${LOOKAHEAD_HOUR}:00 ${TIME_ZONE})`);
if (ALLOWED_USER_ID === null) console.log("TELEGRAM_ALLOWED_USER_ID not set - the bot will only reply with the sender's user ID.");
scheduleLookahead();
pollLoop();
