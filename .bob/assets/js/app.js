// =============================================================================
// Bob Skills dashboard
//
// Where the data comes from:
//   - The skills:  every SKILL.md in the skills folder, read directly by this page.
//                  (A page can't open a folder on its own, so you pick it once and the
//                  browser remembers it. Needs Chrome or Edge.)
//   - The usage:   Firestore, collection "skills" -> { count, lastUsedAt } per skill folder.
//                  Updates arrive live, no refresh needed.
//
// Sections, in order:
//   1. Settings and state      5. Combine skills + usage     9. Detail screen
//   2. Small helpers           6. Filter and sort           10. Markdown
//   3. Skills folder           7. Theme                     11. Clicks and keys
//   4. Firestore               8. List screen               12. Start
// =============================================================================

(() => {
  "use strict";

  // ===========================================================================
  // 1. Settings and state
  // ===========================================================================

  const RE_READ_SKILLS_EVERY_MS = 3000;     // picks up new or edited SKILL.md files
  const REFRESH_TIMES_EVERY_MS = 60000;     // keeps "5 min ago" up to date

  const CATEGORY_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

  const DEFAULT_FILTERS = { search: "", category: "", tag: "", usage: "all", sortBy: "count", sortDirection: "desc" };
  const filters = { ...DEFAULT_FILTERS };

  let skillsFolder = null;          // the folder the user picked
  let skillsFromFiles = [];         // what the SKILL.md files say
  let lastFilesSnapshot = "";       // to skip redrawing when nothing changed
  let usageFromFirestore = {};      // folder name -> { count, lastUsed }
  let firestoreStatus = "connecting";   // connecting | live | off | error
  let firestoreError = "";

  let skills = [];                  // skillsFromFiles + their usage: what the screens show
  let categoryColor = {};           // category name -> color

  // ===========================================================================
  // 2. Small helpers
  // ===========================================================================

  const byId = (id) => document.getElementById(id);

  // Makes text safe to put inside HTML.
  function escapeHtml(text) {
    const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(text ?? "").replace(/[&<>"']/g, (char) => replacements[char]);
  }

  // Escapes text and wraps every match of the search in <mark>.
  function highlightSearch(text, search) {
    const safeText = escapeHtml(text);
    if (!search) return safeText;
    const safeSearch = escapeHtml(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return safeText.replace(new RegExp("(" + safeSearch + ")", "ig"), "<mark>$1</mark>");
  }

  const usesWord = (count) => (count === 1 ? "use" : "uses");

  // 12 minutes ago -> "12 min ago"
  function timeAgo(timeMs) {
    if (!timeMs) return "never";
    const seconds = Math.max(0, (Date.now() - timeMs) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " h ago";
    if (seconds < 86400 * 30) return Math.floor(seconds / 86400) + " d ago";
    return new Date(timeMs).toLocaleDateString();
  }

  const fullDate = (timeMs) => (timeMs ? new Date(timeMs).toLocaleString() : "Never");

  const lastUsedText = (skill) => (skill.lastUsed ? "Last used " + timeAgo(skill.lastUsed) : "Never used");

  // Width of a usage bar, as a % of the most used skill.
  function barWidth(count) {
    const highest = Math.max(1, ...skills.map((skill) => skill.count));
    return ((count / highest) * 100).toFixed(1) + "%";
  }

  const totalUses = () => skills.reduce((sum, skill) => sum + skill.count, 0);

  // ===========================================================================
  // 3. Skills folder: pick it once, remember it, read every SKILL.md
  // ===========================================================================

  // --- Remembering the folder (a folder can only be saved in IndexedDB) ---

  function withSavedStore(mode, action) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("bob-skills", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        try {
          const transaction = request.result.transaction("kv", mode);
          const result = action(transaction.objectStore("kv"));
          transaction.oncomplete = () => resolve(result && result.result);
          transaction.onerror = () => reject(transaction.error);
        } catch (error) {
          reject(error);
        }
      };
    });
  }

  const loadSavedFolder = () => withSavedStore("readonly", (store) => store.get("folder")).catch(() => null);
  const saveFolder = (folder) => withSavedStore("readwrite", (store) => store.put(folder, "folder")).catch(() => {});

  // --- Finding the skills folder inside what the user picked ---

  async function subfolder(folder, name) {
    try { return await folder.getDirectoryHandle(name); } catch { return null; }
  }

  // Accepts the skills folder itself, the .bob folder, or the repo root.
  async function findSkillsFolder(picked) {
    if (picked.name === "skills") return picked;
    const skillsInside = await subfolder(picked, "skills");
    if (skillsInside) return skillsInside;
    const bobFolder = await subfolder(picked, ".bob");
    return bobFolder ? subfolder(bobFolder, "skills") : null;
  }

  // --- Reading the SKILL.md files ---

  // Reads the header at the top of a SKILL.md:
  //   ---
  //   name: compose-screen
  //   description: ...
  //   tags: [compose, ui]
  //   ---
  function readHeader(text) {
    const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fields = {};
    if (!header) return fields;

    const lines = header[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const keyValue = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
      if (!keyValue) continue;
      const key = keyValue[1];
      let value = keyValue[2].trim();

      // Value continues on the next, indented lines (YAML "|" or ">" or a "- item" list).
      if (value === "" || /^[>|][+-]?$/.test(value)) {
        const nextLines = [];
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) nextLines.push(lines[++i].trim());
        const isList = nextLines.length && nextLines.every((line) => line.startsWith("- "));
        if (isList) { fields[key] = nextLines.map((line) => line.slice(2).trim()); continue; }
        value = nextLines.join(" ");
      }

      if (value.startsWith("[") && value.endsWith("]")) {
        fields[key] = value.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);   // [a, b]
      } else {
        fields[key] = value.replace(/^["']|["']$/g, "");                                            // "quoted"
      }
    }
    return fields;
  }

  function toTagList(tags) {
    if (Array.isArray(tags)) return tags;
    if (!tags) return [];
    return String(tags).split(",").map((tag) => tag.trim()).filter(Boolean);
  }

  async function readSkillFile(folderEntry) {
    try {
      const file = await (await folderEntry.getFileHandle("SKILL.md")).getFile();
      return await file.text();
    } catch {
      return null;
    }
  }

  async function readAllSkills(folder) {
    const found = [];
    for await (const [folderName, entry] of folder.entries()) {
      if (entry.kind !== "directory") continue;
      const text = await readSkillFile(entry);
      if (!text) continue;

      const header = readHeader(text);
      if (!header.description) continue;          // Bob ignores skills without a description too

      found.push({
        id: folderName,                           // the folder name is the skill's ID (same as in Firestore)
        name: header.name || folderName,
        description: header.description,
        category: header.category || "Uncategorised",
        tags: toTagList(header.tags),
        path: "skills/" + folderName + "/SKILL.md",
        body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim(),
      });
    }
    return found.sort((a, b) => a.id.localeCompare(b.id));
  }

  // Re-reads the folder; redraws only if a SKILL.md changed.
  async function reloadSkills() {
    if (!skillsFolder) return;
    const fresh = await readAllSkills(skillsFolder);
    const snapshot = JSON.stringify(fresh);
    if (snapshot === lastFilesSnapshot) return;
    lastFilesSnapshot = snapshot;
    skillsFromFiles = fresh;

    byId("list").hidden = false;
    byId("empty").querySelector("p").textContent = "No skills match these filters.";
    byId("reset").hidden = false;
    redrawEverything();
  }

  // --- Asking the user for the folder ---

  const FOLDER_MESSAGES = {
    pick: "Choose your <code>.bob/skills</code> folder once. The browser remembers it after that.",
    allow: "Click to let this page read your skills again.",
    unsupported: "This browser can't read folders. Open the dashboard in <b>Chrome</b> or <b>Edge</b>.",
  };

  // Shown until the folder can be read. reason: "pick" (first time), "allow" (browser wants a click), "unsupported".
  function showFolderPrompt(reason, note) {
    byId("source").textContent = "Skills folder not opened";
    byId("stats").innerHTML = "";
    byId("list").hidden = true;
    byId("empty").hidden = false;
    byId("reset").hidden = true;

    const noteHtml = note ? `<br><small>${escapeHtml(note)}</small>` : "";
    const buttonLabel = reason === "pick" ? "Choose skills folder" : "Allow";
    const buttonHtml = reason === "unsupported" ? ""
      : `<br><button class="icon-btn" id="pickFolder" style="margin-top:14px">${buttonLabel}</button>`;
    byId("empty").querySelector("p").innerHTML = FOLDER_MESSAGES[reason] + noteHtml + buttonHtml;
  }

  async function useFolder(picked) {
    const folder = await findSkillsFolder(picked);
    if (!folder) return showFolderPrompt("pick", `"${picked.name}" has no skills folder in it. Pick .bob/skills.`);
    skillsFolder = folder;
    saveFolder(picked);                // remember for next time (doesn't hold up loading)
    lastFilesSnapshot = "";
    await reloadSkills();
  }

  async function askUserToPickFolder() {
    try {
      await useFolder(await window.showDirectoryPicker({ id: "bob-skills", mode: "read" }));
    } catch (error) {
      if (error.name !== "AbortError") showFolderPrompt("pick", error.message);   // AbortError = user cancelled
    }
  }

  async function askUserToAllowFolder(savedFolder) {
    try {
      const answer = await savedFolder.requestPermission({ mode: "read" });
      if (answer === "granted") return useFolder(savedFolder);
    } catch {}
    showFolderPrompt("pick", "Permission wasn't given. Pick the folder again.");
  }

  // On page open: use the remembered folder if we can, otherwise ask.
  async function openRememberedFolder() {
    if (!window.showDirectoryPicker) return showFolderPrompt("unsupported");

    const savedFolder = await loadSavedFolder();
    if (!savedFolder) return showFolderPrompt("pick");

    let permission = "prompt";
    try { permission = await savedFolder.queryPermission({ mode: "read" }); } catch {}

    if (permission === "granted") {
      try { return await useFolder(savedFolder); } catch {}
      return showFolderPrompt("pick", "The saved folder can't be read any more (moved or deleted?). Pick it again.");
    }

    // The browser wants a click before it lets us read the folder again.
    showFolderPrompt("allow");
    byId("empty").dataset.saved = "1";
  }

  async function onFolderPromptButton() {
    const hasSavedFolder = byId("empty").dataset.saved;
    delete byId("empty").dataset.saved;
    const savedFolder = hasSavedFolder ? await loadSavedFolder() : null;
    if (savedFolder) askUserToAllowFolder(savedFolder);
    else askUserToPickFolder();
  }

  // ===========================================================================
  // 4. Firestore: live usage counts
  // ===========================================================================

  function isFirebaseConfigured(config) {
    return window.firebase && config && config.apiKey && config.projectId && !/^YOUR_/.test(config.apiKey + config.projectId);
  }

  function readUsage(snapshot) {
    const usage = {};
    snapshot.forEach((doc) => {
      const data = doc.data({ serverTimestamps: "estimate" });
      usage[doc.id] = {
        count: Number(data.count) || 0,
        lastUsed: data.lastUsedAt && data.lastUsedAt.toMillis ? data.lastUsedAt.toMillis() : 0,
      };
    });
    return usage;
  }

  function setFirestoreStatus(status, error) {
    firestoreStatus = status;
    firestoreError = error || "";
    redrawEverything();
  }

  function listenToFirestore() {
    const config = window.BOB_FIREBASE;
    if (!isFirebaseConfigured(config)) return setFirestoreStatus("off");

    try {
      const skillsCollection = firebase.initializeApp(config).firestore().collection("skills");
      skillsCollection.onSnapshot(
        (snapshot) => { usageFromFirestore = readUsage(snapshot); setFirestoreStatus("live"); },
        (error) => setFirestoreStatus("error", error.message),
      );
    } catch (error) {
      setFirestoreStatus("error", error.message);
    }
  }

  function firestoreStatusText() {
    if (firestoreStatus === "connecting") return "connecting to Firestore…";
    if (firestoreStatus === "live") return "live counts from Firestore";
    if (firestoreStatus === "off") return "Firestore not set up: fill in assets/data/skills-firebase-db-config.js";
    return "Firestore error: " + firestoreError;
  }

  // ===========================================================================
  // 5. Combine skills + usage, then redraw
  // ===========================================================================

  function assignCategoryColors() {
    categoryColor = {};
    const categories = [...new Set(skills.map((skill) => skill.category))].sort();
    categories.forEach((category, i) => (categoryColor[category] = CATEGORY_COLORS[i % CATEGORY_COLORS.length]));
    if (filters.category && !categoryColor[filters.category]) filters.category = "";
  }

  function redrawEverything() {
    if (!lastFilesSnapshot) return;            // skills not read yet

    skills = skillsFromFiles.map((skill) => {
      const usage = usageFromFirestore[skill.id] || {};
      return { ...skill, count: usage.count || 0, lastUsed: usage.lastUsed || 0 };
    });
    assignCategoryColors();

    const status = firestoreStatusText();
    byId("source").textContent = `${skills.length} skills · ${status}`;
    byId("source").title = status;

    renderSidebar();
    renderList();
    showCurrentScreen();
  }

  // ===========================================================================
  // 6. Filter and sort
  // ===========================================================================

  function matchesFilters(skill) {
    const search = filters.search.trim().toLowerCase();
    if (filters.category && skill.category !== filters.category) return false;
    if (filters.tag && !skill.tags.includes(filters.tag)) return false;
    if (filters.usage === "used" && !skill.count) return false;
    if (filters.usage === "unused" && skill.count) return false;
    if (search) {
      const searchableText = `${skill.name} ${skill.description} ${skill.category} ${skill.tags.join(" ")}`.toLowerCase();
      if (!searchableText.includes(search)) return false;
    }
    return true;
  }

  function compareSkills(a, b) {
    const valueA = a[filters.sortBy];
    const valueB = b[filters.sortBy];
    const difference = typeof valueA === "number" ? valueA - valueB : String(valueA).localeCompare(String(valueB));
    if (difference !== 0) return filters.sortDirection === "asc" ? difference : -difference;
    return b.count - a.count || a.name.localeCompare(b.name);      // tie: most used, then A-Z
  }

  const visibleSkills = () => skills.filter(matchesFilters).sort(compareSkills);

  function clearAllFilters() {
    Object.assign(filters, { search: "", category: "", tag: "", usage: "all" });
    byId("q").value = "";
    renderList();
  }

  // ===========================================================================
  // 7. Theme (light / dark)
  // ===========================================================================

  function loadTheme() {
    try {
      const saved = localStorage.getItem("bob-theme");
      if (saved) document.documentElement.dataset.theme = saved;
    } catch {}
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme;
    const isDark = current ? current === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("bob-theme", next); } catch {}
  }

  // ===========================================================================
  // 8. List screen
  // ===========================================================================

  const ICON_CLOSE = `<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  const ICON_CHEVRON = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;

  const categoryDot = (category) => `<span class="dot" style="background:${categoryColor[category]}"></span>`;

  // --- Sidebar: categories and tags ---

  function renderSidebar() {
    const skillsPerCategory = {};
    skills.forEach((skill) => (skillsPerCategory[skill.category] = (skillsPerCategory[skill.category] || 0) + 1));

    const categoryButtons = [["", "All skills", skills.length]]
      .concat(Object.keys(skillsPerCategory).sort().map((category) => [category, category, skillsPerCategory[category]]));

    byId("cats").innerHTML = categoryButtons.map(([value, label, count]) => `
      <button data-cat="${escapeHtml(value)}">
        <span class="lbl">${value ? categoryDot(value) : ""}${escapeHtml(label)}</span>
        <span class="n">${count}</span>
      </button>`).join("");

    const skillsPerTag = {};
    skills.forEach((skill) => skill.tags.forEach((tag) => (skillsPerTag[tag] = (skillsPerTag[tag] || 0) + 1)));
    const tagsMostUsedFirst = Object.keys(skillsPerTag).sort((a, b) => skillsPerTag[b] - skillsPerTag[a] || a.localeCompare(b));

    byId("tags").innerHTML = tagsMostUsedFirst
      .map((tag) => `<button class="chip" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join("");
  }

  // --- Highlight the buttons that match the current filters ---

  function showSelectedFilters() {
    const press = (selector, isOn) => document.querySelectorAll(selector).forEach((button) => button.setAttribute("aria-pressed", String(isOn(button))));
    press("#cats button", (button) => button.dataset.cat === filters.category);
    press("#tags .chip", (button) => button.dataset.tag === filters.tag);
    press("#usage button", (button) => button.dataset.val === filters.usage);
    byId("sort").value = filters.sortBy;
    byId("dir").dataset.dir = filters.sortDirection;
  }

  // --- "3 of 14  [UI x]  [#compose x]  Clear all" ---

  function renderActiveFilterPills(shownCount) {
    const search = filters.search.trim();
    const pills = [];
    if (filters.category) pills.push(["category", filters.category]);
    if (filters.tag) pills.push(["tag", "#" + filters.tag]);
    if (filters.usage !== "all") pills.push(["usage", filters.usage === "used" ? "Used" : "Never used"]);
    if (search) pills.push(["search", `“${search}”`]);

    byId("active").hidden = !pills.length;
    if (!pills.length) { byId("active").innerHTML = ""; return; }

    byId("active").innerHTML =
      `<span>${shownCount} of ${skills.length}</span>` +
      pills.map(([filter, label]) => `<button class="pill" data-clear="${filter}">${escapeHtml(label)}${ICON_CLOSE}</button>`).join("") +
      `<button class="link" data-clear="all">Clear all</button>`;
  }

  // --- One row in the list ---

  function skillRowHtml(skill, position) {
    const search = filters.search.trim();
    const isTopThree = position < 3 && filters.sortBy === "count" && filters.sortDirection === "desc" && skill.count;
    const tagsHtml = skill.tags
      .map((tag) => `<button class="tag${tag === filters.tag ? " on" : ""}" data-tag="${escapeHtml(tag)}">#${highlightSearch(tag, search)}</button>`)
      .join("");

    return `
      <li class="item" data-id="${escapeHtml(skill.id)}" tabindex="0" role="link" aria-label="Open ${escapeHtml(skill.name)}">
        <span class="rank${isTopThree ? " top" : ""}">${position + 1}</span>
        <div class="body">
          <div class="title">
            <span class="name">${highlightSearch(skill.name, search)}</span>
            <span class="badge">${categoryDot(skill.category)}${escapeHtml(skill.category)}</span>
          </div>
          <p class="desc">${highlightSearch(skill.description, search)}</p>
          <div class="tags">${tagsHtml}</div>
        </div>
        <div class="usage">
          <div class="top"><span class="count${skill.count ? "" : " zero"}">${skill.count}</span><span class="unit">${usesWord(skill.count)}</span></div>
          <div class="bar"><i style="width:${barWidth(skill.count)}"></i></div>
          <span class="last" title="${escapeHtml(fullDate(skill.lastUsed))}">${lastUsedText(skill)}</span>
        </div>
        ${ICON_CHEVRON}
      </li>`;
  }

  // --- The 4 boxes at the top ---

  function renderStats() {
    const usedCount = skills.filter((skill) => skill.count).length;
    const adoptionPercent = skills.length ? Math.round((usedCount / skills.length) * 100) : 0;
    const mostUsed = [...skills].sort((a, b) => b.count - a.count)[0];
    const hasMostUsed = mostUsed && mostUsed.count;

    byId("stats").innerHTML = `
      <div class="stat"><div class="k">Skills</div><div class="v">${skills.length}</div></div>
      <div class="stat"><div class="k">Total uses</div><div class="v">${totalUses().toLocaleString()}</div></div>
      <div class="stat"><div class="k">Adoption</div><div class="v">${usedCount}<small> / ${skills.length} used</small></div>
        <div class="meter"><i style="width:${adoptionPercent}%"></i></div></div>
      <div class="stat"><div class="k">Most used</div>
        <div class="v name" title="${mostUsed ? escapeHtml(mostUsed.name) : ""}">${hasMostUsed ? escapeHtml(mostUsed.name) : "—"}</div>
        ${hasMostUsed ? `<div class="k" style="margin-top:4px">${mostUsed.count} ${usesWord(mostUsed.count)}</div>` : ""}</div>`;
  }

  function renderList() {
    const shown = visibleSkills();

    showSelectedFilters();
    renderActiveFilterPills(shown.length);
    byId("list").innerHTML = shown.map(skillRowHtml).join("");
    byId("list").hidden = !shown.length;
    byId("empty").hidden = !!shown.length;
    renderStats();
  }

  // ===========================================================================
  // 9. Detail screen (#/skill/<folder-name>)
  // ===========================================================================

  let listScrollPosition = 0;
  let openedFromList = false;

  function openSkill(id) {
    listScrollPosition = window.scrollY;
    openedFromList = true;
    location.hash = "#/skill/" + encodeURIComponent(id);
  }

  function goBackToList() {
    if (openedFromList) history.back();
    else location.hash = "";
  }

  // Shows the list or a skill, depending on the address (#/skill/...).
  function showCurrentScreen() {
    const match = location.hash.match(/^#\/skill\/(.+)$/);
    const skill = match && skills.find((s) => s.id === decodeURIComponent(match[1]));

    if (skill) {
      renderDetail(skill);
      if (byId("detailView").hidden) window.scrollTo(0, 0);
      byId("listView").hidden = true;
      byId("detailView").hidden = false;
      document.title = skill.name + " · Bob Skills";
      return;
    }

    const wasOnDetail = !byId("detailView").hidden;
    byId("detailView").hidden = true;
    byId("listView").hidden = false;
    document.title = "Bob Skills";
    if (wasOnDetail) window.scrollTo(0, listScrollPosition);
    openedFromList = false;
  }

  function pagerButton(skill, direction) {
    const icon = direction === "Previous" ? "m15 18-6-6 6-6" : "m9 6 6 6-6 6";
    const attributes = skill ? `title="${direction}: ${escapeHtml(skill.name)}"` : "disabled";
    return `<button class="icon-btn square" data-go="${skill ? escapeHtml(skill.id) : ""}" ${attributes} aria-label="${direction} skill"><svg viewBox="0 0 24 24"><path d="${icon}"/></svg></button>`;
  }

  function renderDetail(skill) {
    // Rank among all skills
    const ranked = [...skills].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const rank = ranked.findIndex((s) => s.id === skill.id) + 1;
    const total = totalUses();
    const sharePercent = total ? Math.round((skill.count / total) * 100) : 0;

    // Previous / next, in the order the list currently shows
    const order = visibleSkills();
    const position = order.findIndex((s) => s.id === skill.id);
    const previous = position > 0 ? order[position - 1] : null;
    const next = position >= 0 && position < order.length - 1 ? order[position + 1] : null;

    const bodyHtml = skill.body ? markdownToHtml(skill.body) : `<p class="muted">This SKILL.md has no content beyond its header.</p>`;
    const tagsHtml = skill.tags.length
      ? `<div class="d-tags">${skill.tags.map((tag) => `<button class="chip" data-filter-tag="${escapeHtml(tag)}" title="Show all skills tagged ${escapeHtml(tag)}">#${escapeHtml(tag)}</button>`).join("")}</div>`
      : "";

    byId("detailView").innerHTML = `
      <nav class="crumbs">
        <button class="back" data-act="back"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>All skills</button>
        <div class="pager">
          ${pagerButton(previous, "Previous")}
          <span class="pos">${position >= 0 ? `${position + 1} / ${order.length}` : ""}</span>
          ${pagerButton(next, "Next")}
        </div>
      </nav>

      <header class="d-head">
        <span class="badge lg">${categoryDot(skill.category)}${escapeHtml(skill.category)}</span>
        <h2 class="d-title">${escapeHtml(skill.name)}</h2>
        <p class="d-desc">${escapeHtml(skill.description)}</p>
        ${tagsHtml}
      </header>

      <div class="d-grid">
        <article class="doc">
          <div class="doc-bar">
            <span><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/></svg>${escapeHtml(skill.path)}</span>
            <button class="link" data-copy="${escapeHtml(skill.body || "")}">Copy</button>
          </div>
          <div class="md">${bodyHtml}</div>
        </article>

        <aside class="d-side">
          <div class="card">
            <div class="k">Times used</div>
            <div class="big">${skill.count}</div>
            <div class="bar"><i style="width:${barWidth(skill.count)}"></i></div>
            <dl>
              <div><dt>Rank</dt><dd>#${rank} of ${skills.length}</dd></div>
              <div><dt>Share of all uses</dt><dd>${sharePercent}%</dd></div>
              <div><dt>Last used</dt><dd title="${escapeHtml(fullDate(skill.lastUsed))}">${skill.lastUsed ? timeAgo(skill.lastUsed) : "Never"}</dd></div>
            </dl>
          </div>
        </aside>
      </div>`;
  }

  // ===========================================================================
  // 10. Markdown -> HTML (a small, safe subset, for showing SKILL.md)
  // ===========================================================================

  // **bold**, *italic*, `code`, [link](https://...)
  function inlineMarkdown(text) {
    return escapeHtml(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  const IS_LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
  const IS_TABLE_ROW = /^\|.*\|\s*$/;
  const IS_TABLE_DIVIDER = /^\|[\s:|-]+\|\s*$/;
  const STARTS_ANOTHER_BLOCK = /^(#{1,4}\s|```|>|\s*([-*+]|\d+[.)])\s+|\|)/;

  function markdownToHtml(source) {
    const lines = String(source || "").replace(/\r/g, "").split("\n");
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      let match;

      // ```code block```
      if (/^```/.test(line)) {
        const language = line.slice(3).trim();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        html.push(`<pre${language ? ` data-lang="${escapeHtml(language)}"` : ""}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      // # Heading
      if ((match = line.match(/^(#{1,4})\s+(.*)$/))) {
        const level = Math.min(match[1].length + 1, 5);
        html.push(`<h${level}>${inlineMarkdown(match[2])}</h${level}>`);
        i++;
        continue;
      }

      // --- line
      if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
        html.push("<hr>");
        i++;
        continue;
      }

      // > quote
      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
        html.push(`<blockquote>${inlineMarkdown(quote.join(" "))}</blockquote>`);
        continue;
      }

      // - list / 1. list / - [x] task
      if (IS_LIST_ITEM.test(line)) {
        const isNumbered = /^\s*\d+[.)]/.test(line);
        const items = [];
        while (i < lines.length && IS_LIST_ITEM.test(lines[i])) {
          let item = lines[i++].replace(IS_LIST_ITEM, "");
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !IS_LIST_ITEM.test(lines[i])) item += " " + lines[i++].trim();
          const task = item.match(/^\[( |x)\]\s+(.*)$/i);
          items.push(task
            ? `<li class="task"><span class="box${task[1].trim() ? " done" : ""}"></span>${inlineMarkdown(task[2])}</li>`
            : `<li>${inlineMarkdown(item)}</li>`);
        }
        const tag = isNumbered ? "ol" : "ul";
        html.push(`<${tag}>${items.join("")}</${tag}>`);
        continue;
      }

      // | table |
      if (IS_TABLE_ROW.test(line) && i + 1 < lines.length && IS_TABLE_DIVIDER.test(lines[i + 1])) {
        const cells = (row) => row.trim().slice(1, -1).split("|").map((cell) => cell.trim());
        const headings = cells(line);
        const rows = [];
        i += 2;
        while (i < lines.length && IS_TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
        const headHtml = headings.map((h) => `<th>${inlineMarkdown(h)}</th>`).join("");
        const rowsHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("");
        html.push(`<div class="tbl"><table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`);
        continue;
      }

      // empty line
      if (!line.trim()) { i++; continue; }

      // paragraph: joins lines until an empty line or another block starts
      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !STARTS_ANOTHER_BLOCK.test(lines[i])) paragraph.push(lines[i++]);
      if (!paragraph.length) paragraph.push(lines[i++]);
      html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    }

    return html.join("\n");
  }

  // ===========================================================================
  // 11. Clicks and keys
  // ===========================================================================

  function toggleTagFilter(event) {
    const button = event.target.closest("[data-tag]");
    if (!button) return;
    filters.tag = filters.tag === button.dataset.tag ? "" : button.dataset.tag;
    renderList();
  }

  function onSortChange(event) {
    filters.sortBy = event.target.value;
    const newestOrBiggestFirst = filters.sortBy === "count" || filters.sortBy === "lastUsed";
    filters.sortDirection = newestOrBiggestFirst ? "desc" : "asc";
    renderList();
  }

  function onPillClick(event) {
    const button = event.target.closest("[data-clear]");
    if (!button) return;
    const filter = button.dataset.clear;
    if (filter === "all") return clearAllFilters();
    if (filter === "search") byId("q").value = "";
    filters[filter] = DEFAULT_FILTERS[filter];
    renderList();
  }

  function onListClick(event) {
    if (event.target.closest("[data-tag]")) return toggleTagFilter(event);
    const row = event.target.closest(".item");
    if (row) openSkill(row.dataset.id);
  }

  function onListKey(event) {
    const row = event.target.closest(".item");
    const isOpenKey = event.key === "Enter" || event.key === " ";
    if (row && isOpenKey && !event.target.closest("[data-tag]")) {
      event.preventDefault();
      openSkill(row.dataset.id);
    }
  }

  async function onDetailClick(event) {
    const button = event.target.closest("button");
    if (!button) return;

    if (button.dataset.act === "back") return goBackToList();
    if (button.dataset.go) return location.replace("#/skill/" + encodeURIComponent(button.dataset.go));

    if (button.dataset.filterTag !== undefined) {
      filters.tag = button.dataset.filterTag;
      location.hash = "";
      renderList();
      return;
    }

    if (button.dataset.copy !== undefined) {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Copy failed";
      }
      setTimeout(() => (button.textContent = "Copy"), 1200);
    }
  }

  // "/" focuses search, Esc clears search or goes back.
  function onKeyboardShortcut(event) {
    const isTyping = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    const searchBox = byId("q");

    if (event.key === "Escape" && !byId("detailView").hidden) return goBackToList();
    if (event.key === "/" && !isTyping) {
      event.preventDefault();
      searchBox.focus();
    }
    if (event.key === "Escape" && document.activeElement === searchBox) {
      searchBox.value = "";
      filters.search = "";
      renderList();
      searchBox.blur();
    }
  }

  function connectEvents() {
    byId("theme").addEventListener("click", toggleTheme);
    byId("folderBtn").addEventListener("click", askUserToPickFolder);
    byId("empty").addEventListener("click", (event) => { if (event.target.id === "pickFolder") onFolderPromptButton(); });

    byId("q").addEventListener("input", (event) => { filters.search = event.target.value; renderList(); });
    byId("cats").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button) { filters.category = button.dataset.cat; renderList(); }
    });
    byId("tags").addEventListener("click", toggleTagFilter);
    byId("usage").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button) { filters.usage = button.dataset.val; renderList(); }
    });
    byId("sort").addEventListener("change", onSortChange);
    byId("dir").addEventListener("click", () => {
      filters.sortDirection = filters.sortDirection === "asc" ? "desc" : "asc";
      renderList();
    });
    byId("active").addEventListener("click", onPillClick);
    byId("reset").addEventListener("click", clearAllFilters);

    byId("list").addEventListener("click", onListClick);
    byId("list").addEventListener("keydown", onListKey);
    byId("detailView").addEventListener("click", onDetailClick);

    window.addEventListener("hashchange", showCurrentScreen);
    document.addEventListener("keydown", onKeyboardShortcut);
  }

  // ===========================================================================
  // 12. Start
  // ===========================================================================

  async function start() {
    loadTheme();
    connectEvents();
    listenToFirestore();
    await openRememberedFolder();

    const reloadIfVisible = () => { if (!document.hidden) reloadSkills().catch(() => {}); };
    setInterval(reloadIfVisible, RE_READ_SKILLS_EVERY_MS);
    document.addEventListener("visibilitychange", reloadIfVisible);
    setInterval(() => { if (!document.hidden && firestoreStatus === "live") renderList(); }, REFRESH_TIMES_EVERY_MS);
  }

  start();
})();
