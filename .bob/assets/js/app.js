(() => {
  "use strict";

  // Data: assets/data/skills-data.js (written by the Bob hook from skills-usage.json + each SKILL.md).
  // Loaded as a <script> so it works when index.html is simply double-clicked.
  const DATA_URL = "assets/data/skills-data.js";
  const POLL_MS = 3000;

  const $ = (id) => document.getElementById(id);
  const DEFAULTS = { q: "", cat: "", tag: "", usage: "all", key: "count", dir: "desc" };
  const state = { ...DEFAULTS };
  const PALETTE = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];
  let skills = [];
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

  /* ---------- theme ---------- */
  try { const t = localStorage.getItem("bob-theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
  $("theme").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme;
    const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("bob-theme", dark ? "light" : "dark"); } catch {}
  });

  /* ---------- data ---------- */
  // (Re)load the data script; a fresh <script> each time picks up new counts.
  function loadScript() {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = DATA_URL + "?t=" + Date.now();
      el.onload = () => { el.remove(); resolve(window.BOB_SKILLS); };
      el.onerror = () => { el.remove(); reject(new Error("missing")); };
      document.head.appendChild(el);
    });
  }

  async function load() {
    window.BOB_SKILLS = undefined;
    const data = await loadScript();
    if (!Array.isArray(data)) throw new Error("bad data");
    const snapshot = JSON.stringify(data);
    if (snapshot === lastSnapshot) return;                     // nothing changed since last check
    lastSnapshot = snapshot;

    skills = data.map((s) => ({ ...s, tags: s.tags || [], count: Number(s.count) || 0 }));
    catColor = {};
    [...new Set(skills.map((s) => s.category))].sort().forEach((c, i) => (catColor[c] = PALETTE[i % PALETTE.length]));
    if (state.cat && !catColor[state.cat]) state.cat = "";
    $("source").textContent = `${skills.length} skills · counts from skills-usage.json`;
    $("empty").querySelector("p").textContent = "No skills match these filters.";
    $("reset").hidden = false;
    renderFilters();
    render();
    route();
  }

  async function start() {
    try {
      await load();
    } catch {
      $("source").textContent = "No data yet";
      $("list").hidden = true; $("empty").hidden = false; $("reset").hidden = true;
      $("empty").querySelector("p").innerHTML =
        "No data file yet. It's created when a Bob session starts,<br>or run <code>node .bob/assets/tools/skills.js build</code> once.";
    }
    setInterval(() => { if (!document.hidden) load().catch(() => {}); }, POLL_MS);
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
    state.dir = state.key === "count" ? "desc" : "asc";
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
