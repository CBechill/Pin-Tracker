(() => {
  "use strict";

  const THEME_KEY = "reta-tracker-theme";
  const LOCAL_KEYS = {
    compounds: "reta-tracker-compounds",
    entries: "reta-tracker-entries",
    weight: "reta-tracker-weight",
  };
  const API = {
    compounds: "/api/compounds",
    entries: "/api/entries",
    weight: "/api/weight",
  };
  const FUTURE_PROJECTION_DAYS = 5;
  const CATEGORY_COUNT = 8;

  const DEFAULT_COMPOUNDS = [
    { id: "retatrutide", name: "Retatrutide", halfLifeDays: 6 },
    { id: "tirzepatide", name: "Tirzepatide", halfLifeDays: 5 },
    { id: "semaglutide", name: "Semaglutide", halfLifeDays: 7 },
    { id: "cagrilintide", name: "Cagrilintide", halfLifeDays: 8 },
  ];

  // ---------- date helpers (all day math done in UTC ms to avoid DST drift) ----------

  function dateStrToMs(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
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

  let compounds = [];
  let entries = [];
  let weightEntries = [];

  let currentMonth = (() => {
    const t = new Date();
    return { year: t.getFullYear(), month: t.getMonth() }; // 0-indexed month
  })();
  let selectedDate = todayDateStr();
  let editingId = null; // pin entry being edited
  let editingCompoundId = null;
  let weightEditingId = null;
  let chartRange = "all"; // "30" | "90" | "all"
  let weightRange = "all";
  let selectedChartCompoundId = null;

  // "api"   - a backend (server.js) is present; data lives in its JSON files
  //           and is shared by every device that opens this page.
  // "local" - no backend responded (e.g. GitHub Pages); data lives only in
  //           this browser's localStorage.
  let storageMode = "local";

  // ---------- storage: local fallback ----------

  function loadLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function saveLocal(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable (private mode, quota) - fail silently */
    }
  }

  // ---------- storage: API ----------

  async function apiCreate(base, body) {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || "Request failed");
    }
    return res.json();
  }

  async function apiUpdate(base, id, body) {
    const res = await fetch(`${base}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || "Request failed");
    }
    return res.json();
  }

  async function apiDelete(base, id) {
    const res = await fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || "Request failed");
    }
  }

  function migrateLocalEntries(rawEntries) {
    let changed = false;
    const migrated = rawEntries.map((e) => {
      if (e.compoundId) return e;
      changed = true;
      return { ...e, compoundId: "retatrutide" };
    });
    if (changed) saveLocal(LOCAL_KEYS.entries, migrated);
    return migrated;
  }

  async function detectAndLoadAll() {
    try {
      const res = await fetch(API.compounds, { headers: { Accept: "application/json" } });
      const contentType = res.headers.get("content-type") || "";
      if (res.ok && contentType.includes("application/json")) {
        storageMode = "api";
        const [compoundsData, entriesData, weightData] = await Promise.all([
          res.json(),
          fetch(API.entries).then((r) => r.json()),
          fetch(API.weight).then((r) => r.json()),
        ]);
        return {
          compounds: Array.isArray(compoundsData) && compoundsData.length ? compoundsData : DEFAULT_COMPOUNDS,
          entries: Array.isArray(entriesData) ? entriesData : [],
          weight: Array.isArray(weightData) ? weightData : [],
        };
      }
    } catch {
      /* no backend reachable (e.g. static hosting) - fall back below */
    }
    storageMode = "local";
    const localCompounds = loadLocal(LOCAL_KEYS.compounds, null);
    return {
      compounds: localCompounds && localCompounds.length ? localCompounds : DEFAULT_COMPOUNDS,
      entries: migrateLocalEntries(loadLocal(LOCAL_KEYS.entries, [])),
      weight: loadLocal(LOCAL_KEYS.weight, []),
    };
  }

  // ---------- compound helpers ----------

  function getCompound(id) {
    return compounds.find((c) => c.id === id) || { id, name: "Unknown compound", halfLifeDays: 6 };
  }

  function compoundColorClass(id) {
    const idx = compounds.findIndex((c) => c.id === id);
    return `cat-${((idx < 0 ? 0 : idx) % CATEGORY_COUNT)}`;
  }

  function populateCompoundSelect(selectEl, selectedId) {
    selectEl.innerHTML = "";
    if (compounds.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Add a compound below first";
      opt.disabled = true;
      opt.selected = true;
      selectEl.appendChild(opt);
      return;
    }
    for (const c of compounds) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.halfLifeDays}d half-life)`;
      if (c.id === selectedId) opt.selected = true;
      selectEl.appendChild(opt);
    }
  }

  // ---------- ui helpers ----------

  function setFormBusy(formId, busy) {
    document.querySelectorAll(`#${formId} button`).forEach((btn) => { btn.disabled = busy; });
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
    renderWeightChart();
  }

  // ---------- calendar ----------

  function entriesOnDate(dateStr) {
    return entries.filter((e) => e.date === dateStr);
  }

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

      const dayCompoundIds = [...new Set(entriesOnDate(dateStr).map((e) => e.compoundId))];
      if (dayCompoundIds.length > 0) {
        const dots = document.createElement("span");
        dots.className = "cal-day-dots";
        for (const compoundId of dayCompoundIds.slice(0, 4)) {
          const dot = document.createElement("span");
          dot.className = `dot ${compoundColorClass(compoundId)}`;
          dots.appendChild(dot);
        }
        btn.appendChild(dots);
      }

      btn.addEventListener("click", () => selectDate(dateStr));
      grid.appendChild(btn);
    }

    renderCalendarLegend();
  }

  function renderCalendarLegend() {
    const legend = document.getElementById("calendar-legend");
    legend.querySelectorAll(".legend-item").forEach((el) => el.remove());
    for (const c of compounds) {
      const item = document.createElement("span");
      item.className = "legend-item";
      const dot = document.createElement("span");
      dot.className = `legend-dot ${compoundColorClass(c.id)}`;
      item.appendChild(dot);
      item.append(c.name);
      legend.appendChild(item);
    }
  }

  function selectDate(dateStr) {
    selectedDate = dateStr;
    document.getElementById("entry-date").value = dateStr;
    renderCalendar();
    document.getElementById("entry-dose").focus();
  }

  // ---------- pin form ----------

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
    const compoundId = document.getElementById("entry-compound").value;
    const date = document.getElementById("entry-date").value;
    const dose = parseFloat(document.getElementById("entry-dose").value);
    const note = document.getElementById("entry-note").value.trim();

    if (!compoundId || !date || !Number.isFinite(dose) || dose < 0) return;

    setFormBusy("entry-form", true);
    try {
      if (storageMode === "api") {
        if (editingId) {
          const updated = await apiUpdate(API.entries, editingId, { compoundId, date, dose, note });
          const idx = entries.findIndex((en) => en.id === editingId);
          if (idx !== -1) entries[idx] = updated;
        } else {
          entries.push(await apiCreate(API.entries, { compoundId, date, dose, note }));
        }
      } else {
        if (editingId) {
          const entry = entries.find((en) => en.id === editingId);
          if (entry) Object.assign(entry, { compoundId, date, dose, note });
        } else {
          entries.push({
            id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())),
            compoundId, date, dose, note,
          });
        }
        saveLocal(LOCAL_KEYS.entries, entries);
      }
      hideError();
      resetForm();
      selectedDate = date;
      selectedChartCompoundId = compoundId;
      renderAll();
    } catch (err) {
      showError(err.message || "Couldn't save that entry - is the tracker server running?");
    } finally {
      setFormBusy("entry-form", false);
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
    const select = document.getElementById("entry-compound");
    const keep = select.value || (compounds[0] && compounds[0].id);
    populateCompoundSelect(select, keep);
  }

  function editEntry(id) {
    const entry = entries.find((en) => en.id === id);
    if (!entry) return;
    editingId = id;
    document.getElementById("entry-id").value = id;
    populateCompoundSelect(document.getElementById("entry-compound"), entry.compoundId);
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
    const label = `${getCompound(entry.compoundId).name} — ${formatDateLabel(entry.date, { year: true })} — ${entry.dose} mg`;
    if (!window.confirm(`Delete this entry?\n${label}`)) return;

    try {
      if (storageMode === "api") await apiDelete(API.entries, id);
      entries = entries.filter((en) => en.id !== id);
      if (storageMode === "local") saveLocal(LOCAL_KEYS.entries, entries);
      if (editingId === id) resetForm();
      hideError();
      renderAll();
    } catch (err) {
      showError(err.message || "Couldn't delete that entry - is the tracker server running?");
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
      const compound = getCompound(entry.compoundId);
      const row = document.createElement("div");
      row.className = "entry-row";

      const main = document.createElement("div");
      main.className = "entry-main";
      main.addEventListener("click", () => editEntry(entry.id));

      const tag = document.createElement("span");
      tag.className = "entry-compound-tag";
      const swatch = document.createElement("span");
      swatch.className = `swatch ${compoundColorClass(entry.compoundId)}`;
      tag.appendChild(swatch);
      tag.append(compound.name);
      main.appendChild(tag);

      const metaEl = document.createElement("span");
      metaEl.className = "entry-meta";
      const dateLabel = formatDateLabel(entry.date, { year: true });
      metaEl.textContent = entry.note ? `${dateLabel} · ${entry.dose} mg · ${entry.note}` : `${dateLabel} · ${entry.dose} mg`;
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

  // ---------- compounds management ----------

  function renderCompoundsList() {
    const list = document.getElementById("compounds-list");
    list.innerHTML = "";
    for (const c of compounds) {
      const row = document.createElement("div");
      row.className = "compound-row";

      const swatch = document.createElement("span");
      swatch.className = `compound-swatch ${compoundColorClass(c.id)}`;
      row.appendChild(swatch);

      const info = document.createElement("div");
      info.className = "compound-info";
      const name = document.createElement("span");
      name.className = "compound-name";
      name.textContent = c.name;
      const meta = document.createElement("span");
      meta.className = "compound-meta";
      const count = entries.filter((e) => e.compoundId === c.id).length;
      meta.textContent = `${c.halfLifeDays}-day half-life · ${count} entr${count === 1 ? "y" : "ies"}`;
      info.append(name, meta);
      row.appendChild(info);

      const actions = document.createElement("div");
      actions.className = "compound-row-actions";
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "btn btn-ghost";
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", () => editCompound(c.id));
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-ghost btn-danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteCompound(c.id));
      actions.append(editBtn, delBtn);
      row.appendChild(actions);

      list.appendChild(row);
    }
  }

  function initCompoundForm() {
    document.getElementById("compound-form").addEventListener("submit", onCompoundSubmit);
    document.getElementById("compound-cancel").addEventListener("click", resetCompoundForm);
  }

  async function onCompoundSubmit(e) {
    e.preventDefault();
    const name = document.getElementById("compound-name").value.trim();
    const halfLifeDays = parseFloat(document.getElementById("compound-halflife").value);
    if (!name || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return;

    setFormBusy("compound-form", true);
    try {
      if (storageMode === "api") {
        if (editingCompoundId) {
          const updated = await apiUpdate(API.compounds, editingCompoundId, { name, halfLifeDays });
          const idx = compounds.findIndex((c) => c.id === editingCompoundId);
          if (idx !== -1) compounds[idx] = updated;
        } else {
          compounds.push(await apiCreate(API.compounds, { name, halfLifeDays }));
        }
      } else {
        if (editingCompoundId) {
          const c = compounds.find((c) => c.id === editingCompoundId);
          if (c) Object.assign(c, { name, halfLifeDays });
        } else {
          compounds.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), name, halfLifeDays });
        }
        saveLocal(LOCAL_KEYS.compounds, compounds);
      }
      hideError();
      resetCompoundForm();
      if (!selectedChartCompoundId) selectedChartCompoundId = compounds[0] && compounds[0].id;
      renderAll();
    } catch (err) {
      showError(err.message || "Couldn't save that compound - is the tracker server running?");
    } finally {
      setFormBusy("compound-form", false);
    }
  }

  function resetCompoundForm() {
    editingCompoundId = null;
    document.getElementById("compound-id").value = "";
    document.getElementById("compound-name").value = "";
    document.getElementById("compound-halflife").value = "";
    document.getElementById("compound-submit").textContent = "Add compound";
    document.getElementById("compound-cancel").classList.add("hidden");
  }

  function editCompound(id) {
    const c = compounds.find((c) => c.id === id);
    if (!c) return;
    editingCompoundId = id;
    document.getElementById("compound-id").value = id;
    document.getElementById("compound-name").value = c.name;
    document.getElementById("compound-halflife").value = c.halfLifeDays;
    document.getElementById("compound-submit").textContent = "Save changes";
    document.getElementById("compound-cancel").classList.remove("hidden");
    window.scrollTo({ top: document.getElementById("compounds-heading").offsetTop - 20, behavior: "smooth" });
  }

  async function deleteCompound(id) {
    const c = compounds.find((c) => c.id === id);
    if (!c) return;
    const inUse = entries.some((e) => e.compoundId === id);
    if (inUse) {
      showError(`Can't delete ${c.name} - delete its pin history first.`);
      return;
    }
    if (!window.confirm(`Delete ${c.name}?`)) return;

    try {
      if (storageMode === "api") await apiDelete(API.compounds, id);
      compounds = compounds.filter((c) => c.id !== id);
      if (storageMode === "local") saveLocal(LOCAL_KEYS.compounds, compounds);
      if (editingCompoundId === id) resetCompoundForm();
      if (selectedChartCompoundId === id) selectedChartCompoundId = compounds[0] && compounds[0].id;
      hideError();
      renderAll();
    } catch (err) {
      showError(err.message || "Couldn't delete that compound - is the tracker server running?");
    }
  }

  // ---------- pharmacokinetics ----------

  function levelAt(tMs, entryList, halfLifeDays) {
    let level = 0;
    for (const e of entryList) {
      const doseMs = dateStrToMs(e.date);
      if (tMs >= doseMs) {
        const deltaDays = (tMs - doseMs) / 86400000;
        level += e.dose * Math.pow(0.5, deltaDays / halfLifeDays);
      }
    }
    return level;
  }

  function computeSeries(startMs, endMs, stepHours, extraTimes, entryList, halfLifeDays) {
    const stepMs = stepHours * 3600000;
    const times = new Set();
    for (let t = startMs; t <= endMs; t += stepMs) times.add(t);
    times.add(endMs);
    for (const t of extraTimes) {
      if (t >= startMs && t <= endMs) times.add(t);
    }
    return [...times].sort((a, b) => a - b).map((t) => ({ t, level: levelAt(t, entryList, halfLifeDays) }));
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

  const ns = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const node = document.createElementNS(ns, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  // ---------- pin chart + stat ----------

  function initChartControls() {
    document.querySelectorAll(".range-controls .btn-pill[data-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        chartRange = btn.dataset.range;
        document.querySelectorAll(".range-controls .btn-pill[data-range]").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        renderChart();
      });
    });
    document.getElementById("chart-compound-select").addEventListener("change", (e) => {
      selectedChartCompoundId = e.target.value;
      renderStat();
      renderChart();
    });
  }

  function renderStat() {
    if (!selectedChartCompoundId || compounds.length === 0) {
      document.getElementById("stat-value").textContent = "0 mg";
      document.getElementById("stat-sub").textContent = "Add a compound to get started";
      return;
    }
    const compound = getCompound(selectedChartCompoundId);
    const compoundEntries = entries.filter((e) => e.compoundId === selectedChartCompoundId);
    const todayMs = dateStrToMs(todayDateStr());
    const level = levelAt(todayMs, compoundEntries, compound.halfLifeDays);
    document.getElementById("stat-label").textContent = `Estimated ${compound.name} level today`;
    document.getElementById("stat-value").textContent = `${level.toFixed(2)} mg`;

    const sub = document.getElementById("stat-sub");
    if (compoundEntries.length === 0) {
      sub.textContent = "No entries logged for this compound yet";
    } else {
      const last = [...compoundEntries].sort((a, b) => (a.date > b.date ? -1 : 1))[0];
      sub.textContent = `Last pin: ${formatDateLabel(last.date)} · ${last.dose} mg`;
    }
  }

  function renderChart() {
    const svg = document.getElementById("chart-svg");
    const emptyState = document.getElementById("chart-empty");
    const tooltip = document.getElementById("chart-tooltip");
    const container = document.getElementById("chart-container");
    svg.innerHTML = "";

    const compound = selectedChartCompoundId ? getCompound(selectedChartCompoundId) : null;
    document.getElementById("chart-subtitle").textContent = compound
      ? `${compound.name} · ${compound.halfLifeDays}-day half-life · dashed = projected, assuming no further pins`
      : "Add a compound to see a projection here";

    container.className = "chart-container " + (compound ? compoundColorClass(compound.id) : "");

    const compoundEntries = compound ? entries.filter((e) => e.compoundId === compound.id) : [];
    if (!compound || compoundEntries.length === 0) {
      emptyState.classList.remove("hidden");
      svg.classList.add("hidden");
      tooltip.classList.add("hidden");
      return;
    }
    emptyState.classList.add("hidden");
    svg.classList.remove("hidden");

    const halfLifeDays = compound.halfLifeDays;
    const todayMs = dateStrToMs(todayDateStr());
    const earliestEntryMs = Math.min(...compoundEntries.map((e) => dateStrToMs(e.date)));
    const endMs = addDays(todayMs, FUTURE_PROJECTION_DAYS);

    let startMs;
    if (chartRange === "30") startMs = addDays(todayMs, -29);
    else if (chartRange === "90") startMs = addDays(todayMs, -89);
    else startMs = Math.min(earliestEntryMs, todayMs);

    const totalDays = (endMs - startMs) / 86400000;
    const stepHours = totalDays > 120 ? 24 : 6;
    const points = computeSeries(startMs, endMs, stepHours, [todayMs], compoundEntries, halfLifeDays);

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

    // gridlines + y labels
    const yTickCount = 4;
    for (let i = 0; i <= yTickCount; i++) {
      const val = (yMax / yTickCount) * i;
      const y = yForLevel(val);
      svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: "grid-line" }));
      const label = svgEl("text", { x: margin.left - 8, y: y + 4, class: "axis-label", "text-anchor": "end" });
      label.textContent = val >= 10 ? Math.round(val) : val.toFixed(1);
      svg.appendChild(label);
    }

    // x labels
    const xTickCount = Math.min(6, Math.max(2, Math.round(totalDays / (totalDays > 120 ? 30 : totalDays > 30 ? 14 : 5))));
    for (let i = 0; i <= xTickCount; i++) {
      const t = startMs + ((endMs - startMs) * i) / xTickCount;
      const x = xForT(t);
      const label = svgEl("text", { x, y: height - 6, class: "axis-label", "text-anchor": i === 0 ? "start" : i === xTickCount ? "end" : "middle" });
      label.textContent = new Date(t).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
      svg.appendChild(label);
    }

    // baseline
    svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: margin.top + plotH, y2: margin.top + plotH, class: "axis-baseline" }));

    // today reference line
    const todayInRange = todayMs >= startMs && todayMs <= endMs;
    if (todayInRange) {
      const x = xForT(todayMs);
      svg.appendChild(svgEl("line", { x1: x, x2: x, y1: margin.top, y2: margin.top + plotH, class: "today-line" }));
    }

    // split into historical (actual pins so far) and projected (decay assuming no further doses)
    const histPoints = points.filter((p) => p.t <= todayMs);
    const projPoints = points.filter((p) => p.t >= todayMs);
    const toPx = (pts) => pts.map((p) => [xForT(p.t), yForLevel(p.level)]);
    const toLinePath = (px) => px.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");

    if (histPoints.length > 0) {
      const histPx = toPx(histPoints);
      const areaPath = `${toLinePath(histPx)} L${histPx[histPx.length - 1][0].toFixed(2)},${margin.top + plotH} L${histPx[0][0].toFixed(2)},${margin.top + plotH} Z`;
      svg.appendChild(svgEl("path", { d: areaPath, class: "area-fill" }));
      svg.appendChild(svgEl("path", { d: toLinePath(histPx), class: "level-line" }));
    }
    if (projPoints.length > 1) {
      svg.appendChild(svgEl("path", { d: toLinePath(toPx(projPoints)), class: "level-line-projected" }));
    }

    // dose markers
    for (const entry of compoundEntries) {
      const doseMs = dateStrToMs(entry.date);
      if (doseMs < startMs || doseMs > endMs) continue;
      const level = levelAt(doseMs, compoundEntries, halfLifeDays);
      svg.appendChild(svgEl("circle", { cx: xForT(doseMs), cy: yForLevel(level), r: 4, class: "dose-marker" }));
    }

    // muted marker at the far projected edge (no heavy label - it's an estimate, not the headline number)
    const tail = points[points.length - 1];
    svg.appendChild(svgEl("circle", { cx: xForT(tail.t), cy: yForLevel(tail.level), r: 3, class: "tail-marker" }));

    // bold "today" marker + label - this is the number that matters
    if (todayInRange) {
      const todayPoint = points.find((p) => p.t === todayMs) || { t: todayMs, level: levelAt(todayMs, compoundEntries, halfLifeDays) };
      const tx = xForT(todayPoint.t);
      const ty = yForLevel(todayPoint.level);
      svg.appendChild(svgEl("circle", { cx: tx, cy: ty, r: 4, class: "end-marker" }));
      const nearRightEdge = tx > width - margin.right - 70;
      const label = svgEl("text", {
        x: nearRightEdge ? tx - 8 : tx + 8,
        y: Math.max(ty - 10, margin.top + 10),
        class: "end-label",
        "text-anchor": nearRightEdge ? "end" : "start",
      });
      label.textContent = `Today · ${todayPoint.level.toFixed(2)} mg`;
      svg.appendChild(label);
    }

    attachHoverLayer(svg, tooltip, container, margin, plotW, plotH, width, height, xForT, yForLevel, startMs, endMs, points, stepHours, (p) => `${p.level.toFixed(2)} mg`);
  }

  // Shared crosshair/tooltip hover layer for both the pin chart and the weight chart.
  function attachHoverLayer(svg, tooltip, container, margin, plotW, plotH, width, height, xForT, yForVal, startMs, endMs, points, stepHours, formatValue) {
    const hoverLine = svgEl("line", { x1: 0, x2: 0, y1: margin.top, y2: margin.top + plotH, class: "hover-line hidden" });
    const hoverDot = svgEl("circle", { r: 4, class: "hover-dot hidden" });
    svg.appendChild(hoverLine);
    svg.appendChild(hoverDot);

    const hitRect = svgEl("rect", { x: margin.left, y: margin.top, width: plotW, height: plotH, fill: "transparent", "pointer-events": "all" });
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
      const py = yForVal(nearest.level !== undefined ? nearest.level : nearest.value);
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
      tooltip.innerHTML = `<div class="tt-date">${dateLabel}</div><div class="tt-value">${formatValue(nearest)}</div>`;
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

  // ---------- weight tracking ----------

  function initWeightForm() {
    const dateInput = document.getElementById("weight-date");
    dateInput.value = todayDateStr();
    document.getElementById("weight-form").addEventListener("submit", onWeightSubmit);
    document.getElementById("weight-cancel").addEventListener("click", resetWeightForm);
    document.querySelectorAll(".range-controls .btn-pill[data-weight-range]").forEach((btn) => {
      btn.addEventListener("click", () => {
        weightRange = btn.dataset.weightRange;
        document.querySelectorAll(".range-controls .btn-pill[data-weight-range]").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        renderWeightChart();
      });
    });
  }

  async function onWeightSubmit(e) {
    e.preventDefault();
    const date = document.getElementById("weight-date").value;
    const weight = parseFloat(document.getElementById("weight-value").value);
    const unit = document.getElementById("weight-unit").value;
    const note = document.getElementById("weight-note").value.trim();
    if (!date || !Number.isFinite(weight) || weight <= 0) return;

    setFormBusy("weight-form", true);
    try {
      if (storageMode === "api") {
        if (weightEditingId) {
          const updated = await apiUpdate(API.weight, weightEditingId, { date, weight, unit, note });
          const idx = weightEntries.findIndex((w) => w.id === weightEditingId);
          if (idx !== -1) weightEntries[idx] = updated;
        } else {
          weightEntries.push(await apiCreate(API.weight, { date, weight, unit, note }));
        }
      } else {
        if (weightEditingId) {
          const w = weightEntries.find((w) => w.id === weightEditingId);
          if (w) Object.assign(w, { date, weight, unit, note });
        } else {
          weightEntries.push({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), date, weight, unit, note });
        }
        saveLocal(LOCAL_KEYS.weight, weightEntries);
      }
      hideError();
      resetWeightForm();
      renderWeightAll();
    } catch (err) {
      showError(err.message || "Couldn't save that weigh-in - is the tracker server running?");
    } finally {
      setFormBusy("weight-form", false);
    }
  }

  function resetWeightForm() {
    weightEditingId = null;
    document.getElementById("weight-id").value = "";
    document.getElementById("weight-value").value = "";
    document.getElementById("weight-note").value = "";
    document.getElementById("weight-date").value = todayDateStr();
    document.getElementById("weight-submit").textContent = "Add weigh-in";
    document.getElementById("weight-cancel").classList.add("hidden");
  }

  function editWeightEntry(id) {
    const w = weightEntries.find((w) => w.id === id);
    if (!w) return;
    weightEditingId = id;
    document.getElementById("weight-id").value = id;
    document.getElementById("weight-date").value = w.date;
    document.getElementById("weight-value").value = w.weight;
    document.getElementById("weight-unit").value = w.unit;
    document.getElementById("weight-note").value = w.note || "";
    document.getElementById("weight-submit").textContent = "Save changes";
    document.getElementById("weight-cancel").classList.remove("hidden");
    window.scrollTo({ top: document.getElementById("weight-heading").offsetTop - 20, behavior: "smooth" });
  }

  async function deleteWeightEntry(id) {
    const w = weightEntries.find((w) => w.id === id);
    if (!w) return;
    if (!window.confirm(`Delete this weigh-in?\n${formatDateLabel(w.date, { year: true })} — ${w.weight} ${w.unit}`)) return;
    try {
      if (storageMode === "api") await apiDelete(API.weight, id);
      weightEntries = weightEntries.filter((w) => w.id !== id);
      if (storageMode === "local") saveLocal(LOCAL_KEYS.weight, weightEntries);
      if (weightEditingId === id) resetWeightForm();
      hideError();
      renderWeightAll();
    } catch (err) {
      showError(err.message || "Couldn't delete that weigh-in - is the tracker server running?");
    }
  }

  function renderWeightList() {
    const list = document.getElementById("weight-list");
    const empty = document.getElementById("weight-empty");
    list.querySelectorAll(".entry-row").forEach((row) => row.remove());

    const sorted = [...weightEntries].sort((a, b) => (a.date < b.date ? 1 : -1));
    empty.classList.toggle("hidden", sorted.length > 0);

    for (const w of sorted) {
      const row = document.createElement("div");
      row.className = "entry-row";

      const main = document.createElement("div");
      main.className = "entry-main";
      main.addEventListener("click", () => editWeightEntry(w.id));

      const dateEl = document.createElement("span");
      dateEl.className = "entry-date";
      dateEl.textContent = formatDateLabel(w.date, { year: true });
      main.appendChild(dateEl);

      const metaEl = document.createElement("span");
      metaEl.className = "entry-meta";
      metaEl.textContent = w.note ? `${w.weight} ${w.unit} · ${w.note}` : `${w.weight} ${w.unit}`;
      main.appendChild(metaEl);

      row.appendChild(main);

      const actions = document.createElement("div");
      actions.className = "entry-row-actions";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-ghost btn-danger";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteWeightEntry(w.id));
      actions.appendChild(delBtn);

      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  function renderWeightStat() {
    const sorted = [...weightEntries].sort((a, b) => (a.date < b.date ? 1 : -1));
    const valueEl = document.getElementById("weight-stat-value");
    const subEl = document.getElementById("weight-stat-sub");
    if (sorted.length === 0) {
      valueEl.textContent = "—";
      subEl.textContent = "No weigh-ins logged yet";
      return;
    }
    const latest = sorted[0];
    valueEl.textContent = `${latest.weight} ${latest.unit}`;
    if (sorted.length === 1) {
      subEl.textContent = `Logged ${formatDateLabel(latest.date, { year: true })}`;
      return;
    }
    const prev = sorted[1];
    const delta = latest.weight - prev.weight;
    const deltaLabel = delta === 0 ? "No change" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} ${latest.unit}`;
    subEl.textContent = `${deltaLabel} since ${formatDateLabel(prev.date)}`;
  }

  function niceRound(value, direction) {
    if (value === 0) return 0;
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(value))));
    const step = magnitude / 2;
    return direction === "down" ? Math.floor(value / step) * step : Math.ceil(value / step) * step;
  }

  function renderWeightChart() {
    const svg = document.getElementById("weight-chart-svg");
    const emptyState = document.getElementById("weight-chart-empty");
    const tooltip = document.getElementById("weight-chart-tooltip");
    const container = document.getElementById("weight-chart-container");
    svg.innerHTML = "";
    container.className = "chart-container cat-5"; // fixed accent (green), distinct from compound colors

    if (weightEntries.length === 0) {
      emptyState.classList.remove("hidden");
      svg.classList.add("hidden");
      tooltip.classList.add("hidden");
      return;
    }
    emptyState.classList.add("hidden");
    svg.classList.remove("hidden");

    const todayMs = dateStrToMs(todayDateStr());
    const sorted = [...weightEntries].sort((a, b) => dateStrToMs(a.date) - dateStrToMs(b.date));
    const earliestMs = dateStrToMs(sorted[0].date);
    const latestMs = Math.max(dateStrToMs(sorted[sorted.length - 1].date), todayMs);

    let startMs;
    if (weightRange === "30") startMs = addDays(todayMs, -29);
    else if (weightRange === "90") startMs = addDays(todayMs, -89);
    else startMs = earliestMs;
    const endMs = latestMs;

    const visible = sorted.filter((w) => dateStrToMs(w.date) >= startMs && dateStrToMs(w.date) <= endMs);
    if (visible.length === 0) {
      emptyState.textContent = "No weigh-ins in this range.";
      emptyState.classList.remove("hidden");
      svg.classList.add("hidden");
      return;
    }
    emptyState.textContent = "Log a weigh-in to see your trend here.";

    const values = visible.map((w) => w.weight);
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const pad = Math.max((dataMax - dataMin) * 0.15, dataMax * 0.02, 1);
    const yMin = Math.max(0, niceRound(dataMin - pad, "down"));
    const yMax = niceRound(dataMax + pad, "up");

    const width = 760;
    const height = 240;
    const margin = { top: 14, right: 16, bottom: 28, left: 46 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");

    const spanMs = Math.max(endMs - startMs, 86400000);
    const xForT = (t) => margin.left + ((t - startMs) / spanMs) * plotW;
    const yForVal = (v) => margin.top + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    const yTickCount = 4;
    for (let i = 0; i <= yTickCount; i++) {
      const val = yMin + ((yMax - yMin) / yTickCount) * i;
      const y = yForVal(val);
      svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: "grid-line" }));
      const label = svgEl("text", { x: margin.left - 8, y: y + 4, class: "axis-label", "text-anchor": "end" });
      label.textContent = Math.round(val * 10) / 10;
      svg.appendChild(label);
    }

    const xTickCount = Math.min(6, Math.max(2, visible.length - 1 || 1));
    for (let i = 0; i <= xTickCount; i++) {
      const t = startMs + (spanMs * i) / xTickCount;
      const x = xForT(t);
      const label = svgEl("text", { x, y: height - 6, class: "axis-label", "text-anchor": i === 0 ? "start" : i === xTickCount ? "end" : "middle" });
      label.textContent = new Date(t).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" });
      svg.appendChild(label);
    }

    svg.appendChild(svgEl("line", { x1: margin.left, x2: width - margin.right, y1: margin.top + plotH, y2: margin.top + plotH, class: "axis-baseline" }));

    const points = visible.map((w) => ({ t: dateStrToMs(w.date), value: w.weight, unit: w.unit }));
    const px = points.map((p) => [xForT(p.t), yForVal(p.value)]);
    const linePath = px.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");

    if (points.length > 1) {
      const areaPath = `${linePath} L${px[px.length - 1][0].toFixed(2)},${margin.top + plotH} L${px[0][0].toFixed(2)},${margin.top + plotH} Z`;
      svg.appendChild(svgEl("path", { d: areaPath, class: "area-fill" }));
      svg.appendChild(svgEl("path", { d: linePath, class: "level-line" }));
    }
    for (const p of px) {
      svg.appendChild(svgEl("circle", { cx: p[0], cy: p[1], r: 4, class: "dose-marker" }));
    }

    const last = points[points.length - 1];
    const lastPx = px[px.length - 1];
    const nearRightEdge = lastPx[0] > width - margin.right - 70;
    const label = svgEl("text", {
      x: nearRightEdge ? lastPx[0] - 8 : lastPx[0] + 8,
      y: Math.max(lastPx[1] - 10, margin.top + 10),
      class: "end-label",
      "text-anchor": nearRightEdge ? "end" : "start",
    });
    label.textContent = `${last.value} ${last.unit}`;
    svg.appendChild(label);

    attachHoverLayer(svg, tooltip, container, margin, plotW, plotH, width, height, xForT, yForVal, startMs, endMs, points, 24, (p) => `${p.value} ${p.unit}`);
  }

  function renderWeightAll() {
    renderWeightStat();
    renderWeightChart();
    renderWeightList();
  }

  // ---------- init ----------

  function renderAll() {
    renderCalendar();
    renderCompoundsList();
    populateCompoundSelect(document.getElementById("entry-compound"), document.getElementById("entry-compound").value || (compounds[0] && compounds[0].id));
    populateCompoundSelect(document.getElementById("chart-compound-select"), selectedChartCompoundId);
    renderStat();
    renderChart();
    renderEntriesList();
    renderWeightAll();
  }

  document.addEventListener("DOMContentLoaded", async () => {
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
    initCompoundForm();
    initChartControls();
    initWeightForm();

    const data = await detectAndLoadAll();
    compounds = data.compounds;
    entries = data.entries;
    weightEntries = data.weight;
    selectedChartCompoundId = (entries[0] && entries[0].compoundId) || (compounds[0] && compounds[0].id) || null;

    updateStorageBadge();
    renderAll();
  });
})();
