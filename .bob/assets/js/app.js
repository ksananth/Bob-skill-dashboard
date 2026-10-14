(() => {
  "use strict";

  // Skill list: read straight from the SKILL.md files every time the page opens (and every few seconds).
  // A page can't open a folder by itself, so the first time you pick the skills folder; the browser
  // remembers it (kept in IndexedDB). Needs Chrome or Edge.
  // Usage: Firestore collection "skills" -> { count, lastUsedAt }, pushed here live by onSnapshot.
  const POLL_MS = 3000;

  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { q: "", cat: "", tag: "", usage: "all", key: "count", dir: "desc" };
  const state = { ...DEFAULTS };
  const PALETTE = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
  let base = [];            // skills read from the SKILL.md files
  let folder = null;        // the picked folder (FileSystemDirectoryHandle)
  let usage = {};           // id -> { count, lastUsed (ms, 0 = never) } from Firestore
  let live = "connecting";  // connecting | live | off | error
  let liveError = "";
  let skills = [];          // base + usage, what the screens show
  let catColor = {};
  let lastSnapshot = "";

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const highlight = (text, q) => {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp("(" + esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    return safe.replace(re, "<mark>$1</mark>");
  };
  const plural = (n) => (n === 1 ? "use" : "uses");
  const ago = (ms) => {
    if (!ms) return "never";
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + " d ago";
    return new Date(ms).toLocaleDateString();
  };
  const fullDate = (ms) => (ms ? new Date(ms).toLocaleString() : "Never");

  /* ---------- theme ---------- */
  try { const t = localStorage.getItem("bob-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  $("theme").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("bob-theme", dark ? "light" : "dark"); } catch {}
  });

  /* ---------- skills folder ---------- */
  // Remember the picked folder between visits (a folder handle can only be stored in IndexedDB).
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("bob-skills", 1);
      open.onupgradeneeded = () => open.result.createObjectStore("kv");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction("kv", mode);
          const req = fn(tx.objectStore("kv"));
          tx.oncomplete = () => resolve(req && req.result);
          tx.onerror = () => reject(tx.error);
        } catch (err) { reject(err); }
      };
    });
  }
  const savedFolder = () => idb("readonly", (s) => s.get("folder")).catch(() => null);
  const saveFolder = (h) => idb("readwrite", (s) => s.put(h, "folder")).catch(() => {});

  async function child(dir, name) {
    try { return await dir.getDirectoryHandle(name); } catch { return null; }
  }
  // Accept the skills folder itself, the .bob folder, or the repo root.
  async function skillsDir(dir) {
    if (dir.name === "skills") return dir;
    const direct = await child(dir, "skills");
    if (direct) return direct;
    const bob = await child(dir, ".bob");
    return bob ? child(bob, "skills") : null;
  }

  function frontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const meta = {};
    if (!m) return meta;
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v === "" || /^[>|][+-]?$/.test(v)) {                 // multi-line value (YAML > or |, or indented lines)
        const more = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
        if (more.length && more.every((l) => l.startsWith("- "))) { meta[kv[1]] = more.map((l) => l.slice(2).trim()); continue; }
        v = more.join(" ");
      }
      if (v.startsWith("[") && v.endsWith("]")) v = v.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
      else v = v.replace(/^["']|["']$/g, "");
      meta[kv[1]] = v;
    }
    return meta;
  }

  async function readSkills(dir) {
    const out = [];
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind !== "directory") continue;
      let text;
      try { text = await (await (await entry.getFileHandle("SKILL.md")).getFile()).text(); } catch { continue; }
      const m = frontmatter(text);
      if (!m.description) continue;                             // Bob ignores skills without a description too
      out.push({
        id: name,
        name: m.name || name,
        description: m.description,
        category: m.category || "Uncategorised",
        tags: Array.isArray(m.tags) ? m.tags : m.tags ? String(m.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
        path: "skills/" + name + "/SKILL.md",
        body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function load() {
    if (!folder) return;
    const data = await readSkills(folder);
    const snapshot = JSON.stringify(data);
    if (snapshot === lastSnapshot) return;                     // nothing changed since last check
    lastSnapshot = snapshot;
    base = data;
    $("list").hidden = false;
    $("empty").querySelector("p").textContent = "No skills match these filters.";
    $("reset").hidden = false;
    refresh();
  }

  // Shown until the folder is readable. kind: "pick" (first time), "allow" (browser wants a click), "unsupported".
  function askForFolder(kind, note) {
    const msg = {
      pick: "Choose your <code>.bob/skills</code> folder once. The browser remembers it after that.",
      allow: "Click to let this page read your skills again.",
      unsupported: "This browser can't read folders. Open the dashboard in <b>Chrome</b> or <b>Edge</b>.",
    }[kind];
    $("source").textContent = "Skills folder not opened";
    $("stats").innerHTML = "";
    $("list").hidden = true; $("empty").hidden = false; $("reset").hidden = true;
    $("empty").querySelector("p").innerHTML = msg + (note ? `<br><small>${esc(note)}</small>` : "") +
      (kind === "unsupported" ? "" : `<br><button class="icon-btn" id="pickFolder" style="margin-top:14px">${kind === "pick" ? "Choose skills folder" : "Allow"}</button>`);
  }

  async function openFolder(handle) {
    const dir = await skillsDir(handle);
    if (!dir) return askForFolder("pick", `"${handle.name}" has no skills folder in it. Pick .bob/skills.`);
    folder = dir;
    saveFolder(handle);                                        // remember it for next time (never blocks loading)
    lastSnapshot = "";
    await load();
  }

  async function pick() {
    try { await openFolder(await window.showDirectoryPicker({ id: "bob-skills", mode: "read" })); }
    catch (err) { if (err.name !== "AbortError") askForFolder("pick", err.message); }
  }

  async function allow(handle) {
    try {
      if ((await handle.requestPermission({ mode: "read" })) === "granted") return openFolder(handle);
    } catch {}
    askForFolder("pick", "Permission wasn't given. Pick the folder again.");
  }

  async function connectFolder() {
    if (!window.showDirectoryPicker) return askForFolder("unsupported");
    const saved = await savedFolder();
    if (!saved) return askForFolder("pick");
    let perm = "prompt";
    try { perm = await saved.queryPermission({ mode: "read" }); } catch {}
    if (perm === "granted") {
      try { return await openFolder(saved); } catch {}
      return askForFolder("pick", "The saved folder can't be read any more (moved or deleted?). Pick it again.");
    }
    askForFolder("allow");
    $("empty").dataset.saved = "1";
  }

  $("folderBtn").addEventListener("click", pick);
  $("empty").addEventListener("click", async (e) => {
    if (e.target.id !== "pickFolder") return;
    const saved = $("empty").dataset.saved ? await savedFolder() : null;
    delete $("empty").dataset.saved;
    if (saved) allow(saved); else pick();
  });

  // Merge the skill list with the live Firestore numbers and redraw.
  function refresh() {
    if (!lastSnapshot) return;                                 // skill list not loaded yet
    skills = base.map((s) => ({ ...s, count: usage[s.id]?.count || 0, lastUsed: usage[s.id]?.lastUsed || 0 }));
    catColor = {};
    [...new Set(skills.map((s) => s.category))].sort().forEach((c, i) => (catColor[c] = PALETTE[i % PALETTE.length]));
    if (state.cat && !catColor[state.cat]) state.cat = "";
    const status = {
      connecting: "connecting to Firestore…",
      live: "live counts from Firestore",
      off: "Firestore not set up: fill in assets/data/skills-firebase-db-config.js",
      error: "Firestore error: " + liveError,
    }[live];
    $("source").textContent = `${skills.length} skills · ${status}`;
    $("source").title = status;
    renderFilters();
    render();
    route();
  }

  function connectFirestore() {
    const cfg = window.BOB_FIREBASE;
    if (!window.firebase || !cfg || !cfg.apiKey || !cfg.projectId || /^YOUR_/.test(cfg.apiKey + cfg.projectId)) {
      live = "off"; refresh(); return;
    }
    try {
      firebase.initializeApp(cfg).firestore().collection("skills").onSnapshot((snap) => {
        const next = {};
        snap.forEach((d) => {
          const x = d.data({ serverTimestamps: "estimate" });
          next[d.id] = { count: Number(x.count) || 0, lastUsed: x.lastUsedAt && x.lastUsedAt.toMillis ? x.lastUsedAt.toMillis() : 0 };
        });
        usage = next; live = "live"; refresh();
      }, (err) => { live = "error"; liveError = err.message; refresh(); });
    } catch (err) {
      live = "error"; liveError = err.message; refresh();
    }
  }

  async function start() {
    connectFirestore();
    setInterval(() => { if (!document.hidden && live === "live") render(); }, 60000);   // keep "x min ago" fresh
    await connectFolder();
    // Re-read the SKILL.md files every few seconds, so added or edited skills show up without reloading.
    setInterval(() => { if (!document.hidden) load().catch(() => {}); }, POLL_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load().catch(() => {}); });
  }

  /* ---------- filtering ---------- */
  function visible() {
    const q = state.q.trim().toLowerCase();
    const list = skills.filter((s) => {
      if (state.cat && s.category !== state.cat) return false;
      if (state.tag && !s.tags.includes(state.tag)) return false;
      if (state.usage === "used" && !s.count) return false;
      if (state.usage === "unused" && s.count) return false;
      if (q && !`${s.name} ${s.description} ${s.category} ${s.tags.join(" ")}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const mul = state.dir === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      const x = a[state.key], y = b[state.key];
      const r = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
      return r !== 0 ? r * mul : b.count - a.count || a.name.localeCompare(b.name);
    });
  }

  /* ---------- list screen ---------- */
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
    $("active").hidden = !pills.length;
    $("active").innerHTML = pills.length
      ? `<span>${list.length} of ${skills.length}</span>` +
        pills.map(([k, label]) => `<button class="pill" data-clear="${k}">${esc(label)}<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`).join("") +
        `<button class="link" data-clear="all">Clear all</button>`
      : "";

    $("list").innerHTML = list.map((s, i) => `
      <li class="item" data-id="${esc(s.id)}" tabindex="0" role="link" aria-label="Open ${esc(s.name)}">
        <span class="rank${i < 3 && state.key === "count" && state.dir === "desc" && s.count ? " top" : ""}">${i + 1}</span>
        <div class="body">
          <div class="title">
            <span class="name">${highlight(s.name, q)}</span>
            <span class="badge"><span class="dot" style="background:${catColor[s.category]}"></span>${esc(s.category)}</span>
          </div>
          <p class="desc">${highlight(s.description, q)}</p>
          <div class="tags">${s.tags.map((t) => `<button class="tag${t === state.tag ? " on" : ""}" data-tag="${esc(t)}">#${highlight(t, q)}</button>`).join("")}</div>
        </div>
        <div class="usage">
          <div class="top"><span class="count${s.count ? "" : " zero"}">${s.count}</span><span class="unit">${plural(s.count)}</span></div>
          <div class="bar"><i style="width:${((s.count / max) * 100).toFixed(1)}%"></i></div>
          <span class="last" title="${esc(fullDate(s.lastUsed))}">${s.lastUsed ? "Last used " + ago(s.lastUsed) : "Never used"}</span>
        </div>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </li>`).join("");
    $("list").hidden = !list.length;
    $("empty").hidden = !!list.length;

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
        ${top && top.count ? `<div class="k" style="margin-top:4px">${top.count} ${plural(top.count)}</div>` : ""}</div>`;
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
  function back() { if (cameFromList) history.back(); else location.hash = ""; }

  function route() {
    const m = location.hash.match(/^#\/skill\/(.+)$/);
    const skill = m && skills.find((s) => s.id === decodeURIComponent(m[1]));
    if (skill) {
      renderDetail(skill);
      if ($("detailView").hidden) window.scrollTo(0, 0);
      $("listView").hidden = true; $("detailView").hidden = false;
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
    const body = s.body ? markdown(s.body) : `<p class="muted">This SKILL.md has no content beyond its header.</p>`;

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
              <div><dt>Last used</dt><dd title="${esc(fullDate(s.lastUsed))}">${s.lastUsed ? ago(s.lastUsed) : "Never"}</dd></div>
            </dl>
          </div>
        </aside>
      </div>`;
  }

  /* ---------- events ---------- */
  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("cats").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.cat = b.dataset.cat; render(); } });
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
  $("usage").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.usage = b.dataset.val; render(); } });
  $("sort").addEventListener("change", (e) => {
    state.key = e.target.value;
    state.dir = state.key === "count" || state.key === "lastUsed" ? "desc" : "asc";
    render();
  });
  $("dir").addEventListener("click", () => { state.dir = state.dir === "asc" ? "desc" : "asc"; render(); });
  function clearAll() { Object.assign(state, { q: "", cat: "", tag: "", usage: "all" }); $("q").value = ""; render(); }
  $("active").addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear]"); if (!b) return;
    if (b.dataset.clear === "all") return clearAll();
    if (b.dataset.clear === "q") $("q").value = "";
    state[b.dataset.clear] = DEFAULTS[b.dataset.clear]; render();
  });
  $("reset").addEventListener("click", clearAll);

  $("detailView").addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    if (t.dataset.act === "back") return back();
    if (t.dataset.go) return location.replace("#/skill/" + encodeURIComponent(t.dataset.go));
    if (t.dataset.filterTag !== undefined) { state.tag = t.dataset.filterTag; location.hash = ""; render(); return; }
    if (t.dataset.copy !== undefined) {
      try { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = "Copied"; } catch { t.textContent = "Copy failed"; }
      setTimeout(() => (t.textContent = "Copy"), 1200);
    }
  });
  window.addEventListener("hashchange", route);

  document.addEventListener("keydown", (e) => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === "Escape" && !$("detailView").hidden) return back();
    if (e.key === "/" && !typing) { e.preventDefault(); $("q").focus(); }
    if (e.key === "Escape" && document.activeElement === $("q")) { $("q").value = ""; state.q = ""; render(); $("q").blur(); }
  });

  start();
})();
