(() => {
  "use strict";

  const STORAGE_KEY = "reta-tracker-entries";
  const THEME_KEY = "reta-tracker-theme";
  const API_BASE = "/api/entries";
  const HALF_LIFE_DAYS = 6;
  const FUTURE_PROJECTION_DAYS = 5;

  // ---------- date helpers (all day math done in UTC ms to avoid DST drift) ----------

  function dateStrToMs(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }

  function msToDateStr(ms) {
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function todayDateStr() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function addDays(ms, days) {
    return ms + days * 86400000;
  }

  function formatDateLabel(dateStr, opts = {}) {
    const ms = dateStrToMs(dateStr);
    return new Date(ms).toLocaleDateString(undefined, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: opts.year ? "numeric" : undefined,
    });
  }

  // ---------- state ----------

  let entries = [];
  let currentMonth = (() => {
    const t = new Date();
    return { year: t.getFullYear(), month: t.getMonth() }; // 0-indexed month
  })();
  let selectedDate = todayDateStr();
  let editingId = null;
  let chartRange = "all"; // "30" | "90" | "all"

  // "api"   - a backend (server.js) is present; entries live in its data file
  //           and are shared by every device that opens this page.
  // "local" - no backend responded (e.g. GitHub Pages); entries live only
  //           in this browser's localStorage, same as before.
  let storageMode = "local";

  function loadLocalEntries() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveLocalEntries() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* storage unavailable (private mode, quota) - fail silently */
    }
  }

  async function apiCreateEntry(entry) {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error("Failed to create entry");
    return res.json();
  }

  async function apiUpdateEntry(id, entry) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error("Failed to update entry");
    return res.json();
  }

  async function apiDeleteEntry(id) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) throw new Error("Failed to delete entry");
  }

  async function detectAndLoadEntries() {
    try {
      const res = await fetch(API_BASE, { headers: { Accept: "application/json" } });
      const contentType = res.headers.get("content-type") || "";
      if (res.ok && contentType.includes("application/json")) {
        storageMode = "api";
        const data = await res.json();
        return Array.isArray(data) ? data : [];
      }
    } catch {
      /* no backend reachable (e.g. static hosting) - fall back below */
    }
    storageMode = "local";
    return loadLocalEntries();
  }

  function entriesOnDate(dateStr) {
    return entries.filter((e) => e.date === dateStr);
  }

  function setFormBusy(busy) {
    document.getElementById("entry-submit").disabled = busy;
    document.getElementById("entry-cancel").disabled = busy;
  }

  function showError(message) {
    const banner = document.getElementById("error-banner");
    banner.textContent = message;
    banner.classList.remove("hidden");
  }

  function hideError() {
    document.getElementById("error-banner").classList.add("hidden");
  }

  function updateStorageBadge() {
    const badge = document.getElementById("storage-badge");
    badge.textContent = storageMode === "api" ? "Synced to server" : "Saved on this device only";
    badge.classList.toggle("is-synced", storageMode === "api");
  }

  // ---------- theme ----------

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
    updateThemeLabel();
  }

  function updateThemeLabel() {
    const attr = document.documentElement.getAttribute("data-theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = attr === "dark" || (!attr && systemDark);
    document.getElementById("theme-toggle-label").textContent = isDark ? "Light" : "Dark";
  }

  function toggleTheme() {
    const attr = document.documentElement.getAttribute("data-theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = attr === "dark" || (!attr && systemDark);
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    updateThemeLabel();
    renderChart();
  }

  // ---------- calendar ----------

  function renderCalendar() {
    const { year, month } = currentMonth;
    const label = new Date(year, month, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
    document.getElementById("cal-month-label").textContent = label;

    const grid = document.getElementById("calendar-grid");
    grid.innerHTML = "";

    const firstWeekday = new Date(year, month, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = todayDateStr();

    for (let i = 0; i < firstWeekday; i++) {
      const filler = document.createElement("div");
      filler.className = "cal-day is-empty";
      grid.appendChild(filler);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cal-day";
      if (dateStr === today) btn.classList.add("is-today");
      if (dateStr === selectedDate) btn.classList.add("is-selected");

      const num = document.createElement("span");
      num.textContent = String(day);
      btn.appendChild(num);

      if (entriesOnDate(dateStr).length > 0) {
        const dot = document.createElement("span");
        dot.className = "dot";
        btn.appendChild(dot);
      }

      btn.addEventListener("click", () => selectDate(dateStr));
      grid.appendChild(btn);
    }
  }

  function selectDate(dateStr) {
    selectedDate = dateStr;
    document.getElementById("entry-date").value = dateStr;
    renderCalendar();
    document.getElementById("entry-dose").focus();
  }

  // ---------- form ----------

  function initForm() {
    const dateInput = document.getElementById("entry-date");
    dateInput.value = selectedDate;
    dateInput.addEventListener("change", () => {
      if (dateInput.value) {
        selectedDate = dateInput.value;
        renderCalendar();
      }
    });

    document.getElementById("entry-form").addEventListener("submit", onSubmit);
    document.getElementById("entry-cancel").addEventListener("click", resetForm);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const date = document.getElementById("entry-date").value;
    const dose = parseFloat(document.getElementById("entry-dose").value);
    const note = document.getElementById("entry-note").value.trim();

    if (!date || !Number.isFinite(dose) || dose < 0) return;

    setFormBusy(true);
    try {
      if (storageMode === "api") {
        if (editingId) {
          const updated = await apiUpdateEntry(editingId, { date, dose, note });
          const idx = entries.findIndex((en) => en.id === editingId);
          if (idx !== -1) entries[idx] = updated;
        } else {
          entries.push(await apiCreateEntry({ date, dose, note }));
        }
      } else {
        if (editingId) {
          const entry = entries.find((en) => en.id === editingId);
          if (entry) {
            entry.date = date;
            entry.dose = dose;
            entry.note = note;
          }
        } else {
          entries.push({
            id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
            date,
            dose,
            note,
          });
        }
        saveLocalEntries();
      }
      hideError();
      resetForm();
      selectedDate = date;
      renderAll();
    } catch {
      showError("Couldn't save that entry - is the tracker server running?");
    } finally {
      setFormBusy(false);
    }
  }

  function resetForm() {
    editingId = null;
    document.getElementById("entry-id").value = "";
    document.getElementById("entry-dose").value = "";
    document.getElementById("entry-note").value = "";
    document.getElementById("entry-date").value = selectedDate;
    document.getElementById("entry-submit").textContent = "Add entry";
    document.getElementById("entry-cancel").classList.add("hidden");
  }

  function editEntry(id) {
    const entry = entries.find((en) => en.id === id);
    if (!entry) return;
    editingId = id;
    document.getElementById("entry-id").value = id;
    document.getElementById("entry-date").value = entry.date;
    document.getElementById("entry-dose").value = entry.dose;
    document.getElementById("entry-note").value = entry.note || "";
    document.getElementById("entry-submit").textContent = "Save changes";
    document.getElementById("entry-cancel").classList.remove("hidden");
    selectedDate = entry.date;
    renderCalendar();
    window.scrollTo({ top: document.getElementById("form-heading").offsetTop - 20, behavior: "smooth" });
  }

  async function deleteEntry(id) {
    const entry = entries.find((en) => en.id === id);
    if (!entry) return;
    const label = `${formatDateLabel(entry.date, { year: true })} — ${entry.dose} mg`;
    if (!window.confirm(`Delete this entry?\n${label}`)) return;

    try {
      if (storageMode === "api") await apiDeleteEntry(id);
      entries = entries.filter((en) => en.id !== id);
      if (storageMode === "local") saveLocalEntries();
      if (editingId === id) resetForm();
      hideError();
      renderAll();
    } catch {
      showError("Couldn't delete that entry - is the tracker server running?");
    }
  }

  // ---------- entries list ----------

  function renderEntriesList() {
    const list = document.getElementById("entries-list");
    const empty = document.getElementById("entries-empty");
    list.querySelectorAll(".entry-row").forEach((row) => row.remove());

    const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : -1));
    empty.classList.toggle("hidden", sorted.length > 0);

    for (const entry of sorted) {
      const row = document.createElement("div");
      row.className = "entry-row";

      const main = document.createElement("div");
      main.className = "entry-main";
      main.addEventListener("click", () => editEntry(entry.id));

      const dateEl = document.createElement("span");
      dateEl.className = "entry-date";
      dateEl.textContent = formatDateLabel(entry.date, { year: true });
      main.appendChild(dateEl);

      const metaEl = document.createElement("span");
      metaEl.className = "entry-meta";
      metaEl.textContent = entry.note ? `${entry.dose} mg · ${entry.note}` : `${entry.dose} mg`;
      main.appendChild(metaEl);

      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "entry-row-actions";

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-ghost btn-danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteEntry(entry.id));
      actions.appendChild(delBtn);

      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  // ---------- pharmacokinetics ----------

  function levelAt(tMs) {
    let level = 0;
    for (const e of entries) {
      const doseMs = dateStrToMs(e.date);
      if (tMs >= doseMs) {
        const deltaDays = (tMs - doseMs) / 86400000;
        level += e.dose * Math.pow(0.5, deltaDays / HALF_LIFE_DAYS);
      }
    }
    return level;
  }

  function computeSeries(startMs, endMs, stepHours, extraTimes = []) {
    const stepMs = stepHours * 3600000;
    const times = new Set();
    for (let t = startMs; t <= endMs; t += stepMs) times.add(t);
    times.add(endMs);
    for (const t of extraTimes) {
      if (t >= startMs && t <= endMs) times.add(t);
    }
    return [...times].sort((a, b) => a - b).map((t) => ({ t, level: levelAt(t) }));
  }

  function niceMax(value) {
    if (value <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const normalized = value / magnitude;
    let nice;
    if (normalized <= 1) nice = 1;
    else if (normalized <= 2) nice = 2;
    else if (normalized <= 5) nice = 5;
    else nice = 10;
    return nice * magnitude;
  }

  // ---------- stat tile ----------

  function renderStat() {
    const todayMs = dateStrToMs(todayDateStr());
    const level = levelAt(todayMs);
    document.getElementById("stat-value").textContent = `${level.toFixed(2)} mg`;

    const sub = document.getElementById("stat-sub");
    if (entries.length === 0) {
      sub.textContent = "No entries logged yet";
    } else {
      const last = [...entries].sort((a, b) => (a.date > b.date ? -1 : 1))[0];
      sub.textContent = `Last pin: ${formatDateLabel(last.date)} · ${last.dose} mg`;
    }
  }

  // ---------- chart ----------

  function initChartControls() {
    document.querySelectorAll(".range-controls .btn-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        chartRange = btn.dataset.range;
        document.querySelectorAll(".range-controls .btn-pill").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        renderChart();
      });
    });
  }

  function renderChart() {
    const svg = document.getElementById("chart-svg");
    const emptyState = document.getElementById("chart-empty");
    const tooltip = document.getElementById("chart-tooltip");
    svg.innerHTML = "";

    if (entries.length === 0) {
      emptyState.classList.remove("hidden");
      svg.classList.add("hidden");
      tooltip.classList.add("hidden");
      return;
    }
    emptyState.classList.add("hidden");
    svg.classList.remove("hidden");

    const todayMs = dateStrToMs(todayDateStr());
    const earliestEntryMs = Math.min(...entries.map((e) => dateStrToMs(e.date)));
    const endMs = addDays(todayMs, FUTURE_PROJECTION_DAYS);

    let startMs;
    if (chartRange === "30") startMs = addDays(todayMs, -29);
    else if (chartRange === "90") startMs = addDays(todayMs, -89);
    else startMs = Math.min(earliestEntryMs, todayMs);

    const totalDays = (endMs - startMs) / 86400000;
    const stepHours = totalDays > 120 ? 24 : 6;
    const points = computeSeries(startMs, endMs, stepHours, [todayMs]);

    const maxLevel = Math.max(...points.map((p) => p.level), 0);
    const yMax = niceMax(maxLevel * 1.15 || 1);

    const width = 760;
    const height = 280;
    const margin = { top: 14, right: 16, bottom: 28, left: 46 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");

    const xForT = (t) => margin.left + ((t - startMs) / (endMs - startMs)) * plotW;
    const yForLevel = (level) => margin.top + plotH - (level / yMax) * plotH;

    const ns = "http://www.w3.org/2000/svg";
    const el = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const k in attrs) node.setAttribute(k, attrs[k]);
      return node;
    };

    // gridlines + y labels
    const yTickCount = 4;
    for (let i = 0; i <= yTickCount; i++) {
      const val = (yMax / yTickCount) * i;
      const y = yForLevel(val);
      svg.appendChild(el("line", {
        x1: margin.left, x2: width - margin.right, y1: y, y2: y,
        class: "grid-line",
      }));
      const label = el("text", {
        x: margin.left - 8, y: y + 4, class: "axis-label", "text-anchor": "end",
      });
      label.textContent = val >= 10 ? Math.round(val) : val.toFixed(1);
      svg.appendChild(label);
    }

    // x labels
    const xTickCount = Math.min(6, Math.max(2, Math.round(totalDays / (totalDays > 120 ? 30 : totalDays > 30 ? 14 : 5))));
    for (let i = 0; i <= xTickCount; i++) {
      const t = startMs + ((endMs - startMs) * i) / xTickCount;
      const x = xForT(t);
      const label = el("text", {
        x, y: height - 6, class: "axis-label", "text-anchor": i === 0 ? "start" : i === xTickCount ? "end" : "middle",
      });
      label.textContent = new Date(t).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
      svg.appendChild(label);
    }

    // baseline
    svg.appendChild(el("line", {
      x1: margin.left, x2: width - margin.right, y1: margin.top + plotH, y2: margin.top + plotH,
      class: "axis-baseline",
    }));

    // today reference line
    const todayInRange = todayMs >= startMs && todayMs <= endMs;
    if (todayInRange) {
      const x = xForT(todayMs);
      svg.appendChild(el("line", {
        x1: x, x2: x, y1: margin.top, y2: margin.top + plotH, class: "today-line",
      }));
    }

    // split into historical (actual pins so far) and projected (decay assuming no further doses)
    const histPoints = points.filter((p) => p.t <= todayMs);
    const projPoints = points.filter((p) => p.t >= todayMs);
    const toPx = (pts) => pts.map((p) => [xForT(p.t), yForLevel(p.level)]);
    const toLinePath = (px) => px.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");

    if (histPoints.length > 0) {
      const histPx = toPx(histPoints);
      const areaPath = `${toLinePath(histPx)} L${histPx[histPx.length - 1][0].toFixed(2)},${margin.top + plotH} L${histPx[0][0].toFixed(2)},${margin.top + plotH} Z`;
      svg.appendChild(el("path", { d: areaPath, class: "area-fill" }));
      svg.appendChild(el("path", { d: toLinePath(histPx), class: "level-line" }));
    }
    if (projPoints.length > 1) {
      svg.appendChild(el("path", { d: toLinePath(toPx(projPoints)), class: "level-line-projected" }));
    }

    // dose markers
    for (const entry of entries) {
      const doseMs = dateStrToMs(entry.date);
      if (doseMs < startMs || doseMs > endMs) continue;
      const level = levelAt(doseMs);
      const cx = xForT(doseMs);
      const cy = yForLevel(level);
      svg.appendChild(el("circle", { cx, cy, r: 4, class: "dose-marker" }));
    }

    // muted marker at the far projected edge (no heavy label - it's an estimate, not the headline number)
    const tail = points[points.length - 1];
    svg.appendChild(el("circle", { cx: xForT(tail.t), cy: yForLevel(tail.level), r: 3, class: "tail-marker" }));

    // bold "today" marker + label - this is the number that matters
    if (todayInRange) {
      const todayPoint = points.find((p) => p.t === todayMs) || { t: todayMs, level: levelAt(todayMs) };
      const tx = xForT(todayPoint.t);
      const ty = yForLevel(todayPoint.level);
      svg.appendChild(el("circle", { cx: tx, cy: ty, r: 4, class: "end-marker" }));
      const nearRightEdge = tx > width - margin.right - 70;
      const label = el("text", {
        x: nearRightEdge ? tx - 8 : tx + 8,
        y: Math.max(ty - 10, margin.top + 10),
        class: "end-label",
        "text-anchor": nearRightEdge ? "end" : "start",
      });
      label.textContent = `Today · ${todayPoint.level.toFixed(2)} mg`;
      svg.appendChild(label);
    }

    // hover layer
    const hoverLine = el("line", { x1: 0, x2: 0, y1: margin.top, y2: margin.top + plotH, class: "hover-line hidden" });
    const hoverDot = el("circle", { r: 4, class: "hover-dot hidden" });
    svg.appendChild(hoverLine);
    svg.appendChild(hoverDot);

    const hitRect = el("rect", {
      x: margin.left, y: margin.top, width: plotW, height: plotH, fill: "transparent",
      "pointer-events": "all",
    });
    hitRect.style.cursor = "crosshair";
    svg.appendChild(hitRect);

    function onMove(evt) {
      const rect = svg.getBoundingClientRect();
      const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
      const relX = ((clientX - rect.left) / rect.width) * width;
      const t = startMs + ((relX - margin.left) / plotW) * (endMs - startMs);
      if (t < startMs || t > endMs) return;

      let nearest = points[0];
      let nearestDiff = Infinity;
      for (const p of points) {
        const diff = Math.abs(p.t - t);
        if (diff < nearestDiff) { nearestDiff = diff; nearest = p; }
      }

      const px = xForT(nearest.t);
      const py = yForLevel(nearest.level);
      hoverLine.setAttribute("x1", px);
      hoverLine.setAttribute("x2", px);
      hoverLine.classList.remove("hidden");
      hoverDot.setAttribute("cx", px);
      hoverDot.setAttribute("cy", py);
      hoverDot.classList.remove("hidden");

      const dateLabel = new Date(nearest.t).toLocaleDateString(undefined, {
        timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
        hour: stepHours < 24 ? "numeric" : undefined,
      });
      tooltip.innerHTML = `<div class="tt-date">${dateLabel}</div><div class="tt-value">${nearest.level.toFixed(2)} mg</div>`;
      tooltip.style.left = `${(px / width) * 100}%`;
      tooltip.style.top = `${(py / height) * 100}%`;
      tooltip.classList.remove("hidden");
    }

    function onLeave() {
      hoverLine.classList.add("hidden");
      hoverDot.classList.add("hidden");
      tooltip.classList.add("hidden");
    }

    hitRect.addEventListener("mousemove", onMove);
    hitRect.addEventListener("mouseleave", onLeave);
    hitRect.addEventListener("touchmove", (e) => { onMove(e); }, { passive: true });
    hitRect.addEventListener("touchend", onLeave);
  }

  // ---------- init ----------

  function renderAll() {
    renderCalendar();
    renderStat();
    renderChart();
    renderEntriesList();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("halflife-label").textContent = String(HALF_LIFE_DAYS);

    initTheme();
    document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeLabel);

    document.getElementById("cal-prev").addEventListener("click", () => {
      currentMonth.month -= 1;
      if (currentMonth.month < 0) { currentMonth.month = 11; currentMonth.year -= 1; }
      renderCalendar();
    });
    document.getElementById("cal-next").addEventListener("click", () => {
      currentMonth.month += 1;
      if (currentMonth.month > 11) { currentMonth.month = 0; currentMonth.year += 1; }
      renderCalendar();
    });

    initForm();
    initChartControls();

    entries = await detectAndLoadEntries();
    updateStorageBadge();
    renderAll();
  });
})();
