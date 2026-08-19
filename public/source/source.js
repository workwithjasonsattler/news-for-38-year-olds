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
  // Layout mode — Mobile (bottom tab bar, single column) vs Desktop
  // (top nav, reader pane + feed). Same theme/components either
  // way — this swaps ARRANGEMENT, not color scheme. Defaults to
  // Mobile. REVIEW-ONLY control now: it doesn't live inside the app
  // header anymore, it's rendered into #layoutReview, a fixed-to-
  // viewport element that sits outside the phone-frame preview so
  // it never shows up as an in-product control for a real reader —
  // it's here for looking at both arrangements during development.
  // ---------------------------------------------------------------
  const LAYOUT_KEY = "source_layout_mode";

  function getLayoutMode() {
    return localStorage.getItem(LAYOUT_KEY) || "mobile";
  }

  function setLayoutMode(mode) {
    localStorage.setItem(LAYOUT_KEY, mode);
    document.body.dataset.layout = mode;
    renderLayoutReview();
    renderActiveTab();
  }

  function renderLayoutReview() {
    const el = document.getElementById("layoutReview");
    if (!el) return;
    const mode = getLayoutMode();
    el.innerHTML = `
      <span class="layout-review-label">PREVIEW</span>
      <button class="layout-review-btn${mode === "mobile" ? " active" : ""}" data-mode="mobile">MOBILE</button>
      <button class="layout-review-btn${mode === "desktop" ? " active" : ""}" data-mode="desktop">DESKTOP</button>`;
    el.querySelectorAll(".layout-review-btn").forEach(btn => {
      btn.addEventListener("click", () => setLayoutMode(btn.dataset.mode));
    });
  }

  // ---------------------------------------------------------------
  // Read display — Headlines Only (compact, RSS-style) vs Expanded
  // (image + excerpt, post/social-style). Doubles as the Desktop
  // reader's feed-list style, per Jason's spec: the right-hand feed
  // can be "rss style or post/notes/social media style" — same
  // toggle, one control, both surfaces read it.
  // ---------------------------------------------------------------
  const READ_DISPLAY_KEY = "source_read_display";

  function getReadDisplay() {
    return localStorage.getItem(READ_DISPLAY_KEY) || "expanded";
  }

  function setReadDisplay(mode) {
    localStorage.setItem(READ_DISPLAY_KEY, mode);
    renderViewMenu();
    if (activeTab === "read") renderRead();
  }

  function renderViewMenu() {
    const el = document.getElementById("viewMenu");
    if (!el) return;
    const mode = getReadDisplay();
    el.innerHTML = `
      <button class="view-menu-btn" id="viewMenuBtn" aria-haspopup="true" aria-expanded="false">VIEW ▾</button>
      <div class="view-menu-list" id="viewMenuList" hidden>
        <button class="view-menu-item${mode === "headlines" ? " active" : ""}" data-action="headlines">Headlines Only</button>
        <button class="view-menu-item${mode === "expanded" ? " active" : ""}" data-action="expanded">Expanded</button>
        <div class="view-menu-sep"></div>
        <button class="view-menu-item" data-action="customize">Customize</button>
      </div>`;
    const btn = document.getElementById("viewMenuBtn");
    const list = document.getElementById("viewMenuList");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = list.hidden;
      list.hidden = !opening;
      btn.setAttribute("aria-expanded", String(opening));
    });
    list.querySelectorAll(".view-menu-item").forEach(item => {
      item.addEventListener("click", () => {
        list.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        const action = item.dataset.action;
        if (action === "customize") { switchTab("sources"); return; }
        setReadDisplay(action);
      });
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

  // Deterministic small color for an outlet's initial-avatar chip — no
  // per-outlet icon assets exist in this codebase yet, so this gives
  // each source a stable, distinct visual identity for free.
  function outletHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function outletChip(name) {
    const label = (name || "Unknown").trim();
    const initial = label.charAt(0).toUpperCase() || "?";
    return `<span class="outlet-chip"><span class="outlet-avatar" style="background:hsl(${outletHue(label)} 55% 42%)">${escapeHtml(initial)}</span>${escapeHtml(label)}</span>`;
  }

  // ---------------------------------------------------------------
  // Per-article paywall labels — batched, lazy-loaded the same way
  // thumbnails are: render a hidden placeholder span for each dispatch
  // up front, then fill in whichever ones turn out to be soft/hard-
  // paywalled once the batched lookup resolves. A dispatch with no
  // detected paywall just never gets its placeholder filled in.
  // ---------------------------------------------------------------
  let paywallStatusMap = {};

  function paywallBadgePlaceholder(id) {
    return `<span class="paywall-badge" id="paywall-${id}" hidden></span>`;
  }

  function applyPaywallBadge(id, status) {
    const el = document.getElementById(`paywall-${id}`);
    if (!el || !status) return;
    el.hidden = false;
    el.textContent = status === "hard" ? "PAYWALL" : "SOFT PAYWALL";
    el.classList.add(status === "hard" ? "paywall-hard" : "paywall-soft");
  }

  async function loadPaywallStatus(ids) {
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20).filter(id => !(id in paywallStatusMap));
      if (batch.length === 0) continue;
      try {
        const map = await api(`/api/dispatches/paywall?ids=${batch.join(",")}`);
        batch.forEach(id => { paywallStatusMap[id] = map[id] || null; });
        Object.entries(map).forEach(([id, status]) => applyPaywallBadge(id, status));
      } catch (e) {
        // fail soft — a missing badge is fine, never blocks reading
      }
    }
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
    if (main) main.classList.remove("read-layout");
    const toggle = document.getElementById("sprayToggle");
    if (toggle && activeTab !== "read") toggle.hidden = true;
    if (activeTab === "read") return renderRead();
    if (activeTab === "sources") return renderSources();
    if (activeTab === "buzz") return renderBuzz();
    if (activeTab === "you") return renderYou();
  }

  // ---------------------------------------------------------------
  // READ — the RSS reader, built on Sprays. Maps to /api/dispatches.
  // Cards show a stored image immediately when the feed had one at
  // import time; only fall back to a live og:image lookup for items
  // that don't. Cards whose article is also trending on Bluesky get
  // a badge linking over to Buzz.
  // ---------------------------------------------------------------
  // Currently open story in the Desktop reader pane. Persists across a
  // manual refresh as long as that story is still in the fresh list;
  // falls back to the newest item otherwise.
  let selectedDispatch = null;

  // Shared official flagship Spray slug — matches server.mjs's
  // OFFICIAL_HEADLINES_SPRAY_SLUG. Used as the "News" fallback for
  // anonymous readers (who can't hit /api/my/spray-bar) and before the
  // signed-in reader's own bar has loaded.
  const OFFICIAL_NEWS_SLUG = "headlines-best-in-the-world";
  const ACTIVE_SPRAY_KEY = "source_active_spray";

  let sprayBarData = null; // { news: {slug,name}, sprays: [{slug,name}] }
  let activeSprayKey = localStorage.getItem(ACTIVE_SPRAY_KEY) || "all";

  // SOURCE!-only display shortener: the shared flagship Spray's real
  // name ("Headlines: Best in the World") stays unchanged everywhere
  // else (N38YO homepage, spray.html, the RSS feed title) — this is a
  // presentation-only override for tab/pill labels in this app, where
  // the full name is too wordy. Any other Spray's name passes through
  // untouched.
  function sprayDisplayName(slug, name) {
    if (slug === OFFICIAL_NEWS_SLUG) return "Headlines";
    return name;
  }

  async function loadSprayBar(force) {
    if (sprayBarData && !force) return sprayBarData;
    if (!currentUser) {
      sprayBarData = { news: { slug: OFFICIAL_NEWS_SLUG, name: "SOURCE! News" }, sprays: [] };
      return sprayBarData;
    }
    try {
      sprayBarData = await api("/api/my/spray-bar");
    } catch (e) {
      sprayBarData = { news: { slug: OFFICIAL_NEWS_SLUG, name: "SOURCE! News" }, sprays: [] };
    }
    return sprayBarData;
  }

  function setActiveSpray(key) {
    activeSprayKey = key;
    localStorage.setItem(ACTIVE_SPRAY_KEY, key);
    selectedDispatch = null;
    renderRead();
  }

  async function renderSprayToggle() {
    const el = document.getElementById("sprayToggle");
    if (!el) return;
    if (activeTab !== "read") { el.hidden = true; return; }
    await loadSprayBar();
    el.hidden = false;
    const pills = [
      { key: "all", label: "All" },
      { key: sprayBarData.news.slug, label: sprayDisplayName(sprayBarData.news.slug, sprayBarData.news.name) || "News" },
    ].concat(sprayBarData.sprays.map(s => ({ key: s.slug, label: sprayDisplayName(s.slug, s.name) })));
    el.innerHTML = pills.map(p => `
      <button class="spray-pill${p.key === activeSprayKey ? " active" : ""}" data-key="${escapeHtml(p.key)}">${escapeHtml(p.label)}</button>
    `).join("") + `<button class="spray-pill spray-pill-create" data-key="__create">+ Create</button>`;
    el.querySelectorAll(".spray-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.key === "__create") { switchTab("sources"); openCreateFlow(); return; }
        if (btn.dataset.key !== activeSprayKey) setActiveSpray(btn.dataset.key);
      });
    });
  }

  // Resolves the items to show in Read based on the active toggle
  // selection. "all" is the full curated wire (today's default). Any
  // other key is a Spray slug — fetched via the existing single-mix
  // endpoint and using its live `items`. Falls back to "all" (and
  // resets the toggle) if the selected Spray no longer exists or went
  // private out from under the reader.
  async function fetchReadItems() {
    if (activeSprayKey === "all") return api("/api/dispatches");
    try {
      const mix = await api(`/api/mixes/${encodeURIComponent(activeSprayKey)}`);
      return Array.isArray(mix.items) ? mix.items : [];
    } catch (e) {
      activeSprayKey = "all";
      localStorage.setItem(ACTIVE_SPRAY_KEY, "all");
      return api("/api/dispatches");
    }
  }

  async function renderRead() {
    const main = document.getElementById("main");
    renderSprayToggle();
    main.innerHTML = stateBlock({ title: "PULLING TRANSMISSION", body: "Fetching latest dispatches...", spin: true });
    try {
      const [items, trendingLinks] = await Promise.all([
        fetchReadItems(),
        getTrendingLinks(),
      ]);
      if (!Array.isArray(items) || items.length === 0) {
        main.innerHTML = stateBlock({ glyph: "∅", title: "NO SIGNAL", body: "No dispatches available right now." });
        return;
      }
      const shown = items
        .slice()
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 60);

      if (getLayoutMode() === "desktop") {
        renderReadDesktop(shown, trendingLinks);
      } else {
        main.innerHTML = shown.map((d, i) => renderDispatchCard(d, trendingLinks.has(d.link), i === 0)).join("");
        main.querySelectorAll(".buzz-badge").forEach(btn => {
          btn.addEventListener("click", (e) => { e.preventDefault(); switchTab("buzz"); });
        });
      }

      const needsLiveThumb = getReadDisplay() === "headlines"
        ? []
        : shown.filter(d => !d.image_url && typeof d.id === "number").map(d => d.id);
      loadThumbnails(needsLiveThumb);
      loadPaywallStatus(shown.filter(d => typeof d.id !== "undefined").map(d => d.id));
    } catch (e) {
      main.innerHTML = stateBlock({ glyph: "!", title: "TRANSMISSION FAILED", body: e.message || "Could not reach the wire." });
    }
  }

  // ---------------------------------------------------------------
  // Desktop reader: left pane shows the currently selected story
  // full-size (image, headline, excerpt, "More" expands the actual
  // article inline via iframe); right pane is the feed you pick the
  // next story from, in either RSS (headlines) or post/social style
  // per the View menu. No "top story"/"latest" badge — the pane just
  // shows whatever's selected.
  // ---------------------------------------------------------------
  function renderReadDesktop(shown, trendingLinks) {
    const main = document.getElementById("main");
    main.classList.add("read-layout");
    if (!selectedDispatch || !shown.some(d => d.id === selectedDispatch.id)) {
      selectedDispatch = shown[0];
    }
    main.innerHTML = `
      <div class="reader-pane" id="readerPane"></div>
      <div class="reader-feed" id="readerFeed"></div>`;
    renderReaderPane(selectedDispatch, trendingLinks.has(selectedDispatch.link));
    renderReaderFeed(shown, trendingLinks);
  }

  function renderReaderPane(d, isTrending) {
    const pane = document.getElementById("readerPane");
    if (!pane || !d) return;
    const excerpt = (d.excerpt || "").trim();
    const title = d.title || d.headline || "";
    // No stored image and (as far as we know yet) no article to extract —
    // rather than leave dead image space, treat this like a headline-only
    // card: bigger title, no broken/empty media slot. If Reader Mode later
    // succeeds and returns real content, that swap happens independently
    // in the More-button handler below and isn't affected by this.
    const noImage = !d.image_url;
    pane.innerHTML = `
      ${d.image_url ? `<img class="reader-image" src="${escapeHtml(d.image_url)}" alt="" loading="lazy">` : ""}
      <div class="reader-body${noImage ? " reader-body-textonly" : ""}">
        <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</div>
        <h2 class="reader-title${noImage ? " reader-title-large" : ""}">${escapeHtml(title)}</h2>
        ${excerpt ? `<p class="reader-excerpt">${escapeHtml(excerpt)}</p>` : ""}
        <div class="reader-actions">
          ${d.link ? `<a class="btn primary reader-open-link" href="${escapeHtml(d.link)}" target="_blank" rel="noopener">Open original ↗</a>
          <button class="btn" id="readerMoreBtn">Try reader view</button>` : ""}
        </div>
        ${isTrending ? `<button class="buzz-badge">🔥 Trending on Bluesky — see Buzz</button>` : ""}
        <div class="reader-frame-wrap" id="readerFrameWrap" hidden></div>
      </div>`;
    const moreBtn = document.getElementById("readerMoreBtn");
    if (moreBtn) {
      moreBtn.addEventListener("click", async () => {
        const wrap = document.getElementById("readerFrameWrap");
        if (!wrap || !d.link) return;
        wrap.hidden = false;
        wrap.innerHTML = `<div class="reader-article-loading">${stateBlock({ title: "PULLING THE FULL PIECE", body: "Fetching a clean, readable version...", spin: true })}</div>`;
        moreBtn.disabled = true;
        try {
          const article = await api(`/api/read?url=${encodeURIComponent(d.link)}`);
          wrap.innerHTML = `
            <article class="reader-article">
              ${article.byline ? `<div class="reader-article-byline">${escapeHtml(article.byline)}</div>` : ""}
              ${article.html}
            </article>
            <div class="reader-frame-note">Reader view, extracted from the source page — <a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">open the original ↗</a></div>`;
          moreBtn.remove();
        } catch (e) {
          wrap.innerHTML = `
            <div class="reader-article-error">
              Couldn't pull a clean readable version of this one — <a href="${escapeHtml(d.link)}" target="_blank" rel="noopener">open the original directly ↗</a>.
            </div>`;
          moreBtn.disabled = false;
        }
      });
    }
    const buzzBtn = pane.querySelector(".buzz-badge");
    if (buzzBtn) buzzBtn.addEventListener("click", (e) => { e.preventDefault(); switchTab("buzz"); });
    if (typeof d.id !== "undefined") {
      if (d.id in paywallStatusMap) applyPaywallBadge(d.id, paywallStatusMap[d.id]);
      else loadPaywallStatus([d.id]);
    }
  }

  function renderReaderFeed(shown, trendingLinks) {
    const feed = document.getElementById("readerFeed");
    if (!feed) return;
    const headlinesOnly = getReadDisplay() === "headlines";
    feed.innerHTML = shown.map(d => {
      const active = selectedDispatch && d.id === selectedDispatch.id;
      const title = d.title || d.headline || "";
      const idAttr = escapeHtml(String(d.id));
      if (headlinesOnly) {
        return `
          <button class="feed-item feed-item-rss${active ? " active" : ""}" data-id="${idAttr}">
            <span class="feed-item-title">${escapeHtml(title)}</span>
            <span class="feed-item-meta"><span>${escapeHtml(d.outlet || d.source || "")}</span><span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</span>
          </button>`;
      }
      const excerpt = (d.excerpt || "").trim().slice(0, 140);
      const hasImage = !!d.image_url;
      return `
        <button class="feed-item feed-item-post${active ? " active" : ""}" data-id="${idAttr}">
          <img class="feed-item-thumb${hasImage ? " loaded" : ""}" id="thumb-${d.id}" alt=""
            ${hasImage ? `src="${escapeHtml(d.image_url)}"` : ""} loading="lazy"
            onerror="this.classList.remove('loaded')">
          <span class="feed-item-text">
            <span class="feed-item-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</span>
            <span class="feed-item-title">${escapeHtml(title)}</span>
            ${excerpt ? `<span class="feed-item-excerpt">${escapeHtml(excerpt)}</span>` : ""}
          </span>
        </button>`;
    }).join("");
    feed.querySelectorAll(".feed-item").forEach(btn => {
      btn.addEventListener("click", () => {
        const d = shown.find(x => String(x.id) === btn.dataset.id);
        if (!d) return;
        selectedDispatch = d;
        renderReaderPane(d, trendingLinks.has(d.link));
        feed.querySelectorAll(".feed-item").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
  }

  // Trending-on-Bluesky link set, used to badge Read-tab cards. Fails
  // soft to an empty set — Bluesky being unreachable should never break
  // the Read tab, it just means no badges show.
  async function getTrendingLinks() {
    try {
      const posts = await api("/api/nerve-center/bluesky");
      const set = new Set();
      (Array.isArray(posts) ? posts : []).forEach(p => { if (p.hasLink && p.link) set.add(p.link); });
      return set;
    } catch (e) {
      return new Set();
    }
  }

  function renderDispatchCard(d, isTrending, featured) {
    const headlinesOnly = getReadDisplay() === "headlines";
    const excerpt = headlinesOnly ? "" : (d.excerpt || "").trim().slice(0, 280);
    const hasImage = !headlinesOnly && !!d.image_url;
    const title = d.title || d.headline || "";
    const thumb = headlinesOnly ? "" : `<img class="card-thumb${hasImage ? " loaded" : ""}" id="thumb-${d.id}" alt=""
        ${hasImage ? `src="${escapeHtml(d.image_url)}"` : ""} loading="lazy"
        onerror="this.classList.remove('loaded')">`;

    if (featured) {
      return `
        <div class="card card-featured${headlinesOnly ? " card-headlines-only" : ""}">
          <a class="card-link" href="${escapeHtml(d.link || "#")}" target="_blank" rel="noopener">
            ${headlinesOnly ? "" : `<div class="card-featured-media">${thumb}</div>`}
            <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</div>
            <div class="card-title">${escapeHtml(title)}</div>
            ${excerpt ? `<div class="card-excerpt">${escapeHtml(excerpt)}</div>` : ""}
          </a>
          ${isTrending ? `<button class="buzz-badge">🔥 Trending on Bluesky — see Buzz</button>` : ""}
        </div>`;
    }

    if (headlinesOnly) {
      return `
        <div class="card card-headlines-only">
          <a class="card-link" href="${escapeHtml(d.link || "#")}" target="_blank" rel="noopener">
            <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</div>
            <div class="card-title">${escapeHtml(title)}</div>
          </a>
          ${isTrending ? `<button class="buzz-badge">🔥 Trending on Bluesky — see Buzz</button>` : ""}
        </div>`;
    }

    return `
      <div class="card">
        <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</div>
        <a class="card-link" href="${escapeHtml(d.link || "#")}" target="_blank" rel="noopener">
          <div class="card-body">
            <div class="card-text">
              <div class="card-title">${escapeHtml(title)}</div>
              ${excerpt ? `<div class="card-excerpt">${escapeHtml(excerpt)}</div>` : ""}
            </div>
            ${thumb}
          </div>
        </a>
        ${isTrending ? `<button class="buzz-badge">🔥 Trending on Bluesky — see Buzz</button>` : ""}
      </div>`;
  }

  // Fetches thumbnails in batches of 20 (the endpoint's own cap) and pops
  // each image in as it resolves. Only called for dispatches that had no
  // stored image_url to begin with. Fails soft per-item — a dispatch with
  // no og:image, or a failed fetch, just leaves that card text-only.
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
  // SOURCES — adjust your reading pane / source tiers, manage your
  // Read-tab Spray bar, and (via "+ New Spray") the guided Create flow.
  // Maps to /api/sources, /api/my/spray-bar, /api/mixes,
  // /api/my/custom-sources, /api/spray-suggestions.
  // ---------------------------------------------------------------
  let sourcesRegistryCache = null; // [{outlet, feed_url, ...}] — fetched once, reused by both the registry list and Create's add-a-source matching
  let createFlowState = null; // null = not in Create mode

  async function renderSources() {
    if (createFlowState) return renderCreateFlow();

    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "LOADING SOURCE LIST", body: "Querying the registry...", spin: true });
    try {
      const [sources, bar] = await Promise.all([
        sourcesRegistryCache || api("/api/sources"),
        loadSprayBar(),
      ]);
      // Sources is for building Sprays out of Organizations — Individuals (Bluesky-only
      // people) don't produce dispatch items on their own and belong to Buzz, not here.
      // Filter on feed_type, not feed_url presence — an Organization can have no RSS
      // (e.g. Degenerate Art, YouTube-only) and still belong here.
      sourcesRegistryCache = (Array.isArray(sources) ? sources : []).filter(s => s.feed_type !== "journalist");

      const orgSources = sourcesRegistryCache;

      let html = `
        <div class="sources-intro">
          <div class="sources-intro-title">Improve your sources.</div>
          <div class="sources-intro-sub">One at a time, or all at once — pick or start a Spray.</div>
        </div>`;
      if (currentUser) {
        html += `<div class="section-label">YOUR SPRAYS</div>` + renderYourSpraysSection(bar);
      } else {
        html += `<div class="card"><div class="card-title" style="margin-bottom:8px;">Sign in (on the You tab) to save and organize your own Sprays.</div></div>`;
      }
      html += `<button class="btn primary" id="newSprayBtn" style="width:100%; margin:14px 0;">+ New Spray</button>`;

      if (orgSources.length === 0) {
        html += stateBlock({ glyph: "∅", title: "NO SOURCES", body: "Nothing in the registry yet." });
      } else {
        html += `<div class="section-label">ALL SOURCES (${orgSources.length})</div>` + orgSources.map(s => `
          <div class="card">
            <div class="card-meta"><span>ORGANIZATION</span></div>
            <div class="card-title">${escapeHtml(s.outlet || s.name || "")}</div>
          </div>`).join("");
      }
      main.innerHTML = html;

      document.getElementById("newSprayBtn").addEventListener("click", openCreateFlow);
      wireYourSpraysSection();
    } catch (e) {
      main.innerHTML = stateBlock({ glyph: "!", title: "REGISTRY UNREACHABLE", body: e.message || "Could not load sources." });
    }
  }

  // ----- "Your Sprays" bar editor -----

  let newsPickerOpen = false;

  function renderYourSpraysSection(bar) {
    const newsRow = `
      <div class="card" style="padding:12px;">
        <div class="spray-bar-row" style="padding:0;">
          <span class="spray-bar-name">📰 News: ${escapeHtml(sprayDisplayName(bar.news.slug, bar.news.name) || "SOURCE! News")}</span>
          <button class="spray-bar-btn" id="changeNewsBtn">${newsPickerOpen ? "Cancel" : "Change"}</button>
        </div>
        ${newsPickerOpen ? `
          <div style="margin-top:10px;">
            <input class="create-flow-input" id="newsPickerSearch" placeholder="Search public Sprays by name...">
            <div id="newsPickerResults" style="margin-top:8px;"></div>
          </div>` : ""}
      </div>`;

    const barRows = bar.sprays.length === 0
      ? `<div class="card"><div class="card-meta">Nothing added to your Read toggle yet — add one when you create a Spray, or from any Spray's page.</div></div>`
      : `<div class="card" style="padding:0;">` + bar.sprays.map((s, i) => `
        <div class="spray-bar-row${i > 0 ? " " : ""}" style="${i > 0 ? "border-top:1px solid var(--line);" : ""}" data-slug="${escapeHtml(s.slug)}">
          <span class="spray-bar-name">${escapeHtml(s.name)}</span>
          <button class="spray-bar-btn" data-action="up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="spray-bar-btn" data-action="down" ${i === bar.sprays.length - 1 ? "disabled" : ""}>↓</button>
          <button class="spray-bar-btn remove" data-action="remove">×</button>
        </div>`).join("") + `</div>`;

    return newsRow + barRows;
  }

  function wireYourSpraysSection() {
    const changeBtn = document.getElementById("changeNewsBtn");
    if (changeBtn) {
      changeBtn.addEventListener("click", () => { newsPickerOpen = !newsPickerOpen; renderSources(); });
    }
    const search = document.getElementById("newsPickerSearch");
    if (search) {
      search.addEventListener("input", debounce(() => runNewsPickerSearch(search.value), 250));
      runNewsPickerSearch("");
    }

    document.querySelectorAll(".spray-bar-row[data-slug]").forEach(row => {
      const slug = row.dataset.slug;
      row.querySelectorAll(".spray-bar-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const action = btn.dataset.action;
          if (action === "remove") {
            await api(`/api/my/spray-bar/${encodeURIComponent(slug)}`, { method: "DELETE" });
            await loadSprayBar(true);
            renderSources();
            return;
          }
          if (action === "up" || action === "down") {
            const slugs = sprayBarData.sprays.map(s => s.slug);
            const idx = slugs.indexOf(slug);
            const swapWith = action === "up" ? idx - 1 : idx + 1;
            if (swapWith < 0 || swapWith >= slugs.length) return;
            [slugs[idx], slugs[swapWith]] = [slugs[swapWith], slugs[idx]];
            await api("/api/my/spray-bar", { method: "POST", body: JSON.stringify({ sprays: slugs }) });
            await loadSprayBar(true);
            renderSources();
          }
        });
      });
    });
  }

  async function runNewsPickerSearch(query) {
    const results = document.getElementById("newsPickerResults");
    if (!results) return;
    try {
      const directory = await api("/api/mixes");
      const q = query.trim().toLowerCase();
      const matches = (Array.isArray(directory) ? directory : [])
        .filter(m => !q || (m.name || "").toLowerCase().includes(q))
        .slice(0, 8);
      results.innerHTML = matches.length === 0
        ? `<div class="card-meta">No Sprays match.</div>`
        : matches.map(m => `<button class="btn" style="width:100%; margin-bottom:6px; text-align:left;" data-slug="${escapeHtml(m.slug)}">${escapeHtml(m.name)}</button>`).join("");
      results.querySelectorAll("[data-slug]").forEach(btn => {
        btn.addEventListener("click", async () => {
          await api("/api/my/news-pref", { method: "POST", body: JSON.stringify({ slug: btn.dataset.slug }) });
          newsPickerOpen = false;
          await loadSprayBar(true);
          renderSources();
          toast("News updated.");
        });
      });
    } catch (e) { /* fail soft — leave results untouched */ }
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ----- Guided Create flow: name -> add one -> suggest 5 -> repeat -----

  function openCreateFlow() {
    if (!currentUser) { toast("Sign in on the You tab to create a Spray."); return; }
    createFlowState = { name: "", picked: [], suggestions: [], loadingSuggestions: false, addToBar: true, isPublic: true };
    renderSources();
  }

  function closeCreateFlow() {
    createFlowState = null;
    renderSources();
  }

  async function refreshSuggestions() {
    const outletNames = createFlowState.picked.filter(p => p.source_type === "admin_outlet").map(p => p.outlet);
    createFlowState.loadingSuggestions = true;
    renderCreateFlow();
    try {
      const params = outletNames.length ? `?sources=${encodeURIComponent(outletNames.join(","))}&limit=5` : "?limit=5";
      const suggestions = await api(`/api/spray-suggestions${params}`);
      const pickedNames = new Set(createFlowState.picked.map(p => p.outlet).filter(Boolean));
      createFlowState.suggestions = (Array.isArray(suggestions) ? suggestions : []).filter(s => !pickedNames.has(s.outlet));
    } catch (e) {
      createFlowState.suggestions = [];
    }
    createFlowState.loadingSuggestions = false;
    renderCreateFlow();
  }

  function addPicked(entry) {
    if (createFlowState.picked.some(p => (p.outlet && p.outlet === entry.outlet) || (p.custom_source_id && p.custom_source_id === entry.custom_source_id))) return;
    createFlowState.picked.push(entry);
  }

  function renderCreateFlow() {
    const main = document.getElementById("main");
    const state = createFlowState;
    const pickedChips = state.picked.map((p, i) => `
      <span class="outlet-chip" style="background:var(--surface); padding:5px 10px; border-radius:999px; gap:6px; display:inline-flex; align-items:center;">
        ${escapeHtml(p.label)}
        <button class="spray-bar-btn remove" data-remove-idx="${i}" style="padding:0; font-size:14px;">×</button>
      </span>`).join("");

    const suggestionsHtml = state.loadingSuggestions
      ? `<div class="card-meta">Finding related sources...</div>`
      : state.suggestions.length === 0
        ? `<div class="card-meta">No more suggestions right now.</div>`
        : state.suggestions.map((s, i) => `
          <div class="create-flow-suggestion">
            <input type="checkbox" id="sugg-${i}" data-outlet="${escapeHtml(s.outlet)}" data-section="${escapeHtml(s.section || "")}">
            <label for="sugg-${i}">${escapeHtml(s.outlet)}${s.section ? ` <span class="card-meta" style="display:inline;">— ${escapeHtml(s.section)}</span>` : ""}</label>
          </div>`).join("");

    main.innerHTML = `
      <button class="btn" id="cfBack" style="margin-bottom:14px;">‹ Back</button>

      <div class="create-flow-step">
        <div class="create-flow-label">Name your Spray</div>
        <input class="create-flow-input" id="cfName" placeholder="e.g. Movies, AI, Local Politics" value="${escapeHtml(state.name)}">
      </div>

      <div class="create-flow-step">
        <div class="create-flow-label">Add a source</div>
        <input class="create-flow-input" id="cfAddSource" list="cfSourceList" placeholder="Type an outlet name, or paste an RSS URL">
        <datalist id="cfSourceList">${(sourcesRegistryCache || []).map(s => `<option value="${escapeHtml(s.outlet)}">`).join("")}</datalist>
      </div>

      ${state.picked.length > 0 ? `<div class="create-flow-picked">${pickedChips}</div>` : ""}

      ${state.picked.length > 0 ? `
        <div class="create-flow-step">
          <div class="create-flow-label">You might also like</div>
          ${suggestionsHtml}
          <div style="display:flex; gap:8px; margin-top:10px;">
            <button class="btn primary" id="cfAddChecked" style="flex:1;">Add checked</button>
            <button class="btn" id="cfMoreSuggestions" style="flex:1;">More suggestions</button>
          </div>
        </div>` : ""}

      <div class="create-flow-checkbox-row">
        <input type="checkbox" id="cfAddToBar" ${state.addToBar ? "checked" : ""}>
        <label for="cfAddToBar">Add to my Read toggle</label>
      </div>
      <div class="create-flow-checkbox-row">
        <input type="checkbox" id="cfPublic" ${state.isPublic ? "checked" : ""}>
        <label for="cfPublic">Public — visible in the Spray directory</label>
      </div>

      <button class="btn primary" id="cfSave" style="width:100%; margin-top:6px;">Save Spray</button>
    `;

    document.getElementById("cfBack").addEventListener("click", closeCreateFlow);
    document.getElementById("cfName").addEventListener("input", (e) => { state.name = e.target.value; });
    document.getElementById("cfAddToBar").addEventListener("change", (e) => { state.addToBar = e.target.checked; });
    document.getElementById("cfPublic").addEventListener("change", (e) => { state.isPublic = e.target.checked; });

    main.querySelectorAll("[data-remove-idx]").forEach(btn => {
      btn.addEventListener("click", () => {
        state.picked.splice(Number(btn.dataset.removeIdx), 1);
        refreshSuggestions();
      });
    });

    const addInput = document.getElementById("cfAddSource");
    addInput.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      await addSourceFromInput(addInput.value.trim());
      addInput.value = "";
    });

    const addChecked = document.getElementById("cfAddChecked");
    if (addChecked) {
      addChecked.addEventListener("click", () => {
        main.querySelectorAll(".create-flow-suggestion input:checked").forEach(cb => {
          addPicked({ source_type: "admin_outlet", outlet: cb.dataset.outlet, label: cb.dataset.outlet });
        });
        refreshSuggestions();
      });
    }
    const moreBtn = document.getElementById("cfMoreSuggestions");
    if (moreBtn) moreBtn.addEventListener("click", refreshSuggestions);

    document.getElementById("cfSave").addEventListener("click", saveCreateFlow);
  }

  async function addSourceFromInput(value) {
    if (!value) return;
    const state = createFlowState;
    if (/^https?:\/\//i.test(value)) {
      try {
        const created = await api("/api/my/custom-sources", { method: "POST", body: JSON.stringify({ feed_url: value }) });
        addPicked({ source_type: "custom", custom_source_id: created.id, label: created.name || value });
        toast("Source added.");
      } catch (e) {
        toast(e.message || "Couldn't add that RSS URL.");
        return;
      }
    } else {
      const match = (sourcesRegistryCache || []).find(s => (s.outlet || "").toLowerCase() === value.toLowerCase());
      if (!match) { toast("No source matches that name — try picking from the list, or paste a full RSS URL."); return; }
      addPicked({ source_type: "admin_outlet", outlet: match.outlet, label: match.outlet });
    }
    refreshSuggestions();
  }

  async function saveCreateFlow() {
    const state = createFlowState;
    const name = state.name.trim();
    if (!name) { toast("Give your Spray a name first."); return; }
    if (state.picked.length === 0) { toast("Add at least one source."); return; }

    try {
      const sources = state.picked.map(p => p.source_type === "admin_outlet"
        ? { source_type: "admin_outlet", outlet: p.outlet }
        : { source_type: "custom", custom_source_id: p.custom_source_id });
      const mix = await api("/api/mixes", { method: "POST", body: JSON.stringify({ name, is_public: state.isPublic, sources }) });
      if (state.addToBar) {
        await api("/api/my/spray-bar/add", { method: "POST", body: JSON.stringify({ slug: mix.slug }) });
      }
      await loadSprayBar(true);
      closeCreateFlow();
      toast(`"${name}" created.`);
    } catch (e) {
      toast(e.message || "Couldn't save that Spray.");
    }
  }

  // ---------------------------------------------------------------
  // BUZZ — organized around big stories/topics. Actions (Rogan's
  // List) up top, then Trending on Bluesky. Maps to the existing
  // Nerve Center panels + the Actions SIMPLE_FEED.
  // ---------------------------------------------------------------
  async function renderBuzz() {
    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "SCANNING CHATTER", body: "Pulling the signal off Bluesky...", spin: true });
    const [actionsResult, postsResult] = await Promise.allSettled([
      api("/api/actions-feed"),
      api("/api/nerve-center/bluesky"),
    ]);

    const actions = actionsResult.status === "fulfilled" && Array.isArray(actionsResult.value) ? actionsResult.value : [];
    const posts = postsResult.status === "fulfilled" && Array.isArray(postsResult.value) ? postsResult.value : [];

    if (actions.length === 0 && posts.length === 0) {
      main.innerHTML = stateBlock({ glyph: "∅", title: "QUIET RIGHT NOW", body: "No chatter picked up in the current window." });
      return;
    }

    let html = "";
    if (actions.length > 0) {
      html += `<div class="section-label">WHAT YOU CAN DO</div>` + renderActionsSection(actions);
    }
    if (posts.length > 0) {
      html += `<div class="section-label">TRENDING ON BLUESKY</div>` + posts.slice(0, 40).map(renderBluePost).join("");
    }
    main.innerHTML = html;
  }

  function renderActionsSection(actions) {
    const [top, ...rest] = actions;
    let html = "";
    if (top) {
      const excerpt = (top.excerpt || "").trim();
      html += `
        <div class="card">
          <a class="card-link" href="${escapeHtml(top.link || "#")}" target="_blank" rel="noopener">
            <div class="card-body">
              <div class="card-text">
                <div class="card-title">${escapeHtml(top.title || "")}</div>
                ${excerpt ? `<div class="card-excerpt">${escapeHtml(excerpt.slice(0, 160))}</div>` : ""}
              </div>
              ${top.image ? `<img class="card-thumb loaded" src="${escapeHtml(top.image)}" alt="" loading="lazy" onerror="this.classList.remove('loaded')">` : ""}
            </div>
          </a>
        </div>`;
    }
    if (rest.length > 0) {
      html += `<div class="card">` + rest.map(a => `
        <a class="card-link plain-row" href="${escapeHtml(a.link || "#")}" target="_blank" rel="noopener">${escapeHtml(a.title || "")}</a>
      `).join("") + `</div>`;
    }
    return html;
  }

  function renderBluePost(p) {
    return `
      <a class="card card-link" href="${escapeHtml(p.link || p.postUrl || "#")}" target="_blank" rel="noopener" style="display:block;">
        <div class="card-meta"><span>${escapeHtml(p.author || p.outlet || "")}</span><span>${relTime(p.indexedAt || p.date)}</span></div>
        <div class="card-title">${escapeHtml(p.text || p.title || "")}</div>
      </a>`;
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
            style="width:100%; padding:9px; background:var(--bg); border:1px solid var(--line); color:var(--ink); font-family:var(--body); font-size:14px; margin-bottom:8px; border-radius:8px;">
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
      sprayBarData = null;
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
      <div class="ob-wordmark">SOURCE!</div>
      <div class="ob-rule"></div>
      <h1>News first, from the best sources. Escape the billionaires' algorithm.</h1>
      <p>Start with our News Spray, edit it, or pick your own.</p>
      <button class="ob-btn" id="obStart">Start with our News Spray
        <span class="ob-btn-sub">Best in the World — live, unfiltered, always current</span></button>
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
    document.body.dataset.layout = getLayoutMode();
    renderLayoutReview();
    renderViewMenu();
    renderTabBar();

    document.addEventListener("click", () => {
      const list = document.getElementById("viewMenuList");
      const btn = document.getElementById("viewMenuBtn");
      if (list && !list.hidden) {
        list.hidden = true;
        if (btn) btn.setAttribute("aria-expanded", "false");
      }
    });

    const refreshBtn = document.getElementById("refreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.classList.add("spinning");
        try {
          await renderActiveTab();
          toast("Refreshed");
        } catch (e) {
          toast("Couldn't refresh — try again.");
        } finally {
          refreshBtn.classList.remove("spinning");
        }
      });
    }

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
