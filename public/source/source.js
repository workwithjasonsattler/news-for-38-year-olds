(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Auth — same pattern as public/app/app.js: cookie-first (same-
  // origin tab, credentials:'include' just works), bearer token
  // stored/sent if we ever get one back, forward-compatible with a
  // future Capacitor wrap. Shared `users`/`sessions` table with
  // N38YO per the locked scoping decision — a reader signed in on
  // one product is signed in on both.
  // ---------------------------------------------------------------
  const TOKEN_KEY = "source_app_token";

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const res = await fetch(path, Object.assign({}, opts, { headers, credentials: "include" }));
    let data = null;
    try { data = await res.json(); } catch (e) { /* not all responses are JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  let currentUser = null;
  async function refreshSession() {
    try {
      const data = await api("/api/me");
      currentUser = (data && data.user) || null;
    } catch (e) { currentUser = null; }
    return currentUser;
  }

  // ---------------------------------------------------------------
  // View mode — Terminal (original amber/void aesthetic) vs Mobile
  // (lighter, higher-contrast, scannable). User-swappable, for beta
  // testing which reads better. Defaults to Mobile.
  // ---------------------------------------------------------------
  const MODE_KEY = "source_view_mode";

  function getViewMode() {
    return localStorage.getItem(MODE_KEY) || "mobile";
  }

  function setViewMode(mode) {
    localStorage.setItem(MODE_KEY, mode);
    document.body.dataset.mode = mode;
    renderViewToggle();
  }

  function renderViewToggle() {
    const el = document.getElementById("viewToggle");
    if (!el) return;
    const mode = getViewMode();
    el.innerHTML = `
      <button class="view-toggle-btn${mode === "mobile" ? " active" : ""}" data-mode="mobile">MOBILE</button>
      <button class="view-toggle-btn${mode === "terminal" ? " active" : ""}" data-mode="terminal">TERM</button>`;
    el.querySelectorAll(".view-toggle-btn").forEach(btn => {
      btn.addEventListener("click", () => setViewMode(btn.dataset.mode));
    });
  }

  // ---------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function relTime(dateStr) {
    if (!dateStr) return "";
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return mins + "m";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h";
    return Math.floor(hrs / 24) + "d";
  }

  function stateBlock({ glyph, title, body, spin }) {
    return `<div class="state-block"><div class="terminal-glyph${spin ? " spin" : ""}">${glyph || ">_"}</div>
      <h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div>`;
  }

  // ---------------------------------------------------------------
  // Tab shell
  // ---------------------------------------------------------------
  const TABS = [
    { key: "read", label: "READ", prompt: ">" },
    { key: "sources", label: "SOURCES", prompt: ">" },
    { key: "buzz", label: "BUZZ", prompt: ">" },
    { key: "you", label: "YOU", prompt: ">" },
  ];

  let activeTab = "read";

  function renderTabBar() {
    const bar = document.getElementById("tabBar");
    bar.innerHTML = TABS.map(t => `
      <button class="tab-btn${t.key === activeTab ? " active" : ""}" data-tab="${t.key}">
        <span class="tab-prompt">${t.prompt}</span>${t.label}
      </button>`).join("");
    bar.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  function switchTab(key) {
    activeTab = key;
    renderTabBar();
    renderActiveTab();
  }

  function renderActiveTab() {
    const main = document.getElementById("main");
    main.classList.add("boot");
    setTimeout(() => main.classList.remove("boot"), 450);
    if (activeTab === "read") return renderRead();
    if (activeTab === "sources") return renderSources();
    if (activeTab === "buzz") return renderBuzz();
    if (activeTab === "you") return renderYou();
  }

  // ---------------------------------------------------------------
  // READ — the RSS reader, built on Sprays. Maps to /api/dispatches.
  // ---------------------------------------------------------------
  async function renderRead() {
    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "PULLING TRANSMISSION", body: "Fetching latest dispatches...", spin: true });
    try {
      const items = await api("/api/dispatches");
      if (!Array.isArray(items) || items.length === 0) {
        main.innerHTML = stateBlock({ glyph: "∅", title: "NO SIGNAL", body: "No dispatches available right now." });
        return;
      }
      const shown = items.slice(0, 60);
      main.innerHTML = shown.map(renderDispatchCard).join("");
      loadThumbnails(shown.map(d => d.id).filter(id => typeof id === "number"));
    } catch (e) {
      main.innerHTML = stateBlock({ glyph: "!", title: "TRANSMISSION FAILED", body: e.message || "Could not reach the wire." });
    }
  }

  function renderDispatchCard(d) {
    const excerpt = (d.excerpt || "").trim();
    return `
      <a class="card" href="${escapeHtml(d.link || "#")}" target="_blank" rel="noopener" style="display:block;">
        <div class="card-meta"><span>${escapeHtml(d.outlet || d.source || "UNKNOWN")}</span><span>${relTime(d.date)}</span></div>
        <div class="card-body">
          <div class="card-text">
            <div class="card-title">${escapeHtml(d.title || d.headline || "")}</div>
            ${excerpt ? `<div class="card-excerpt">${escapeHtml(excerpt.slice(0, 160))}</div>` : ""}
          </div>
          <img class="card-thumb" id="thumb-${d.id}" alt="" loading="lazy">
        </div>
      </a>`;
  }

  // Fetches thumbnails in batches of 20 (the endpoint's own cap) and pops
  // each image in as it resolves. Fails soft per-item — a dispatch with no
  // og:image, or a failed fetch, just leaves that card text-only.
  async function loadThumbnails(ids) {
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      if (batch.length === 0) continue;
      try {
        const map = await api(`/api/dispatches/thumbnails?ids=${batch.join(",")}`);
        Object.entries(map).forEach(([id, url]) => {
          if (!url) return;
          const img = document.getElementById(`thumb-${id}`);
          if (!img) return;
          img.src = url;
          img.addEventListener("load", () => img.classList.add("loaded"));
          img.addEventListener("error", () => img.remove());
        });
      } catch (e) {
        // fail soft — thumbnails are a nice-to-have, never block reading
      }
    }
  }

  // ---------------------------------------------------------------
  // SOURCES — adjust your reading pane / source tiers. Maps to
  // /api/sources + /api/my/source-tiers (same shared `feeds` table
  // as N38YO for v1, per the locked default).
  // ---------------------------------------------------------------
  async function renderSources() {
    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "LOADING SOURCE LIST", body: "Querying the registry...", spin: true });
    try {
      const sources = await api("/api/sources");
      if (!Array.isArray(sources) || sources.length === 0) {
        main.innerHTML = stateBlock({ glyph: "∅", title: "NO SOURCES", body: "Nothing in the registry yet." });
        return;
      }
      main.innerHTML = `
        <div class="card-meta" style="margin-bottom:10px;">${sources.length} SOURCES IN REGISTRY</div>
      ` + sources.map(s => `
        <div class="card">
          <div class="card-meta"><span>${escapeHtml(s.feed_url ? "ORGANIZATION" : "INDIVIDUAL")}</span></div>
          <div class="card-title">${escapeHtml(s.outlet || s.name || "")}</div>
        </div>`).join("");
    } catch (e) {
      main.innerHTML = stateBlock({ glyph: "!", title: "REGISTRY UNREACHABLE", body: e.message || "Could not load sources." });
    }
  }

  // ---------------------------------------------------------------
  // BUZZ — organized around big stories/topics. Maps to the Nerve
  // Center panels (Popular on Bluesky).
  // ---------------------------------------------------------------
  async function renderBuzz() {
    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "SCANNING CHATTER", body: "Pulling the signal off Bluesky...", spin: true });
    try {
      const posts = await api("/api/nerve-center/bluesky");
      if (!Array.isArray(posts) || posts.length === 0) {
        main.innerHTML = stateBlock({ glyph: "∅", title: "QUIET RIGHT NOW", body: "No chatter picked up in the current window." });
        return;
      }
      main.innerHTML = posts.slice(0, 40).map(p => `
        <a class="card" href="${escapeHtml(p.link || p.postUrl || "#")}" target="_blank" rel="noopener" style="display:block;">
          <div class="card-meta"><span>${escapeHtml(p.author || p.outlet || "")}</span><span>${relTime(p.indexedAt || p.date)}</span></div>
          <div class="card-title">${escapeHtml(p.text || p.title || "")}</div>
        </a>`).join("");
    } catch (e) {
      main.innerHTML = stateBlock({ glyph: "!", title: "SIGNAL LOST", body: e.message || "Could not reach Bluesky chatter." });
    }
  }

  // ---------------------------------------------------------------
  // YOU — account + shareable reading list. Maps to Account +
  // Sprays/custom-sources management.
  // ---------------------------------------------------------------
  async function renderYou() {
    const main = document.getElementById("main");
    await refreshSession();
    if (!currentUser) {
      main.innerHTML = `
        <div class="card">
          <div class="card-meta"><span>ACCESS</span></div>
          <div class="card-title" style="margin-bottom:10px;">Sign in to save your Sprays across devices.</div>
          <input id="youEmail" type="email" placeholder="you@domain.com"
            style="width:100%; padding:9px; background:var(--void); border:1px solid var(--line); color:var(--paper); font-family:var(--data); font-size:13px; margin-bottom:8px;">
          <button class="btn primary" id="youSendLink">SEND ACCESS LINK</button>
        </div>`;
      document.getElementById("youSendLink").addEventListener("click", async () => {
        const email = document.getElementById("youEmail").value.trim();
        if (!email) return;
        try {
          await api("/api/auth/request-link", { method: "POST", body: JSON.stringify({ email }) });
          toast("Check your email for an access link.");
        } catch (e) {
          toast(e.message || "Could not send link.");
        }
      });
      return;
    }
    main.innerHTML = `
      <div class="card">
        <div class="card-meta"><span>SIGNED IN</span><span class="stamp">VERIFIED</span></div>
        <div class="card-title">${escapeHtml(currentUser.email)}</div>
      </div>
      <button class="btn" id="youSignOut" style="margin-top:10px;">SIGN OUT</button>`;
    document.getElementById("youSignOut").addEventListener("click", async () => {
      try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      setToken("");
      currentUser = null;
      renderYou();
    });
  }

  // ---------------------------------------------------------------
  // Onboarding — first-run only. "Start with ours" lands on Read
  // (which already IS the live Headlines: Best in the World wire —
  // no clone needed to just read it). "Pick my own" heads to
  // Sources to start tuning. Per the locked scoping doc's decision
  // #9, a reader can also clone the flagship Spray for real later
  // from the Sources/You flow once signed in.
  // ---------------------------------------------------------------
  const ONBOARDED_KEY = "source_onboarded";

  function showOnboarding() {
    const el = document.createElement("div");
    el.className = "onboarding";
    el.id = "onboarding";
    el.innerHTML = `
      <div class="ob-wordmark">SOURCE?</div>
      <h1>Get the news first, from the best sources.</h1>
      <p>Start with our Best in the World News Spray, edit it, or pick your own.</p>
      <button class="ob-btn" id="obStart">Start with Best in the World
        <span class="ob-btn-sub">Our flagship Spray — live, unfiltered, always current</span></button>
      <button class="ob-btn secondary" id="obOwn">Pick my own sources
        <span class="ob-btn-sub">Build a Spray from scratch</span></button>
    `;
    document.body.appendChild(el);
    document.getElementById("obStart").addEventListener("click", () => dismissOnboarding("read"));
    document.getElementById("obOwn").addEventListener("click", () => dismissOnboarding("sources"));
  }

  function dismissOnboarding(landOnTab) {
    localStorage.setItem(ONBOARDED_KEY, "1");
    const el = document.getElementById("onboarding");
    if (el) el.remove();
    switchTab(landOnTab);
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", async () => {
    document.body.dataset.mode = getViewMode();
    renderViewToggle();
    renderTabBar();
    await refreshSession();
    renderActiveTab();

    if (!localStorage.getItem(ONBOARDED_KEY)) {
      showOnboarding();
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/source/sw.js").catch(() => { /* fail soft */ });
    }
  });
})();
