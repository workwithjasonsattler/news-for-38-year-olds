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

  async function renderRead() {
    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "PULLING TRANSMISSION", body: "Fetching latest dispatches...", spin: true });
    try {
      const [items, trendingLinks] = await Promise.all([
        api("/api/dispatches"),
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
    pane.innerHTML = `
      ${d.image_url ? `<img class="reader-image" src="${escapeHtml(d.image_url)}" alt="" loading="lazy">` : ""}
      <div class="reader-body">
        <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span></div>
        <h2 class="reader-title">${escapeHtml(title)}</h2>
        ${excerpt ? `<p class="reader-excerpt">${escapeHtml(excerpt)}</p>` : ""}
        <div class="reader-actions">
          ${d.link ? `<button class="btn primary" id="readerMoreBtn">More →</button>
          <a class="reader-open-link" href="${escapeHtml(d.link)}" target="_blank" rel="noopener">Open original ↗</a>` : ""}
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
            <span class="feed-item-meta"><span>${escapeHtml(d.outlet || d.source || "")}</span><span>${relTime(d.date)}</span></span>
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
            <span class="feed-item-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span></span>
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
            <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span></div>
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
            <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span></div>
            <div class="card-title">${escapeHtml(title)}</div>
          </a>
          ${isTrending ? `<button class="buzz-badge">🔥 Trending on Bluesky — see Buzz</button>` : ""}
        </div>`;
    }

    return `
      <div class="card">
        <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span></div>
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
