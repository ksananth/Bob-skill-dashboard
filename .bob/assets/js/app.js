(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { q: "", cat: "", tag: "", usage: "all", key: "count", dir: "desc" };
  const state = { ...DEFAULTS };
  const PALETTE = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
  let skills = [];
  let catColor = {};

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const highlight = (text, q) => {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp("(" + esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    return safe.replace(re, "<mark>$1</mark>");
  };
  const ago = (d) => {
    if (!d) return "Never used";
    const dt = new Date(d + "T00:00:00");
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - dt) / 864e5);
    if (days <= 0) return "Used today";
    if (days === 1) return "Used yesterday";
    if (days < 30) return `Used ${days} days ago`;
    return "Used " + dt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };

  /* ---------- theme ---------- */
  const savedTheme = store.get("bob-theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $("theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("bob-theme", next);
  });

  /* ---------- data ----------
     Counts come from assets/data/skills-usage.json, history from assets/data/skill-events.json.
     Skill names/descriptions come from each .bob/skills/<name>/SKILL.md.
     Loaded over http from the local viewer (assets/tools/serve.js), or straight from disk with Rescan. */
  const USAGE_URL = "assets/data/skills-usage.json";
  const EVENTS_URL = "assets/data/skill-events.json";
  const SKILLS_URL = "api/skills";
  const POLL_MS = 3000;
  let lastSnapshot = "";
  let mode = "server"; // "server" | "disk"

  function setData(list, sourceText) {
    skills = list.map((s) => ({ ...s, count: Number(s.count) || 0, tags: s.tags || [], history: s.history || [] }));
    catColor = {};
    [...new Set(skills.map((s) => s.category))].sort().forEach((c, i) => (catColor[c] = PALETTE[i % PALETTE.length]));
    if (state.cat && !catColor[state.cat]) state.cat = "";
    if (skills.length) {                                    // back to the normal "no matches" message
      $("empty").querySelector("p").textContent = "No skills match these filters.";
      $("reset").hidden = false;
    }
    $("source").textContent = sourceText;
    renderFilters();
    render();
    route();
  }

  function parseFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const meta = {};
    if (!m) return meta;
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      else v = v.replace(/^["']|["']$/g, "");
      meta[kv[1]] = v;
    }
    return meta;
  }

  // One skill definition from its folder name + SKILL.md text
  function defFrom(id, text) {
    const meta = parseFrontmatter(text);
    return {
      id,
      name: meta.name || id,
      description: meta.description || "",
      category: meta.category || "Uncategorised",
      tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [],
      path: `skills/${id}/SKILL.md`,
      body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
    };
  }

  // Join skill definitions with the two JSON files
  function merge(defs, usage, events) {
    usage = usage && typeof usage === "object" ? usage : {};
    events = Array.isArray(events) ? events : [];
    return defs.map((d) => {
      const u = usage[d.id] || {};
      return {
        ...d,
        count: u.count || 0,
        lastUsed: u.lastUsed || null,
        history: events.filter((e) => e.skill === d.id).slice(-20).reverse().map((e) => e.at),
      };
    });
  }

  const stamp = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  async function loadFromServer({ quiet = false } = {}) {
    const get = async (url, asJson) => {
      const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(url + " " + r.status);
      return asJson ? r.json() : r.text();
    };
    const [defsRaw, usageText, eventsText] = await Promise.all([
      get(SKILLS_URL, false),
      get(USAGE_URL, false).catch(() => "{}"),
      get(EVENTS_URL, false).catch(() => "[]"),
    ]);
    const snapshot = defsRaw + "\u0000" + usageText + "\u0000" + eventsText;
    if (quiet && snapshot === lastSnapshot) return;                 // nothing changed
    lastSnapshot = snapshot;
    const defs = JSON.parse(defsRaw).map((s) => defFrom(s.id, s.text));
    let usage = {}, events = [];
    try { usage = JSON.parse(usageText); } catch {}
    try { events = JSON.parse(eventsText); } catch {}
    setData(merge(defs, usage, events), `${defs.length} skills · live from skills-usage.json · updated ${stamp()}`);
  }

  /* ---------- reading the JSON from disk (double-clicked index.html) ----------
     Browsers block fetch() on file:// pages, so we use the File System Access API (Chrome / Edge):
     the .bob folder is picked once, remembered in IndexedDB, and re-read every few seconds. */
  const idb = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open("bob-skills", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async get(k) {
      try { const db = await this.open(); return await new Promise((res) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
      catch { return undefined; }
    },
    async set(k, v) {
      try { const db = await this.open(); await new Promise((res) => { const t = db.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = res; }); }
      catch {}
    },
  };

  let dirHandle = null;
  let pollTimer = null;

  async function readText(dir, name) {
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }

  // Accept either the project folder or the .bob folder itself
  async function resolveBob(dir) {
    if (dir.name === ".bob") return dir;
    try { return await dir.getDirectoryHandle(".bob"); } catch { return dir; }
  }

  async function loadFromDir(root, { quiet = false } = {}) {
    let usageText = "{}", eventsText = "[]";
    try {
      const data = await (await root.getDirectoryHandle("assets")).getDirectoryHandle("data");
      try { usageText = await readText(data, "skills-usage.json"); } catch {}
      try { eventsText = await readText(data, "skill-events.json"); } catch {}
    } catch {}
    const skillsDir = await root.getDirectoryHandle("skills");      // throws if this isn't a .bob folder
    const files = [];
    for await (const [name, h] of skillsDir.entries()) {
      if (h.kind !== "directory") continue;
      try { files.push([name, await readText(h, "SKILL.md")]); } catch {}
    }
    files.sort((a, b) => a[0].localeCompare(b[0]));
    const snapshot = JSON.stringify(files) + "\u0000" + usageText + "\u0000" + eventsText;
    if (quiet && snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    let usage = {}, events = [];
    try { usage = JSON.parse(usageText); } catch {}
    try { events = JSON.parse(eventsText); } catch {}
    const defs = files.map(([id, text]) => defFrom(id, text));
    setData(merge(defs, usage, events), `${defs.length} skills · live from skills-usage.json · updated ${stamp()}`);
  }

  function startDiskPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.hidden || !dirHandle) return;
      loadFromDir(dirHandle, { quiet: true }).catch(() => {
        clearInterval(pollTimer);
        showConnect("reconnect", "Lost access to the .bob folder.");
      });
    }, POLL_MS);
  }

  async function connectDir(handle) {
    const root = await resolveBob(handle);
    await loadFromDir(root);                                     // validates the folder
    dirHandle = root;
    mode = "disk";
    await idb.set("dir", root);
    startDiskPolling();
  }

  // Empty-state screen with one big button: pick the folder, or re-grant access to the remembered one
  function showConnect(kind, note) {
    setData([], kind === "reconnect" ? "Click Connect to load the data" : "Choose your .bob folder to load the data");
    const empty = $("empty");
    $("reset").hidden = true;
    if (!window.showDirectoryPicker) {
      empty.querySelector("p").innerHTML =
        "This browser can't read local JSON files from a double-clicked page.<br>" +
        "Open it in <b>Chrome</b> or <b>Edge</b>, or run <code>node .bob/assets/tools/serve.js</code>.";
      return;
    }
    empty.querySelector("p").innerHTML =
      (note ? `<span class="note">${esc(note)}</span><br>` : "") +
      (kind === "reconnect"
        ? "Allow the page to read <code>.bob</code> again to load <code>skills-usage.json</code> and <code>skill-events.json</code>."
        : "The skills viewer isn't running (Bob starts it automatically when a session begins). Start it with <code>node .bob/assets/tools/serve.js</code>, or pick your <code>.bob</code> folder once and the page will remember it.") +
      `<br><button class="primary" id="connectBtn">${kind === "reconnect" ? "Connect to .bob" : "Choose .bob folder"}</button>`;
    $("connectBtn").onclick = kind === "reconnect" ? reconnect : pickFolder;
  }

  async function pickFolder() {
    let dir;
    try { dir = await window.showDirectoryPicker({ id: "bob", mode: "read" }); } catch { return; }
    const btn = $("rescan"); btn.classList.add("spin");
    try { await connectDir(dir); }
    catch { showConnect("pick", "That folder has no skills folder. Pick your project folder or its .bob folder."); }
    finally { setTimeout(() => btn.classList.remove("spin"), 800); }
  }

  async function reconnect() {
    const saved = await idb.get("dir");
    if (!saved) return pickFolder();
    try {
      if ((await saved.requestPermission({ mode: "read" })) !== "granted") return;
      await connectDir(saved);
    } catch { pickFolder(); }
  }

  async function startFromDisk() {
    mode = "disk";
    if (!window.showDirectoryPicker) return showConnect("pick");
    const saved = await idb.get("dir");
    if (!saved) return showConnect("pick");
    try {
      if ((await saved.queryPermission({ mode: "read" })) === "granted") return await connectDir(saved);
    } catch {}
    showConnect("reconnect");
  }

  // When index.html is double-clicked, look for the viewer (started by Bob's SessionStart hook) and switch to it,
  // so the JSON files load without picking a folder.
  const VIEWER = "http://localhost:4173";
  async function viewerRunning() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 900);
      const r = await fetch(VIEWER + "/api/ping", { cache: "no-store", signal: ctrl.signal });
      clearTimeout(t);
      return r.ok && (await r.json()).app === "bob-skills";
    } catch { return false; }
  }

  async function start() {
    if (location.protocol === "file:") {
      $("source").textContent = "Looking for the skills viewer…";
      if (await viewerRunning()) { location.replace(VIEWER + "/" + location.hash); return; }
      return startFromDisk();
    }
    try {
      await loadFromServer();
      setInterval(() => { if (mode === "server" && !document.hidden) loadFromServer({ quiet: true }).catch(() => {}); }, POLL_MS);
      document.addEventListener("visibilitychange", () => { if (!document.hidden && mode === "server") loadFromServer({ quiet: true }).catch(() => {}); });
    } catch {
      startFromDisk();
    }
  }

  async function rescan() {
    const btn = $("rescan");
    if (mode === "server") {
      btn.classList.add("spin");
      try { await loadFromServer(); } catch { $("source").textContent = "Couldn't reach the viewer — is serve.js still running?"; }
      setTimeout(() => btn.classList.remove("spin"), 800);
      return;
    }
    if (dirHandle) {                                            // connected: re-read now
      btn.classList.add("spin");
      try { await loadFromDir(dirHandle); } catch { showConnect("reconnect", "Lost access to the .bob folder."); }
      setTimeout(() => btn.classList.remove("spin"), 800);
      return;
    }
    if (!window.showDirectoryPicker) return showConnect("pick");
    pickFolder();
  }

  /* ---------- filtering ---------- */
  function visible() {
    const q = state.q.trim().toLowerCase();
    const list = skills.filter((s) => {
      if (state.cat && s.category !== state.cat) return false;
      if (state.tag && !s.tags.includes(state.tag)) return false;
      if (state.usage === "used" && !s.count) return false;
      if (state.usage === "unused" && s.count) return false;
      if (q) {
        const hay = `${s.name} ${s.description} ${s.category} ${s.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const mul = state.dir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      let x = a[state.key], y = b[state.key];
      if (state.key === "lastUsed") { x = x || ""; y = y || ""; }
      const r = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      return r !== 0 ? r * mul : b.count - a.count || a.name.localeCompare(b.name);
    });
  }

  /* ---------- rendering ---------- */
  function renderFilters() {
    const counts = {};
    skills.forEach((s) => (counts[s.category] = (counts[s.category] || 0) + 1));
    const cats = [["", "All skills", skills.length], ...Object.keys(counts).sort().map((c) => [c, c, counts[c]])];
    $("cats").innerHTML = cats.map(([val, label, n]) => `
      <button data-cat="${esc(val)}">
        <span class="lbl">${val ? `<span class="dot" style="background:${catColor[val]}"></span>` : ""}${esc(label)}</span>
        <span class="n">${n}</span>
      </button>`).join("");

    const tagCount = {};
    skills.forEach((s) => s.tags.forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1)));
    $("tags").innerHTML = Object.keys(tagCount)
      .sort((a, b) => tagCount[b] - tagCount[a] || a.localeCompare(b))
      .map((t) => `<button class="chip" data-tag="${esc(t)}">${esc(t)}</button>`).join("");
  }

  function render() {
    const list = visible();
    const max = Math.max(1, ...skills.map((s) => s.count));
    const q = state.q.trim();

    // selection states
    document.querySelectorAll("#cats button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cat === state.cat)));
    document.querySelectorAll("#tags .chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tag === state.tag)));
    document.querySelectorAll("#usage button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.val === state.usage)));
    $("sort").value = state.key;
    $("dir").dataset.dir = state.dir;

    // active filter pills
    const pills = [];
    if (state.cat) pills.push(["cat", state.cat]);
    if (state.tag) pills.push(["tag", "#" + state.tag]);
    if (state.usage !== "all") pills.push(["usage", state.usage === "used" ? "Used" : "Never used"]);
    if (q) pills.push(["q", `“${q}”`]);
    const active = $("active");
    active.hidden = !pills.length;
    active.innerHTML = pills.length
      ? `<span>${list.length} of ${skills.length}</span>` +
        pills.map(([k, label]) => `<button class="pill" data-clear="${k}">${esc(label)}<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`).join("") +
        `<button class="link" data-clear="all">Clear all</button>`
      : "";

    // list
    $("list").innerHTML = list.map((s, i) => `
      <li class="item" data-id="${esc(s.id)}" tabindex="0" role="link" aria-label="Open ${esc(s.name)}" style="animation-delay:${Math.min(i, 12) * 18}ms">
        <span class="rank${i < 3 && state.key === "count" && state.dir === "desc" ? " top" : ""}">${i + 1}</span>
        <div class="body">
          <div class="title">
            <span class="name" title="${esc(s.path)}">${highlight(s.name, q)}</span>
            <span class="badge"><span class="dot" style="background:${catColor[s.category]}"></span>${esc(s.category)}</span>
          </div>
          <p class="desc">${highlight(s.description, q)}</p>
          <div class="tags">${s.tags.map((t) => `<button class="tag${t === state.tag ? " on" : ""}" data-tag="${esc(t)}">#${highlight(t, q)}</button>`).join("")}</div>
        </div>
        <div class="usage">
          <div class="top"><span class="count${s.count ? "" : " zero"}">${s.count}</span><span class="unit">${s.count === 1 ? "use" : "uses"}</span></div>
          <div class="bar"><i style="width:${((s.count / max) * 100).toFixed(1)}%"></i></div>
          <span class="when">${ago(s.lastUsed)}</span>
        </div>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </li>`).join("");
    $("list").hidden = !list.length;
    $("empty").hidden = !!list.length;

    // stats
    const total = skills.reduce((a, s) => a + s.count, 0);
    const used = skills.filter((s) => s.count).length;
    const top = [...skills].sort((a, b) => b.count - a.count)[0];
    const pct = skills.length ? Math.round((used / skills.length) * 100) : 0;
    $("stats").innerHTML = `
      <div class="stat"><div class="k">Skills</div><div class="v">${skills.length}</div></div>
      <div class="stat"><div class="k">Total uses</div><div class="v">${total.toLocaleString()}</div></div>
      <div class="stat"><div class="k">Adoption</div><div class="v">${used}<small> / ${skills.length} used</small></div>
        <div class="meter"><i style="width:${pct}%"></i></div></div>
      <div class="stat"><div class="k">Most used</div>
        <div class="v name" title="${top ? esc(top.name) : ""}">${top && top.count ? esc(top.name) : "—"}</div>
        ${top && top.count ? `<div class="k" style="margin-top:4px">${top.count} uses</div>` : ""}</div>`;
  }

  /* ---------- markdown (small, safe subset) ---------- */
  function inline(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function markdown(src) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    const out = []; let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim(); const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`); continue;
      }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { const n = Math.min(m[1].length + 1, 5); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^>\s?/.test(line)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue; }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]/.test(line); const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          let item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, "");
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += " " + lines[i++].trim();
          const task = item.match(/^\[( |x)\]\s+(.*)$/i);
          items.push(task ? `<li class="task"><span class="box${task[1].trim() ? " done" : ""}"></span>${inline(task[2])}</li>` : `<li>${inline(item)}</li>`);
        }
        out.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`); continue;
      }
      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (l) => l.trim().slice(1, -1).split("|").map((c) => c.trim());
        const head = cells(line); i += 2; const rows = [];
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="tbl"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`); continue;
      }
      if (!line.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\|)/.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join(" "))}</p>`);
    }
    return out.join("\n");
  }

  /* ---------- detail screen ---------- */
  let listScroll = 0;
  let cameFromList = false;
  function open(id) { listScroll = window.scrollY; cameFromList = true; location.hash = "#/skill/" + encodeURIComponent(id); }
  // Go back in history when we arrived from the list, so the browser Back button stays in sync.
  function back() { if (cameFromList) history.back(); else location.hash = ""; }

  function route() {
    const m = location.hash.match(/^#\/skill\/(.+)$/);
    const skill = m && skills.find((s) => s.id === decodeURIComponent(m[1]));
    if (m && skill) {
      renderDetail(skill);
      $("listView").hidden = true; $("detailView").hidden = false;
      window.scrollTo(0, 0);
      document.title = skill.name + " · Bob Skills";
    } else {
      const wasDetail = !$("detailView").hidden;
      $("detailView").hidden = true; $("listView").hidden = false;
      document.title = "Bob Skills";
      if (wasDetail) window.scrollTo(0, listScroll);
      cameFromList = false;
    }
  }

  function renderDetail(s) {
    const ranked = [...skills].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const rank = ranked.findIndex((x) => x.id === s.id) + 1;
    const max = Math.max(1, ...skills.map((x) => x.count));
    const total = skills.reduce((a, x) => a + x.count, 0);
    const share = total ? Math.round((s.count / total) * 100) : 0;
    const order = visible();
    const pos = order.findIndex((x) => x.id === s.id);
    const prev = pos > 0 ? order[pos - 1] : null;
    const next = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : null;
    const cmd = `node .bob/assets/tools/skills.js use ${s.id}`;
    const lastUsed = s.lastUsed ? new Date(s.lastUsed + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "Never";
    const body = s.body ? markdown(s.body) : `<p class="muted">No content found in SKILL.md beyond the header. Run the build script again, or press Rescan.</p>`;

    $("detailView").innerHTML = `
      <nav class="crumbs">
        <button class="back" data-act="back"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>All skills</button>
        <div class="pager">
          <button class="icon-btn square" data-go="${prev ? esc(prev.id) : ""}" ${prev ? `title="Previous: ${esc(prev.name)}"` : "disabled"} aria-label="Previous skill"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button>
          <span class="pos">${pos >= 0 ? `${pos + 1} / ${order.length}` : ""}</span>
          <button class="icon-btn square" data-go="${next ? esc(next.id) : ""}" ${next ? `title="Next: ${esc(next.name)}"` : "disabled"} aria-label="Next skill"><svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg></button>
        </div>
      </nav>

      <header class="d-head">
        <span class="badge lg"><span class="dot" style="background:${catColor[s.category]}"></span>${esc(s.category)}</span>
        <h2 class="d-title">${esc(s.name)}</h2>
        <p class="d-desc">${esc(s.description)}</p>
        ${s.tags.length ? `<div class="d-tags">${s.tags.map((t) => `<button class="chip" data-filter-tag="${esc(t)}" title="Show all skills tagged ${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}
      </header>

      <div class="d-grid">
        <article class="doc">
          <div class="doc-bar">
            <span><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>${esc(s.path)}</span>
            <button class="link" data-copy="${esc(s.body || "")}">Copy</button>
          </div>
          <div class="md">${body}</div>
        </article>

        <aside class="d-side">
          <div class="card">
            <div class="k">Times used</div>
            <div class="big">${s.count}</div>
            <div class="bar"><i style="width:${((s.count / max) * 100).toFixed(1)}%"></i></div>
            <dl>
              <div><dt>Rank</dt><dd>#${rank} of ${skills.length}</dd></div>
              <div><dt>Share of all uses</dt><dd>${share}%</dd></div>
              <div><dt>Last used</dt><dd>${lastUsed}</dd></div>
            </dl>
          </div>
          <div class="card">
            <div class="k">Recent uses</div>
            ${(s.history || []).length
              ? `<ul class="hist">${s.history.slice(0, 8).map((at) => {
                  const d = new Date(at);
                  return `<li><span>${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span><span>${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></li>`;
                }).join("")}</ul>`
              : `<p class="hist-empty">Nothing logged yet. Uses appear here when Bob activates this skill.</p>`}
          </div>
          <div class="card">
            <div class="k">Log a use by hand</div>
            <div class="cmd"><code>${esc(cmd)}</code><button class="icon-btn square" data-copy="${esc(cmd)}" title="Copy command" aria-label="Copy command"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>
          </div>
        </aside>
      </div>`;
  }

  $("detailView").addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.act === "back") return back();
    if (t.dataset.go) { location.replace("#/skill/" + encodeURIComponent(t.dataset.go)); return; }
    if (t.dataset.filterTag !== undefined) { state.tag = t.dataset.filterTag; location.hash = ""; render(); return; }
    if (t.dataset.copy !== undefined) {
      try { await navigator.clipboard.writeText(t.dataset.copy); } catch {
        const ta = document.createElement("textarea"); ta.value = t.dataset.copy; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch {} ta.remove();
      }
      const old = t.innerHTML; t.classList.add("copied");
      if (t.classList.contains("link")) t.textContent = "Copied";
      setTimeout(() => { t.innerHTML = old; t.classList.remove("copied"); }, 1200);
    }
  });
  window.addEventListener("hashchange", route);

  /* ---------- events ---------- */
  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("cats").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.cat = b.dataset.cat; render();
  });
  const toggleTag = (e) => {
    const b = e.target.closest("[data-tag]"); if (!b) return;
    state.tag = state.tag === b.dataset.tag ? "" : b.dataset.tag; render();
  };
  $("tags").addEventListener("click", toggleTag);
  $("list").addEventListener("click", (e) => {
    if (e.target.closest("[data-tag]")) return toggleTag(e);
    const li = e.target.closest(".item"); if (li) open(li.dataset.id);
  });
  $("list").addEventListener("keydown", (e) => {
    const li = e.target.closest(".item");
    if (li && (e.key === "Enter" || e.key === " ") && !e.target.closest("[data-tag]")) { e.preventDefault(); open(li.dataset.id); }
  });
  $("usage").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    state.usage = b.dataset.val; render();
  });
  $("sort").addEventListener("change", (e) => {
    state.key = e.target.value;
    state.dir = state.key === "name" || state.key === "category" ? "asc" : "desc";
    render();
  });
  $("dir").addEventListener("click", () => { state.dir = state.dir === "asc" ? "desc" : "asc"; render(); });
  $("active").addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear]"); if (!b) return;
    const k = b.dataset.clear;
    if (k === "all") return clearAll();
    if (k === "q") $("q").value = "";
    state[k] = DEFAULTS[k]; render();
  });
  function clearAll() {
    Object.assign(state, { q: "", cat: "", tag: "", usage: "all" });
    $("q").value = ""; render();
  }
  $("reset").addEventListener("click", clearAll);
  $("rescan").addEventListener("click", rescan);
  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); }
    if (e.key === "Escape" && !$("detailView").hidden) { back(); return; }
    if (e.key === "Escape" && document.activeElement === $("q")) { $("q").value = ""; state.q = ""; render(); $("q").blur(); }
  });

  start();
})();
