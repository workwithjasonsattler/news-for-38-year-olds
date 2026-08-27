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
    renderViewMenu();
    renderActiveTab();
    renderDesktopSidePanel();
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
    if (activeTab === "buzz") renderBuzz();
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
        <button class="view-menu-item${mode === "scroll" ? " active" : ""}" data-action="scroll">Scroll</button>
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

  // Per-article tip/subscribe support link. Tip beats subscribe — only
  // one ever shown, since a tip_url usually implies a subscribe path
  // exists too and showing both is redundant (same priority rule
  // already used by the homepage Sources box and the Bluesky headline
  // bot's post format). Returns null when a dispatch has neither, so
  // callers can skip rendering entirely rather than showing an empty/
  // disabled state.
  function tipSubscribeInfo(d) {
    const outlet = (d.outlet || d.source || "").trim();
    if (d.tip_url) return { url: d.tip_url, label: outlet ? `Tip ${outlet}` : "Tip the reporter" };
    if (d.subscribe_url) return { url: d.subscribe_url, label: outlet ? `Subscribe to ${outlet}` : "Subscribe" };
    return null;
  }

  // Block-style badge for card lists (mobile cards, matches the visual
  // language of the existing .buzz-badge trending pill).
  function tipSubscribeBadge(d) {
    const info = tipSubscribeInfo(d);
    if (!info) return "";
    return `<a class="tip-badge" href="${escapeHtml(info.url)}" target="_blank" rel="noopener">💛 ${escapeHtml(info.label)}</a>`;
  }

  // Resolves a dispatch back to a source a Spray can actually hold. Custom
  // (reader-private) items get their custom_source_id decoded straight out
  // of the synthetic dispatch id built in GET /api/dispatches and
  // resolveMixSources() — no backend/dispatch-shape change needed, both
  // already encode it as "custom-<id>-..." / "mix-custom-<id>-...". Every
  // other dispatch (curated outlets, videos — video creators are stored as
  // normal outlet rows with a youtube_channel_id, so this covers Best of
  // YouTube too) maps off its plain outlet name. Returns null when neither
  // shape matches, so callers can skip rendering the control entirely.
  function sprayableSource(d) {
    const customMatch = /^(?:mix-)?custom-(\d+)-/.exec(d.id || "");
    if (customMatch) {
      const label = (d.outlet || d.source || "").trim() || "this source";
      return { source_type: "custom", custom_source_id: Number(customMatch[1]), label };
    }
    const outlet = (d.outlet || d.source || "").trim();
    if (outlet) return { source_type: "admin_outlet", outlet, label: outlet };
    return null;
  }

  // "+ Spray" control — a sibling element next to the tip/subscribe badge,
  // not nested inside the card's outbound <a>, same pattern already used
  // for the trending badge. Renders nothing when the dispatch can't be
  // mapped to a real source (sprayableSource returns null).
  //
  // When the reader is currently viewing exactly ONE of their own,
  // non-official Sprays (see quickRemoveContext below), every item shown
  // is — by construction, since it was fetched FROM that Spray's own
  // source list — already a member of it. In that context the button
  // flips to a one-tap "− Remove" instead of opening the picker, so
  // removing is exactly as fast as adding was: one click, no dialog.
  function sprayAddButton(d) {
    const src = sprayableSource(d);
    if (!src) return "";
    if (quickRemoveContext) {
      return `<button class="spray-add-btn spray-remove-btn" data-spray-source='${escapeHtml(JSON.stringify(src))}' data-remove-slug="${escapeHtml(quickRemoveContext.slug)}" title="Remove from ${escapeHtml(quickRemoveContext.name)}">− ${escapeHtml(quickRemoveContext.name)}</button>`;
    }
    return `<button class="spray-add-btn" data-spray-source='${escapeHtml(JSON.stringify(src))}' title="Add to a Spray">+ Spray</button>`;
  }

  // "Save" control — a lightweight personal bookmark, distinct from
  // Sprays (a Spray is a collection of SOURCES; a save is a single ITEM).
  // Snapshotted at click time (title/excerpt/image/outlet frozen into the
  // payload right here) since the reader may not still be looking at this
  // dispatch by the time they check My Saves later, and the underlying
  // wire item can age out entirely. Renders nothing without a real link —
  // there's nothing to save an item as a bookmark to point at otherwise.
  function saveButton(d) {
    if (!d.link) return "";
    const payload = {
      link: d.link,
      title: d.title || d.headline || "",
      excerpt: (d.excerpt || "").trim().slice(0, 500) || null,
      image_url: d.image_url || null,
      outlet: (d.outlet || d.source || "").trim() || null,
      published_at: d.date || null,
    };
    return `<button class="save-btn" data-save-payload='${escapeHtml(JSON.stringify(payload))}' title="Save for later">☆ Save</button>`;
  }

  // Wires every ".save-btn" inside `root` — shared by both card grids and
  // the reader pane so the click/toast/disabled behavior never drifts
  // between the two surfaces. Flips to a plain "★ Saved" label on success
  // (including the already-saved case — a reader tapping Save twice
  // should see a friendly confirm, not an error) rather than being
  // removed, so the reader gets visible confirmation without a re-render.
  function wireSaveButtons(root) {
    root.querySelectorAll(".save-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!currentUser) { toast("Sign in to save items"); switchTab("you"); return; }
        btn.disabled = true;
        try {
          const payload = JSON.parse(btn.dataset.savePayload);
          await api("/api/my/saves", { method: "POST", body: JSON.stringify(payload) });
          btn.textContent = "★ Saved";
          btn.classList.add("save-btn-done");
          toast("Saved");
        } catch (e) {
          btn.disabled = false;
          toast(e.message || "Couldn't save that");
        }
      });
    });
  }

  // Removes a source from the Spray the reader is currently viewing, with
  // no picker round-trip — the direct counterpart to sprayAddButton's
  // quick-remove state above. Always re-renders Read on success (via
  // `onSuccess`) rather than pulling just the clicked card, since one
  // outlet/source can back several cards in the same view and a source
  // removal should clear all of them, not just the one that was clicked.
  async function quickRemoveFromActiveSpray(source, slug, btnEl, onSuccess) {
    if (btnEl) btnEl.disabled = true;
    try {
      const body = source.source_type === "custom"
        ? { source_type: "custom", custom_source_id: source.custom_source_id }
        : { source_type: "admin_outlet", outlet: source.outlet };
      const result = await api(`/api/my/mixes/${encodeURIComponent(slug)}/toggle-source`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (result.added) {
        // Unexpected — it should have been present since it came from
        // this Spray's own list. Toggle it back off rather than leave a
        // silent mismatch between what's shown and what's actually saved.
        await api(`/api/my/mixes/${encodeURIComponent(slug)}/toggle-source`, { method: "POST", body: JSON.stringify(body) });
      }
      toast(`Removed from ${quickRemoveContext ? quickRemoveContext.name : "that Spray"}.`);
      if (onSuccess) onSuccess();
    } catch (e) {
      if (btnEl) btnEl.disabled = false;
      toast(e.message || "Couldn't remove that.");
    }
  }

  // Inline .btn-style link for the reader pane's action row, alongside
  // Open original / Try reader view.
  function tipSubscribeButton(d) {
    const info = tipSubscribeInfo(d);
    if (!info) return "";
    return `<a class="btn tip-btn" href="${escapeHtml(info.url)}" target="_blank" rel="noopener">💛 ${escapeHtml(info.label)}</a>`;
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

  // Set (non-null) only when the reader is viewing exactly ONE of their
  // own, non-official Sprays via the toggle bar — {slug, name}. Read by
  // sprayAddButton() to flip "+ Spray" (open the picker) into a one-tap
  // "− Remove" for every card shown, since everything in view got there
  // BY BEING a member of that Spray. Recomputed each fetchReadItems()
  // call; cleared whenever "All", multiple Sprays, or a built-in slot
  // (__youtube/__bluesky) is active, or the single active Spray isn't
  // one the reader actually owns (e.g. someone else's public Spray).
  let quickRemoveContext = null;

  // Shared official flagship Spray slug — matches server.mjs's
  // OFFICIAL_HEADLINES_SPRAY_SLUG. Used as the "News" fallback for
  // anonymous readers (who can't hit /api/my/spray-bar) and before the
  // signed-in reader's own bar has loaded.
  const OFFICIAL_NEWS_SLUG = "headlines-best-in-the-world";
  const ACTIVE_SPRAY_KEY = "source_active_spray";

  let sprayBarData = null; // { news: {slug,name}, sprays: [{slug,name}] }
  // Multi-select: a reader can view several Sprays combined at once.
  // Stored as a JSON array in localStorage, held as a Set at runtime.
  // "all" is treated as exclusive with everything else — selecting it
  // clears any other picks, and picking anything else drops "all".
  let activeSprayKeys = loadStoredSprayKeys();

  function loadStoredSprayKeys() {
    try {
      const raw = localStorage.getItem(ACTIVE_SPRAY_KEY);
      if (!raw) return new Set(["all"]);
      // Migrate the old single-string format from before multi-select.
      if (raw[0] !== "[") return new Set([raw]);
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) && arr.length ? arr : ["all"]);
    } catch (e) {
      return new Set(["all"]);
    }
  }

  function persistActiveSprayKeys() {
    localStorage.setItem(ACTIVE_SPRAY_KEY, JSON.stringify(Array.from(activeSprayKeys)));
  }

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

  function toggleActiveSpray(key) {
    if (key === "all") {
      activeSprayKeys = new Set(["all"]);
    } else if (activeSprayKeys.has(key)) {
      activeSprayKeys.delete(key);
      if (activeSprayKeys.size === 0) activeSprayKeys.add("all");
    } else {
      activeSprayKeys.delete("all");
      activeSprayKeys.add(key);
    }
    persistActiveSprayKeys();
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
      { key: "__youtube", label: "Best of YouTube" },
      { key: "__bluesky", label: "Best of Bluesky" },
    ].concat(sprayBarData.sprays.map(s => ({ key: s.slug, label: sprayDisplayName(s.slug, s.name) })));
    el.innerHTML = pills.map(p => {
      const active = activeSprayKeys.has(p.key);
      return `
        <button class="spray-pill${active ? " active" : ""}" data-key="${escapeHtml(p.key)}" title="${escapeHtml(p.label)}">
          <span class="spray-pill-label">${escapeHtml(p.label)}</span>${active && p.key !== "all" ? `<span class="spray-pill-x" data-key="${escapeHtml(p.key)}">×</span>` : ""}
        </button>`;
    }).join("") + `<button class="spray-pill spray-pill-create" data-key="__create">+ Create</button>`;
    el.querySelectorAll(".spray-pill-x").forEach(x => {
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleActiveSpray(x.dataset.key);
      });
    });
    el.querySelectorAll(".spray-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.key === "__create") { switchTab("sources"); openCreateFlow(); return; }
        toggleActiveSpray(btn.dataset.key);
      });
    });
  }

  // Populated as a side effect of fetchItemsForSprayKey() whenever it
  // fetches a real Spray (not the built-in __youtube/__bluesky slots) —
  // slug -> {name, is_owner, is_official}. Read by fetchReadItems() to
  // decide whether the single active Spray qualifies for quick-remove.
  const mixMetaCache = new Map();

  async function fetchItemsForSprayKey(key) {
    if (key === "__youtube") {
      const videos = await api("/api/video-feed");
      return (Array.isArray(videos) ? videos : []).map((v, i) => ({
        id: `yt-${i}`,
        title: v.title,
        link: v.url,
        image_url: v.thumbnail,
        outlet: v.channel,
        date: v.published_at,
        excerpt: "",
        is_video: true,
      }));
    }
    if (key === "__bluesky") {
      const posts = await api("/api/nerve-center/bluesky");
      return (Array.isArray(posts) ? posts : []).map((p, i) => ({
        id: `bsky-${i}`,
        title: p.text || "",
        link: p.link || p.blueskyUrl,
        image_url: null,
        outlet: p.outlet,
        date: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        excerpt: "",
      }));
    }
    const mix = await api(`/api/mixes/${encodeURIComponent(key)}`);
    mixMetaCache.set(key, { name: mix.name, is_owner: !!mix.is_owner, is_official: !!mix.is_official });
    return Array.isArray(mix.items) ? mix.items : [];
  }

  // Resolves the items to show in Read based on the active toggle
  // selection(s). "all" is the full curated wire (today's default) and
  // is exclusive with everything else. Any other combination of keys —
  // one or more Spray slugs and/or the built-in "__youtube" slot — is
  // fetched in parallel and merged: deduped by link (so the same story
  // showing up in two selected Sprays doesn't double), sorted newest
  // first. A key that fails (Spray deleted/went private) is silently
  // dropped from the selection rather than breaking the whole view; if
  // every key fails, falls back to "all".
  async function fetchReadItems() {
    if (activeSprayKeys.has("all")) { quickRemoveContext = null; return api("/api/dispatches"); }
    const keys = Array.from(activeSprayKeys);
    const results = await Promise.allSettled(keys.map(fetchItemsForSprayKey));

    const survivingKeys = [];
    let combined = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        survivingKeys.push(keys[i]);
        combined = combined.concat(r.value);
      }
    });

    if (survivingKeys.length === 0) {
      activeSprayKeys = new Set(["all"]);
      persistActiveSprayKeys();
      return api("/api/dispatches");
    }
    if (survivingKeys.length !== keys.length) {
      activeSprayKeys = new Set(survivingKeys);
      persistActiveSprayKeys();
    }

    // Exactly one real (non-built-in) Spray in view, and the reader owns
    // it and it's not the auto-syncing official one (which has no stored
    // sources to toggle) -> quick-remove mode. Anything else (multiple
    // selected, a built-in slot, or a Spray that isn't theirs) reverts
    // every card back to the normal "+ Spray" add flow.
    quickRemoveContext = null;
    if (survivingKeys.length === 1) {
      const meta = mixMetaCache.get(survivingKeys[0]);
      if (meta && meta.is_owner && !meta.is_official) {
        quickRemoveContext = { slug: survivingKeys[0], name: meta.name };
      }
    }

    const seen = new Set();
    const deduped = [];
    for (const d of combined) {
      const dedupeKey = d.link || d.id;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      deduped.push(d);
    }
    deduped.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return deduped;
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
        main.innerHTML = shown.map((d, i) => renderDispatchCard(d, trendingLinks.has(d.link), i === 0, trendingLinks.get(d.link))).join("");
        main.querySelectorAll(".buzz-badge").forEach(btn => {
          btn.addEventListener("click", (e) => { e.preventDefault(); switchTab("buzz"); });
        });
        main.querySelectorAll(".spray-add-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            const source = JSON.parse(btn.dataset.spraySource);
            if (btn.dataset.removeSlug) {
              // Re-render rather than pull just this one card — the same
              // outlet/source could back several cards in view, and a
              // source removal should clear all of them, not just the
              // one that was clicked.
              quickRemoveFromActiveSpray(source, btn.dataset.removeSlug, btn, () => renderRead());
            } else {
              openSprayPicker(source);
            }
          });
        });
        wireSaveButtons(main);
      }

      const needsLiveThumb = getReadDisplay() === "headlines"
        ? []
        : shown.filter(d => !d.image_url && typeof d.id === "number").map(d => d.id);
      loadThumbnails(needsLiveThumb);
      loadPaywallStatus(shown.filter(d => typeof d.id === "number").map(d => d.id));
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
    renderReaderPane(selectedDispatch, trendingLinks.has(selectedDispatch.link), trendingLinks.get(selectedDispatch.link));
    renderReaderFeed(shown, trendingLinks);
  }

  // discussUrl: the matching Bluesky post for this story, if one exists —
  // same Map every other Scroll surface in the app reads from
  // (getTrendingLinks()). Only ever shown as a plain link, never a count.
  function renderReaderPane(d, isTrending, discussUrl) {
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
    // Scroll — the reader pane is the PRIMARY reading surface on Desktop,
    // so this is where Scroll's actual "one story, full-bleed, roomy"
    // identity has to live, not the side rail (which already got its own
    // Scroll treatment as a compact list). Taller image, bigger display
    // type, more breathing room, and the same plain "see the conversation"
    // link the rest of Scroll uses — no counts, ever.
    const scrollMode = getReadDisplay() === "scroll";
    pane.innerHTML = `
      ${d.image_url ? `<img class="reader-image${scrollMode ? " reader-image-scroll" : ""}" src="${escapeHtml(d.image_url)}" alt="" loading="lazy">` : ""}
      <div class="reader-body${noImage ? " reader-body-textonly" : ""}${scrollMode ? " reader-body-scroll" : ""}">
        <div class="card-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</div>
        <h2 class="reader-title${noImage ? " reader-title-large" : ""}${scrollMode ? " reader-title-scroll" : ""}">${escapeHtml(title)}</h2>
        ${excerpt ? `<p class="reader-excerpt${scrollMode ? " reader-excerpt-scroll" : ""}">${escapeHtml(excerpt)}</p>` : ""}
        ${scrollMode && discussUrl ? `<a class="reader-discuss-scroll" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener">See the conversation on Bluesky ↗</a>` : ""}
        <div class="reader-actions">
          ${d.link ? `<a class="btn primary reader-open-link" href="${escapeHtml(d.link)}" target="_blank" rel="noopener">${d.is_video ? "Watch on YouTube ↗" : "Open original ↗"}</a>
          ${d.is_video ? "" : `<button class="btn" id="readerMoreBtn">Try reader view</button>`}` : ""}
          ${tipSubscribeButton(d)}
          ${sprayAddButton(d)}
          ${saveButton(d)}
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
    const sprayBtn = pane.querySelector(".spray-add-btn");
    if (sprayBtn) {
      sprayBtn.addEventListener("click", () => {
        const source = JSON.parse(sprayBtn.dataset.spraySource);
        if (sprayBtn.dataset.removeSlug) {
          // Pane + feed list share one underlying fetch — re-run it so
          // both stay in sync rather than trying to patch two DOM trees.
          quickRemoveFromActiveSpray(source, sprayBtn.dataset.removeSlug, sprayBtn, () => renderRead());
        } else {
          openSprayPicker(source);
        }
      });
    }
    wireSaveButtons(pane);
    if (typeof d.id === "number") {
      if (d.id in paywallStatusMap) applyPaywallBadge(d.id, paywallStatusMap[d.id]);
      else loadPaywallStatus([d.id]);
    }
  }

  function renderReaderFeed(shown, trendingLinks) {
    const feed = document.getElementById("readerFeed");
    if (!feed) return;
    const mode = getReadDisplay();
    const headlinesOnly = mode === "headlines";
    // Scroll — same list, same order, no new fetch. Roomier treatment
    // (bigger thumb, more excerpt, "see the conversation" link when one
    // exists) matching Scroll's card treatment elsewhere in the app —
    // still a compact selectable list, not the full-bleed one-story
    // card, since this is a side rail next to the reader pane, not the
    // primary reading surface. No like/repost/reply counts, same as
    // every other Scroll surface.
    const scrollMode = mode === "scroll";
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
      if (scrollMode) {
        const excerpt = (d.excerpt || "").trim().slice(0, 220);
        const hasImage = !!d.image_url;
        const discussUrl = trendingLinks.get(d.link);
        return `
          <button class="feed-item feed-item-scroll${active ? " active" : ""}" data-id="${idAttr}">
            <img class="feed-item-thumb feed-item-thumb-lg${hasImage ? " loaded" : ""}" id="thumb-${d.id}" alt=""
              ${hasImage ? `src="${escapeHtml(d.image_url)}"` : ""} loading="lazy"
              onerror="this.classList.remove('loaded')">
            <span class="feed-item-text">
              <span class="feed-item-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</span>
              <span class="feed-item-title feed-item-title-lg">${escapeHtml(title)}</span>
              ${excerpt ? `<span class="feed-item-excerpt feed-item-excerpt-lg">${escapeHtml(excerpt)}</span>` : ""}
              ${discussUrl ? `<span class="feed-item-discuss">See the conversation on Bluesky ↗</span>` : ""}
            </span>
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
        renderReaderPane(d, trendingLinks.has(d.link), trendingLinks.get(d.link));
        feed.querySelectorAll(".feed-item").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });
  }

  // Trending-on-Bluesky link set, used to badge Read-tab cards, AND now
  // to power Scroll mode's "join the conversation" link — a Map from the
  // dispatch's own article link to the actual Bluesky post that shared
  // it, so Scroll can point at where people are actually talking about a
  // story without ever showing a like/reply count. Fails soft to an
  // empty Map — Bluesky being unreachable should never break the Read
  // tab, it just means no badges/links show.
  async function getTrendingLinks() {
    try {
      const posts = await api("/api/nerve-center/bluesky");
      const map = new Map();
      (Array.isArray(posts) ? posts : []).forEach(p => { if (p.hasLink && p.link) map.set(p.link, p.blueskyUrl); });
      return map;
    } catch (e) {
      return new Map();
    }
  }

  function renderDispatchCard(d, isTrending, featured, discussUrl) {
    const mode = getReadDisplay();
    const headlinesOnly = mode === "headlines";
    const title = d.title || d.headline || "";

    // Scroll — every card gets the full-bleed, one-story-at-a-time
    // treatment (not just the first item, unlike the older "featured"
    // idea it's built from). Same data, same reverse-chronological
    // order as Digest — this is presentation only, never a reorder.
    // No like/repost/reply counts anywhere in this card, by design —
    // the only nod to "what's being said" is a plain link to the
    // actual Bluesky post when one exists, never a number.
    if (mode === "scroll") {
      const excerpt = (d.excerpt || "").trim().slice(0, 500);
      const hasImage = !!d.image_url;
      return `
        <div class="card card-scroll">
          <a class="card-link" href="${escapeHtml(d.link || "#")}" target="_blank" rel="noopener">
            ${hasImage ? `<div class="card-scroll-media"><img class="card-thumb loaded" id="thumb-${d.id}" src="${escapeHtml(d.image_url)}" alt="" loading="lazy" onerror="this.closest('.card-scroll-media').remove()"></div>` : `<img class="card-thumb" id="thumb-${d.id}" alt="" loading="lazy" onerror="this.remove()" style="display:none;">`}
            <div class="card-scroll-body${hasImage ? "" : " card-scroll-body-textonly"}">
              <div class="card-scroll-meta">${outletChip(d.outlet || d.source)}<span>${relTime(d.date)}</span>${paywallBadgePlaceholder(d.id)}</div>
              <div class="card-scroll-title">${escapeHtml(title)}</div>
              ${excerpt ? `<div class="card-scroll-excerpt">${escapeHtml(excerpt)}</div>` : ""}
            </div>
          </a>
          ${tipSubscribeBadge(d)}${sprayAddButton(d)}${saveButton(d)}
          ${discussUrl ? `<a class="card-scroll-discuss" href="${escapeHtml(discussUrl)}" target="_blank" rel="noopener">See the conversation on Bluesky ↗</a>` : ""}
        </div>`;
    }

    const excerpt = headlinesOnly ? "" : (d.excerpt || "").trim().slice(0, 280);
    const hasImage = !headlinesOnly && !!d.image_url;
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
          ${tipSubscribeBadge(d)}${sprayAddButton(d)}${saveButton(d)}
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
          ${tipSubscribeBadge(d)}${sprayAddButton(d)}${saveButton(d)}
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
        ${tipSubscribeBadge(d)}${sprayAddButton(d)}${saveButton(d)}
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

  // Branch/leaf tag picker state lives inside createFlowState. Branches
  // (News/Fun/Work/Local) are never taggable themselves — only leaf topics
  // filed under News/Fun/Work are, and Local uses the existing free-text
  // location field on a Spray instead of a topic tag at all.
  function newCreateFlowState() {
    return {
      name: "", picked: [], suggestions: [], loadingSuggestions: false, addToBar: true, isPublic: true,
      topicIds: [], topicLabels: {}, // id -> display name, for chip rendering without a lookup
      location: "",
      openBranch: null, // 'news' | 'fun' | 'work' | 'local' | null
      branchLeaves: {}, // category -> [{id,name,slug}], cached per branch once loaded
      workQuery: "", workResults: [], workLoading: false,
    };
  }
  let sourceSuggestCache = null; // [{outlet, section}] — the handful shown as "starter packs"
  // Sources tab is two named areas, not a busy dashboard:
  //   YOUR SOURCES  — everything you can build a Spray from, searchable,
  //     each one drills into a detail view (which of your Sprays it's
  //     already in) that ends at the same "+ Spray" picker used from a
  //     post — this is the one general way to EDIT a Spray's contents.
  //   EXPAND YOUR MIND — a handful of suggestions plus a door into the
  //     full guided Create flow, for building something brand new.
  // Replaces the earlier "two doors" (Starter packs / Create your own)
  // framing — those two ideas were largely the same thing wearing
  // different clothes; this collapses them into one coherent area.
  let sourcesBrowseFilter = "";
  let sourcesDetailOutlet = null; // which registry row is expanded
  let sourcesDetailMixes = null;  // cached for-source() result for it

  async function loadSourceSuggestions() {
    if (sourceSuggestCache) return sourceSuggestCache;
    try {
      const suggestions = await api("/api/spray-suggestions?limit=6");
      sourceSuggestCache = Array.isArray(suggestions) ? suggestions : [];
    } catch (e) {
      sourceSuggestCache = [];
    }
    return sourceSuggestCache;
  }

  async function renderSources() {
    if (createFlowState) return renderCreateFlow();

    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "LOADING SOURCE LIST", body: "Querying the registry...", spin: true });
    try {
      const [sources, bar, suggestions] = await Promise.all([
        sourcesRegistryCache || api("/api/sources"),
        loadSprayBar(),
        loadSourceSuggestions(),
      ]);
      // Sources is for building Sprays out of Organizations — Individuals (Bluesky-only
      // people) don't produce dispatch items on their own and belong to Buzz, not here.
      // Filter on feed_type, not feed_url presence — an Organization can have no RSS
      // (e.g. Degenerate Art, YouTube-only) and still belong here.
      sourcesRegistryCache = (Array.isArray(sources) ? sources : []).filter(s => s.feed_type !== "journalist");
      const orgSources = sourcesRegistryCache;

      // ----- AREA 1: Your Sources -----
      let html = `
        <div class="sources-area-head">
          <div class="sources-area-rule"></div>
          <div class="sources-area-title">Your Sources</div>
          <div class="sources-area-sub">Everything you can build a Spray from. Tap one to see where it already lives.</div>
        </div>`;

      if (currentUser) {
        html += `<div class="section-label">Your Sprays</div>` + renderYourSpraysSection(bar);
      } else {
        html += `<p class="sources-signin-hint">Sign in (on the You tab) to save and organize your own Sprays.</p>`;
      }

      html += `<div class="section-label" style="margin-top:22px;">All sources (${orgSources.length})</div>`;
      html += `<input class="create-flow-input" id="sourcesBrowseSearch" placeholder="Search sources..." value="${escapeHtml(sourcesBrowseFilter)}" style="margin:8px 0 10px;">`;

      const filtered = sourcesBrowseFilter
        ? orgSources.filter(s => (s.outlet || s.name || "").toLowerCase().includes(sourcesBrowseFilter.toLowerCase()))
        : orgSources;

      html += filtered.length === 0
        ? `<div class="card"><div class="card-meta">No sources match.</div></div>`
        : `<div class="card" style="padding:0;">` + filtered.map((s, i) => renderSourceRow(s, i > 0)).join("") + `</div>`;

      // ----- AREA 2: Expand Your Mind -----
      html += `
        <div class="sources-area-head" style="margin-top:34px;">
          <div class="sources-area-rule"></div>
          <div class="sources-area-title">Expand Your Mind</div>
          <div class="sources-area-sub">A few you might like — tap one to add it to a Spray, or start something brand new.</div>
        </div>`;

      if (suggestions.length > 0) {
        html += `<div class="source-suggest-grid">${suggestions.map(s => `
            <button class="source-suggest-pill" data-outlet="${escapeHtml(s.outlet)}">
              ${escapeHtml(s.outlet)}${s.section ? `<span class="source-suggest-sub">${escapeHtml(s.section)}</span>` : ""}
            </button>`).join("")}
          </div>`;
      }
      html += `<button class="btn" id="startNewSprayBtn" style="margin-top:14px;width:100%;">+ Start a brand-new Spray</button>`;

      main.innerHTML = html;

      wireYourSpraysSection();
      wireSourcesArea1();

      main.querySelectorAll(".source-suggest-pill").forEach(btn => {
        btn.addEventListener("click", () => openSprayPicker({ source_type: "admin_outlet", outlet: btn.dataset.outlet, label: btn.dataset.outlet }));
      });
      document.getElementById("startNewSprayBtn").addEventListener("click", openCreateFlow);
    } catch (e) {
      main.innerHTML = stateBlock({ glyph: "!", title: "REGISTRY UNREACHABLE", body: e.message || "Could not load sources." });
    }
  }

  // A single row in the searchable registry list. Tapping it toggles an
  // inline detail (fetched lazily, only while open) showing which of the
  // reader's own Sprays already carry it, ending in the same "+ Spray"
  // picker used from a post — the drill-down IS the edit action, not a
  // separate mechanism.
  function renderSourceRow(s, needsBorder) {
    const outlet = s.outlet || s.name || "";
    const isOpen = sourcesDetailOutlet === outlet;
    let detail = "";
    if (isOpen) {
      if (!currentUser) {
        detail = `<div class="source-row-detail"><p class="sources-signin-hint" style="margin:0;">Sign in on the You tab to add this to a Spray.</p></div>`;
      } else if (!sourcesDetailMixes) {
        detail = `<div class="source-row-detail"><div class="state-block-mini">Loading…</div></div>`;
      } else {
        const inMixes = sourcesDetailMixes.filter(m => m.has_source);
        detail = `<div class="source-row-detail">
          ${inMixes.length > 0
            ? `<div class="source-row-in">In your Sprays: ${inMixes.map(m => escapeHtml(m.name)).join(", ")}</div>`
            : `<div class="source-row-in muted">Not in any of your Sprays yet.</div>`}
          <button class="btn" data-detail-add="${escapeHtml(outlet)}">+ Add to a Spray</button>
        </div>`;
      }
    }
    return `
      <div class="source-row${needsBorder ? " bordered" : ""}" data-outlet="${escapeHtml(outlet)}">
        <button class="source-row-head">
          <span>${escapeHtml(outlet)}</span>
          <span class="source-row-chevron">${isOpen ? "−" : "+"}</span>
        </button>
        ${detail}
      </div>`;
  }

  function wireSourcesArea1() {
    const search = document.getElementById("sourcesBrowseSearch");
    if (search) {
      search.addEventListener("input", debounce((e) => {
        sourcesBrowseFilter = e.target.value;
        renderSources();
      }, 200));
      // keep focus after a debounced re-render triggered by typing
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }

    document.querySelectorAll(".source-row-head").forEach(btn => {
      btn.addEventListener("click", async () => {
        const row = btn.closest(".source-row");
        const outlet = row.dataset.outlet;
        if (sourcesDetailOutlet === outlet) {
          sourcesDetailOutlet = null;
          sourcesDetailMixes = null;
          renderSources();
          return;
        }
        sourcesDetailOutlet = outlet;
        sourcesDetailMixes = null;
        renderSources();
        if (!currentUser) return;
        try {
          const result = await api(`/api/my/mixes/for-source?outlet=${encodeURIComponent(outlet)}`);
          if (sourcesDetailOutlet === outlet) {
            sourcesDetailMixes = result;
            renderSources();
          }
        } catch (e) {
          if (sourcesDetailOutlet === outlet) {
            sourcesDetailMixes = [];
            renderSources();
          }
        }
      });
    });

    document.querySelectorAll("[data-detail-add]").forEach(btn => {
      btn.addEventListener("click", () => {
        const outlet = btn.dataset.detailAdd;
        openSprayPicker({ source_type: "admin_outlet", outlet, label: outlet });
      });
    });
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

  // ----- "Add to a Spray" quick picker — opens straight off a post (card
  // or reader pane). Check/uncheck which of your own Sprays this source
  // belongs to, or spin up a brand new one with it pre-added. Toggles
  // happen immediately, no separate Save step — same "tap it, it's done"
  // feel as a save-to-a-playlist picker. This is also the general answer
  // to "editing a Spray is hard" — it's the one place a reader can add a
  // source to an EXISTING Spray at all; the guided Create flow only ever
  // builds new ones. -----

  let sprayPickerSource = null;
  let sprayPickerMixes = null; // [{slug, name, has_source}] once loaded

  function closeSprayPicker() {
    const el = document.getElementById("sprayPickerOverlay");
    if (el) el.remove();
    const closedSource = sprayPickerSource;
    sprayPickerSource = null;
    sprayPickerMixes = null;
    // If the Sources tab's drill-down detail was open on the exact source
    // this picker just edited, refresh it — otherwise it'd show stale
    // "in your Sprays" membership after a toggle.
    if (closedSource && closedSource.source_type === "admin_outlet" &&
        activeTab === "sources" && sourcesDetailOutlet === closedSource.outlet) {
      sourcesDetailMixes = null;
      renderSources();
    }
  }

  async function openSprayPicker(source) {
    if (!currentUser) { toast("Sign in on the You tab to add this to a Spray."); return; }
    if (!source) { toast("Can't add this to a Spray."); return; }
    sprayPickerSource = source;
    sprayPickerMixes = null;
    renderSprayPicker(true);
    try {
      const params = source.source_type === "custom"
        ? `custom_source_id=${source.custom_source_id}`
        : `outlet=${encodeURIComponent(source.outlet)}`;
      sprayPickerMixes = await api(`/api/my/mixes/for-source?${params}`);
    } catch (e) {
      sprayPickerMixes = [];
      toast(e.message || "Couldn't load your Sprays.");
    }
    renderSprayPicker(false);
  }

  function renderSprayPicker(loading) {
    let el = document.getElementById("sprayPickerOverlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "sprayPickerOverlay";
      el.className = "spray-picker-overlay";
      document.body.appendChild(el);
      el.addEventListener("click", (e) => { if (e.target === el) closeSprayPicker(); });
    }
    if (!sprayPickerSource) return; // closed mid-fetch
    const label = sprayPickerSource.label || "this source";
    let body;
    if (loading) {
      body = `<div class="state-block-mini">Loading your Sprays…</div>`;
    } else if (!sprayPickerMixes || sprayPickerMixes.length === 0) {
      body = `<div class="spray-picker-empty">You don't have any Sprays yet — start one below.</div>`;
    } else {
      body = `<div class="spray-picker-list">` + sprayPickerMixes.map(m => `
        <label class="spray-picker-row">
          <input type="checkbox" data-slug="${escapeHtml(m.slug)}" ${m.has_source ? "checked" : ""}>
          <span>${escapeHtml(m.name)}</span>
        </label>`).join("") + `</div>`;
    }
    el.innerHTML = `
      <div class="spray-picker-card">
        <div class="spray-picker-head">
          <span>Add <strong>${escapeHtml(label)}</strong> to a Spray</span>
          <button class="spray-picker-close" id="sprayPickerClose" aria-label="Close">×</button>
        </div>
        ${body}
        <div class="spray-picker-newrow">
          <input type="text" id="sprayPickerNewName" placeholder="New Spray name…" maxlength="80">
          <button class="btn" id="sprayPickerNewBtn">+ New</button>
        </div>
      </div>`;
    document.getElementById("sprayPickerClose").addEventListener("click", closeSprayPicker);
    if (!loading) {
      el.querySelectorAll(".spray-picker-row input[type=checkbox]").forEach(cb => {
        cb.addEventListener("change", () => toggleSprayPickerMix(cb.dataset.slug, cb));
      });
    }
    const newBtn = document.getElementById("sprayPickerNewBtn");
    if (newBtn) newBtn.addEventListener("click", createSprayFromPicker);
  }

  async function toggleSprayPickerMix(slug, checkboxEl) {
    checkboxEl.disabled = true;
    try {
      const body = sprayPickerSource.source_type === "custom"
        ? { source_type: "custom", custom_source_id: sprayPickerSource.custom_source_id }
        : { source_type: "admin_outlet", outlet: sprayPickerSource.outlet };
      const result = await api(`/api/my/mixes/${encodeURIComponent(slug)}/toggle-source`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const mix = sprayPickerMixes.find(m => m.slug === slug);
      if (mix) mix.has_source = result.added;
      toast(result.added ? "Added." : "Removed.");
    } catch (e) {
      checkboxEl.checked = !checkboxEl.checked;
      toast(e.message || "Couldn't update that Spray.");
    } finally {
      checkboxEl.disabled = false;
    }
  }

  async function createSprayFromPicker() {
    const input = document.getElementById("sprayPickerNewName");
    const name = (input.value || "").trim();
    if (!name) { toast("Name your Spray first."); return; }
    const btn = document.getElementById("sprayPickerNewBtn");
    btn.disabled = true;
    try {
      const sources = sprayPickerSource.source_type === "custom"
        ? [{ source_type: "custom", custom_source_id: sprayPickerSource.custom_source_id }]
        : [{ source_type: "admin_outlet", outlet: sprayPickerSource.outlet }];
      const created = await api("/api/mixes", { method: "POST", body: JSON.stringify({ name, sources }) });
      sprayPickerMixes = sprayPickerMixes || [];
      sprayPickerMixes.unshift({ slug: created.slug, name, has_source: true });
      toast(`Created "${name}."`);
      renderSprayPicker(false);
    } catch (e) {
      toast(e.message || "Couldn't create that Spray.");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ----- Guided Create flow: name -> add one -> suggest 5 -> repeat -----

  function openCreateFlow() {
    if (!currentUser) { toast("Sign in on the You tab to create a Spray."); return; }
    createFlowState = newCreateFlowState();
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

  const MIX_TOPIC_CAP = 6; // matches the server-side cap — keep the client warning consistent

  async function toggleBranch(cat) {
    const state = createFlowState;
    if (state.openBranch === cat) { state.openBranch = null; renderCreateFlow(); return; }
    state.openBranch = cat;
    if (cat !== "local" && !state.branchLeaves[cat]) {
      renderCreateFlow(); // show the branch open immediately, leaves fill in once loaded
      try {
        const leaves = await api(`/api/topics?category=${encodeURIComponent(cat)}`);
        state.branchLeaves[cat] = Array.isArray(leaves) ? leaves : [];
      } catch (e) {
        state.branchLeaves[cat] = [];
      }
    }
    renderCreateFlow();
  }

  function toggleTopic(id, name) {
    const state = createFlowState;
    if (state.topicIds.includes(id)) {
      state.topicIds = state.topicIds.filter(t => t !== id);
    } else {
      if (state.topicIds.length >= MIX_TOPIC_CAP) { toast(`Sprays can carry up to ${MIX_TOPIC_CAP} tags.`); return; }
      state.topicIds.push(id);
      state.topicLabels[id] = name;
    }
    renderCreateFlow();
  }

  async function runWorkQuery() {
    const state = createFlowState;
    const q = state.workQuery.trim();
    if (!q) return;
    state.workLoading = true;
    renderCreateFlow();
    try {
      const results = await api(`/api/spray-suggestions?query=${encodeURIComponent(q)}&limit=6`);
      const pickedNames = new Set(state.picked.map(p => p.outlet).filter(Boolean));
      state.workResults = (Array.isArray(results) ? results : []).filter(s => !pickedNames.has(s.outlet));
    } catch (e) {
      state.workResults = [];
    }
    state.workLoading = false;
    renderCreateFlow();
  }

  function renderBranchTiles(state) {
    const BRANCHES = [
      { key: "news", label: "News" },
      { key: "fun", label: "Fun" },
      { key: "work", label: "Work" },
      { key: "local", label: "Local" },
    ];
    const tiles = BRANCHES.map(b => `
      <button class="cf-branch-tile${state.openBranch === b.key ? " open" : ""}" data-branch="${b.key}">${b.label}</button>
    `).join("");

    let expanded = "";
    if (state.openBranch === "local") {
      expanded = `
        <div class="create-flow-step" style="margin-top:2px;">
          <div class="create-flow-label">Place (any granularity — town, state, region)</div>
          <input class="create-flow-input" id="cfLocation" placeholder="e.g. Ann Arbor, MI" value="${escapeHtml(state.location)}">
        </div>`;
    } else if (state.openBranch === "work") {
      const leaves = state.branchLeaves.work;
      const leafChips = leaves === undefined
        ? `<div class="card-meta">Loading...</div>`
        : leaves.map(t => `
            <button class="cf-leaf-chip${state.topicIds.includes(t.id) ? " selected" : ""}" data-topic-id="${t.id}" data-topic-name="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>
          `).join("");
      const workResultsHtml = state.workLoading
        ? `<div class="card-meta">Searching the registry...</div>`
        : state.workResults.length === 0
          ? ""
          : state.workResults.map((s, i) => `
            <div class="create-flow-suggestion">
              <input type="checkbox" id="workres-${i}" data-outlet="${escapeHtml(s.outlet)}">
              <label for="workres-${i}">${escapeHtml(s.outlet)}${s.section ? ` <span class="card-meta" style="display:inline;">— ${escapeHtml(s.section)}</span>` : ""}</label>
            </div>`).join("");
      expanded = `
        <div class="create-flow-step" style="margin-top:2px;">
          <div class="cf-leaf-chips">${leafChips}</div>
          <div class="create-flow-label">What do you do? We'll match sources already in the registry — no AI, just keyword search.</div>
          <div style="display:flex; gap:8px;">
            <input class="create-flow-input" id="cfWorkQuery" placeholder="e.g. freelance writing, product management" value="${escapeHtml(state.workQuery)}">
            <button class="btn" id="cfWorkSearch">Find</button>
          </div>
          ${state.workResults.length > 0 || state.workLoading ? `<div style="margin-top:8px;">${workResultsHtml}</div>
            <button class="btn primary" id="cfAddWorkResults" style="width:100%; margin-top:8px;">Add checked</button>` : ""}
        </div>`;
    } else if (state.openBranch === "news" || state.openBranch === "fun") {
      const leaves = state.branchLeaves[state.openBranch];
      const leafChips = leaves === undefined
        ? `<div class="card-meta">Loading...</div>`
        : leaves.map(t => `
            <button class="cf-leaf-chip${state.topicIds.includes(t.id) ? " selected" : ""}" data-topic-id="${t.id}" data-topic-name="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>
          `).join("");
      expanded = `<div class="cf-leaf-chips" style="margin-top:2px;">${leafChips}</div>`;
    }

    const pickedTagChips = Object.entries(state.topicLabels)
      .filter(([id]) => state.topicIds.includes(Number(id)))
      .map(([id, name]) => `
        <span class="outlet-chip" style="background:var(--surface); padding:5px 10px; border-radius:999px; gap:6px; display:inline-flex; align-items:center;">
          ${escapeHtml(name)}
          <button class="spray-bar-btn remove" data-remove-topic="${id}" style="padding:0; font-size:14px;">×</button>
        </span>`).join("");
    const locationChip = state.location ? `
        <span class="outlet-chip" style="background:var(--surface); padding:5px 10px; border-radius:999px; gap:6px; display:inline-flex; align-items:center;">
          📍 ${escapeHtml(state.location)}
          <button class="spray-bar-btn remove" id="cfRemoveLocation" style="padding:0; font-size:14px;">×</button>
        </span>` : "";

    return `
      <div class="create-flow-step">
        <div class="create-flow-label">Tag it (optional)</div>
        <div class="cf-branch-tiles">${tiles}</div>
        ${expanded}
        ${(pickedTagChips || locationChip) ? `<div class="cf-tags-picked">${pickedTagChips}${locationChip}</div>` : ""}
      </div>`;
  }

  function wireBranchTiles(main) {
    const state = createFlowState;
    main.querySelectorAll("[data-branch]").forEach(btn => {
      btn.addEventListener("click", () => toggleBranch(btn.dataset.branch));
    });
    main.querySelectorAll("[data-topic-id]").forEach(btn => {
      btn.addEventListener("click", () => toggleTopic(Number(btn.dataset.topicId), btn.dataset.topicName));
    });
    main.querySelectorAll("[data-remove-topic]").forEach(btn => {
      btn.addEventListener("click", () => toggleTopic(Number(btn.dataset.removeTopic), state.topicLabels[btn.dataset.removeTopic]));
    });
    const locInput = document.getElementById("cfLocation");
    if (locInput) locInput.addEventListener("input", (e) => { state.location = e.target.value; });
    const removeLoc = document.getElementById("cfRemoveLocation");
    if (removeLoc) removeLoc.addEventListener("click", () => { state.location = ""; renderCreateFlow(); });
    const workInput = document.getElementById("cfWorkQuery");
    if (workInput) {
      workInput.addEventListener("input", (e) => { state.workQuery = e.target.value; });
      workInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runWorkQuery(); } });
    }
    const workSearchBtn = document.getElementById("cfWorkSearch");
    if (workSearchBtn) workSearchBtn.addEventListener("click", runWorkQuery);
    const addWorkBtn = document.getElementById("cfAddWorkResults");
    if (addWorkBtn) {
      addWorkBtn.addEventListener("click", () => {
        main.querySelectorAll("[data-outlet]").forEach(cb => {
          if (cb.type === "checkbox" && cb.checked && cb.id.startsWith("workres-")) {
            addPicked({ source_type: "admin_outlet", outlet: cb.dataset.outlet, label: cb.dataset.outlet });
          }
        });
        state.workResults = [];
        state.workQuery = "";
        refreshSuggestions();
      });
    }
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

      ${renderBranchTiles(state)}

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

    wireBranchTiles(main);

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
      const body = { name, is_public: state.isPublic, sources };
      if (state.topicIds.length > 0) body.topic_ids = state.topicIds;
      if (state.location.trim()) body.location_label = state.location.trim();
      const mix = await api("/api/mixes", { method: "POST", body: JSON.stringify(body) });
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
  // Desktop side panel — a stack of small stat/context modules filling
  // the dead space beyond the centered main column on wide screens.
  // Replaces the old flat "Most Popular on Bluesky" list with several
  // independent modules a reader can show/hide individually, or hide
  // the whole panel. Hiding always works locally (localStorage) whether
  // signed in or not — signing in just carries that choice across
  // devices, same pattern as the Read-tab Spray bar and Edit Layout.
  // ---------------------------------------------------------------
  const MIDTERM_DATE = new Date("2026-11-03T00:00:00");
  const IRAN_WAR_START = new Date("2026-02-28T00:00:00");

  const PANEL_MODULE_DEFS = [
    { key: "midterms", label: "Days to midterms" },
    { key: "iranwar", label: "Day of Iran War" },
    { key: "gas", label: "Gas price" },
    { key: "co2", label: "CO2 (ppm)" },
    { key: "tempanomaly", label: "Global temp anomaly" },
    { key: "seaice", label: "Arctic sea ice extent" },
    { key: "disasters", label: "Billion-dollar disasters" },
    { key: "topbluesky", label: "Top post on Bluesky" },
  ];

  const PANEL_HIDDEN_KEY = "source_panel_hidden";
  const PANEL_MODULES_KEY = "source_panel_hidden_modules";

  function getPanelHidden() { return localStorage.getItem(PANEL_HIDDEN_KEY) === "1"; }
  function setPanelHidden(v) { localStorage.setItem(PANEL_HIDDEN_KEY, v ? "1" : "0"); }
  function getHiddenModules() {
    try {
      const raw = JSON.parse(localStorage.getItem(PANEL_MODULES_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch (e) { return new Set(); }
  }
  function setHiddenModules(set) { localStorage.setItem(PANEL_MODULES_KEY, JSON.stringify([...set])); }

  let panelPrefsSynced = false; // only pull the account's saved prefs once per page load
  async function syncPanelPrefsFromAccount() {
    if (!currentUser || panelPrefsSynced) return;
    panelPrefsSynced = true;
    try {
      const prefs = await api("/api/my/panel-prefs");
      if (prefs && prefs.saved) {
        setPanelHidden(prefs.panelHidden);
        setHiddenModules(new Set(prefs.hiddenModules || []));
      }
    } catch (e) { /* fail soft, keep whatever localStorage already has */ }
  }
  async function savePanelPrefsToAccount() {
    if (!currentUser) return;
    try {
      await api("/api/my/panel-prefs", {
        method: "POST",
        body: JSON.stringify({ panelHidden: getPanelHidden(), hiddenModules: [...getHiddenModules()] }),
      });
    } catch (e) { /* fail soft — local state already applied regardless */ }
  }

  let desktopPanelDataCache = null; // resolved {gas, co2, temp, ice, disasters, topPost} — fetched once per page load
  async function fetchPanelData() {
    const [gasR, co2R, tempR, iceR, disR, bskyR] = await Promise.allSettled([
      api("/api/gas-price"),
      api("/api/co2-ppm"),
      api("/api/temp-anomaly"),
      api("/api/sea-ice"),
      api("/api/climate-disasters"),
      api("/api/nerve-center/bluesky"),
    ]);
    return {
      gas: gasR.status === "fulfilled" ? gasR.value.price : null,
      co2: co2R.status === "fulfilled" ? co2R.value.ppm : null,
      co2PreIndustrial: co2R.status === "fulfilled" ? co2R.value.preIndustrial : 280,
      temp: tempR.status === "fulfilled" ? tempR.value.anomaly : null,
      ice: iceR.status === "fulfilled" ? iceR.value.extent : null,
      disasters: disR.status === "fulfilled" ? disR.value.count : null,
      topPost: (bskyR.status === "fulfilled" && Array.isArray(bskyR.value) && bskyR.value.length) ? bskyR.value[0] : null,
    };
  }

  // Each returns an HTML string, or null if there's nothing to show —
  // callers skip the module entirely on null rather than rendering an
  // empty/broken state.
  function renderPanelModule(key, data) {
    switch (key) {
      case "midterms": {
        const days = Math.ceil((MIDTERM_DATE - new Date()) / 86400000);
        return `<div class="panel-stat"><span class="panel-stat-value">${days}</span><span class="panel-stat-label">days to the midterms</span></div>`;
      }
      case "iranwar": {
        const day = Math.floor((new Date() - IRAN_WAR_START) / 86400000) + 1;
        return `<div class="panel-stat"><span class="panel-stat-value">${day}</span><span class="panel-stat-label">day of the Iran War</span></div>`;
      }
      case "gas":
        if (!data.gas) return null;
        return `<div class="panel-stat"><span class="panel-stat-value">$${Number(data.gas).toFixed(2)}</span><span class="panel-stat-label">/gal natl avg gas price</span></div>`;
      case "co2":
        if (!data.co2) return null;
        return `<div class="panel-stat"><span class="panel-stat-value">${data.co2}</span><span class="panel-stat-label">ppm CO₂ · pre-industrial was ${data.co2PreIndustrial}</span></div>`;
      case "tempanomaly": {
        if (data.temp === null || data.temp === undefined) return null;
        const tempF = Math.round(data.temp * 9 / 5 * 100) / 100;
        return `<div class="panel-stat"><span class="panel-stat-value">${tempF > 0 ? "+" : ""}${tempF}°F</span><span class="panel-stat-label">global temp vs. 1951–1980 avg</span></div>`;
      }
      case "seaice":
        if (!data.ice) return null;
        return `<div class="panel-stat"><span class="panel-stat-value">${data.ice}M km²</span><span class="panel-stat-label">Arctic sea ice extent</span></div>`;
      case "disasters":
        if (!data.disasters) return null;
        return `<div class="panel-stat"><span class="panel-stat-value">${data.disasters}</span><span class="panel-stat-label">billion-dollar disasters this year</span></div>`;
      case "topbluesky":
        if (!data.topPost) return null;
        return `<div class="panel-stat-label" style="margin-bottom:6px;">Top on Bluesky</div>${renderBluePost(data.topPost, "panel-top-post")}<a class="desktop-bsky-rail-more" href="/nerve-center.html" target="_blank" rel="noopener">More on Nerve Center →</a>`;
      default:
        return null;
    }
  }

  function renderPanelSettings() {
    const hidden = getHiddenModules();
    const panelHidden = getPanelHidden();
    return `
      <div class="panel-settings" id="panelSettings">
        <button class="icon-btn panel-settings-btn" id="panelSettingsBtn" aria-haspopup="true" aria-expanded="false" title="Customize panel">⚙</button>
        <div class="panel-settings-list" id="panelSettingsList" hidden>
          <label class="panel-settings-item">
            <input type="checkbox" id="panelHideAllToggle" ${panelHidden ? "checked" : ""}>
            Hide this panel
          </label>
          <div class="panel-settings-sep"></div>
          ${PANEL_MODULE_DEFS.map(m => `
            <label class="panel-settings-item">
              <input type="checkbox" class="panel-module-toggle" data-key="${m.key}" ${hidden.has(m.key) ? "" : "checked"}>
              ${escapeHtml(m.label)}
            </label>`).join("")}
          ${!currentUser ? `<div class="panel-signin-hint">Signed in, this'll follow you across devices — <a href="#" id="panelSignInLink">Sign in</a></div>` : ""}
        </div>
      </div>`;
  }

  function wirePanelSettingsEvents() {
    const btn = document.getElementById("panelSettingsBtn");
    const list = document.getElementById("panelSettingsList");
    if (!btn || !list) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const opening = list.hidden;
      list.hidden = !opening;
      btn.setAttribute("aria-expanded", String(opening));
    });
    const hideAll = document.getElementById("panelHideAllToggle");
    if (hideAll) {
      hideAll.addEventListener("change", () => {
        setPanelHidden(hideAll.checked);
        savePanelPrefsToAccount();
        renderDesktopSidePanel();
      });
    }
    document.querySelectorAll(".panel-module-toggle").forEach(cb => {
      cb.addEventListener("change", () => {
        const set = getHiddenModules();
        if (cb.checked) set.delete(cb.dataset.key); else set.add(cb.dataset.key);
        setHiddenModules(set);
        savePanelPrefsToAccount();
        renderDesktopSidePanel();
      });
    });
    const signInLink = document.getElementById("panelSignInLink");
    if (signInLink) {
      signInLink.addEventListener("click", (e) => {
        e.preventDefault();
        switchTab("you");
      });
    }
  }

  function panelDateLabel() {
    return new Date().toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }

  // Desktop-only side panel: fills the dead space beyond the centered
  // main column on wide screens. Fetches once per page load (cached);
  // only fetches when the layout is actually Desktop, since CSS hides
  // the panel entirely otherwise. Never fully vanishes even when a
  // reader hides it — collapses to just the header row so the gear
  // icon (the only way back) stays reachable.
  async function renderDesktopSidePanel() {
    const el = document.getElementById("desktopSidePanel");
    if (!el) return;
    if (getLayoutMode() !== "desktop") { el.hidden = true; return; }
    el.hidden = false;
    await syncPanelPrefsFromAccount();

    if (getPanelHidden()) {
      el.innerHTML = `<div class="panel-head"><div class="panel-head-text"><span class="desktop-bsky-rail-head">Panel hidden</span><span class="panel-date">${panelDateLabel()}</span></div>${renderPanelSettings()}</div>`;
      wirePanelSettingsEvents();
      return;
    }

    if (!desktopPanelDataCache) {
      el.innerHTML = `<div class="panel-head"><div class="panel-head-text"><span class="desktop-bsky-rail-head">Today</span><span class="panel-date">${panelDateLabel()}</span></div>${renderPanelSettings()}</div><div class="state-block-mini">Loading…</div>`;
      wirePanelSettingsEvents();
      desktopPanelDataCache = await fetchPanelData();
    }

    const hidden = getHiddenModules();
    const moduleHtml = PANEL_MODULE_DEFS
      .filter(m => !hidden.has(m.key))
      .map(m => renderPanelModule(m.key, desktopPanelDataCache))
      .filter(Boolean)
      .join("");

    el.innerHTML = `
      <div class="panel-head"><div class="panel-head-text"><span class="desktop-bsky-rail-head">Today</span><span class="panel-date">${panelDateLabel()}</span></div>${renderPanelSettings()}</div>
      ${moduleHtml || `<div class="state-block-mini">Nothing to show — everything's hidden or unavailable right now.</div>`}`;
    wirePanelSettingsEvents();
  }

  let actionsExpanded = false;
  let onTrendExpanded = false;
  const ON_TREND_COLLAPSED_COUNT = 5;

  async function renderBuzz() {
    const main = document.getElementById("main");
    main.innerHTML = stateBlock({ title: "SCANNING CHATTER", body: "Pulling the signal off Bluesky...", spin: true });
    const [actionsResult, postsResult, chatterResult] = await Promise.allSettled([
      api("/api/actions-feed"),
      api("/api/nerve-center/bluesky"),
      api("/api/nerve-center/chatter"),
    ]);

    const actions = actionsResult.status === "fulfilled" && Array.isArray(actionsResult.value) ? actionsResult.value : [];
    const posts = postsResult.status === "fulfilled" && Array.isArray(postsResult.value) ? postsResult.value : [];
    const stories = chatterResult.status === "fulfilled" && Array.isArray(chatterResult.value) ? chatterResult.value : [];

    if (actions.length === 0 && posts.length === 0 && stories.length === 0) {
      main.innerHTML = stateBlock({ glyph: "∅", title: "QUIET RIGHT NOW", body: "No chatter picked up in the current window." });
      return;
    }

    let html = "";
    if (actions.length > 0) {
      html += `<div class="section-label">WHAT YOU CAN DO</div>` + renderActionsSection(actions);
    }
    if (stories.length > 0) {
      html += `<div class="section-label">ON TREND</div><p class="section-sub">Who's covering today's top stories</p>` + renderOnTrendSection(stories);
    }
    if (posts.length > 0) {
      const scrollMode = getReadDisplay() === "scroll";
      html += `<div class="section-label">TRENDING ON BLUESKY</div>` + posts.slice(0, 40).map(p => renderBluePost(p, scrollMode ? "card-scroll-post" : "")).join("");
    }
    main.innerHTML = html;

    const actionsToggle = document.getElementById("actionsExpandToggle");
    if (actionsToggle) {
      actionsToggle.addEventListener("click", () => {
        actionsExpanded = !actionsExpanded;
        renderBuzz();
      });
    }
    const onTrendToggle = document.getElementById("onTrendExpandToggle");
    if (onTrendToggle) {
      onTrendToggle.addEventListener("click", () => {
        onTrendExpanded = !onTrendExpanded;
        renderBuzz();
      });
    }
  }

  function renderActionsSection(actions) {
    const [top, ...rest] = actions;
    let html = "";
    if (top) {
      const excerpt = (top.excerpt || "").trim();
      html += `<p class="section-sub">Latest from Rogan's List</p>`;
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
      if (actionsExpanded) {
        html += `<div class="card">` + rest.map(a => `
          <a class="card-link plain-row" href="${escapeHtml(a.link || "#")}" target="_blank" rel="noopener">${escapeHtml(a.title || "")}</a>
        `).join("") + `</div>`;
        html += `<button class="link-toggle" id="actionsExpandToggle">Show less</button>`;
      } else {
        html += `<button class="link-toggle" id="actionsExpandToggle">See ${rest.length} more from Rogan's List →</button>`;
      }
    }
    return html;
  }

  function renderOnTrendSection(stories) {
    const shown = onTrendExpanded ? stories : stories.slice(0, ON_TREND_COLLAPSED_COUNT);
    let html = shown.map(s => `
      <div class="card">
        <a class="card-link plain-row" href="${escapeHtml(s.storyLink || "#")}" target="_blank" rel="noopener"><strong>${escapeHtml(s.story || "")}</strong></a>
        ${(s.chatter || []).map(c => `
          <div class="on-trend-post">
            ${outletChip(c.outlet || "")}
            <div class="on-trend-post-text">${escapeHtml((c.text || "").slice(0, 200))}</div>
            <a class="on-trend-post-link" href="${escapeHtml(c.blueskyUrl || "#")}" target="_blank" rel="noopener">See it on Bluesky ↗</a>
          </div>`).join("")}
      </div>`).join("");
    if (stories.length > ON_TREND_COLLAPSED_COUNT) {
      html += onTrendExpanded
        ? `<button class="link-toggle" id="onTrendExpandToggle">Show less</button>`
        : `<button class="link-toggle" id="onTrendExpandToggle">Show ${stories.length - ON_TREND_COLLAPSED_COUNT} more stories →</button>`;
    }
    return html;
  }

  function renderBluePost(p, extraClass) {
    const cls = typeof extraClass === "string" ? ` ${extraClass}` : "";
    return `
      <a class="card card-link${cls}" href="${escapeHtml(p.link || p.postUrl || "#")}" target="_blank" rel="noopener" style="display:block;">
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
    let saves = [];
    let visibility = { is_public: false, share_slug: null };
    try {
      [saves, visibility] = await Promise.all([
        api("/api/my/saves"),
        api("/api/my/saves/visibility"),
      ]);
    } catch (e) {
      // fail soft — signed-in status and sign-out still work even if
      // saves can't be loaded right now
    }

    main.innerHTML = `
      <div class="card">
        <div class="card-meta"><span>SIGNED IN</span><span class="stamp">VERIFIED</span></div>
        <div class="card-title">${escapeHtml(currentUser.email)}</div>
      </div>
      <button class="btn" id="youSignOut" style="margin-top:10px;">SIGN OUT</button>
      <div class="section-label" style="margin-top:22px;">MY SAVES</div>
      <div class="section-sub">${saves.length} saved item${saves.length === 1 ? "" : "s"} — a personal reading list, not a Spray.</div>
      ${renderMySavesSection(saves, visibility)}
    `;
    document.getElementById("youSignOut").addEventListener("click", async () => {
      try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      setToken("");
      currentUser = null;
      sprayBarData = null;
      renderYou();
    });
    wireMySavesSection();
  }

  // ----- "My Saves" (personal reading list, You tab) -----
  // Distinct from Sprays: a Spray is a collection of SOURCES a reader
  // follows; a save is a single ITEM they wanted to keep. Snapshotted at
  // save time (see saveButton()) — the title/excerpt/image shown here is
  // frozen, not re-fetched live, so a save never breaks even after its
  // source item ages out of the wire.
  function renderMySavesSection(saves, visibility) {
    const shareUrl = visibility.share_slug ? `${location.origin}/source/?saves=${visibility.share_slug}` : null;
    const rssUrl = visibility.share_slug ? `${location.origin}/api/saves/${visibility.share_slug}/rss` : null;
    const shareRow = `
      <div class="card" style="padding:12px; margin-bottom:10px;">
        <div class="spray-bar-row" style="padding:0;">
          <span class="spray-bar-name">${visibility.is_public ? "🌐 Your saves are public" : "🔒 Your saves are private"}</span>
          <button class="spray-bar-btn" id="savesVisibilityToggle">${visibility.is_public ? "Make private" : "Share my saves"}</button>
        </div>
        ${visibility.is_public && shareUrl ? `
          <div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
            <input class="create-flow-input" id="savesShareUrl" readonly value="${escapeHtml(shareUrl)}" style="flex:1;">
            <button class="btn" id="savesShareCopy">Copy</button>
          </div>
          <a class="ob-whats-this" href="${escapeHtml(rssUrl)}" target="_blank" rel="noopener" style="display:block; margin-top:8px;">📡 Subscribe via RSS</a>` : ""}
      </div>`;

    if (saves.length === 0) {
      return shareRow + `<div class="card"><div class="card-meta">Nothing saved yet — tap "☆ Save" on any post in Read or Buzz to keep it here.</div></div>`;
    }

    const rows = saves.map(s => `
      <div class="spray-bar-row" data-save-id="${s.id}" style="align-items:flex-start;">
        ${s.image_url ? `<img src="${escapeHtml(s.image_url)}" alt="" style="width:56px; height:56px; object-fit:cover; border-radius:6px; flex-shrink:0;" onerror="this.remove()">` : ""}
        <a href="${escapeHtml(s.link)}" target="_blank" rel="noopener" style="flex:1; min-width:0; text-decoration:none; color:inherit;">
          <span class="spray-bar-name" style="display:block; white-space:normal;">${escapeHtml(s.title)}</span>
          <span class="feed-item-meta" style="display:block; margin-top:2px;"><span>${escapeHtml(s.outlet || "")}</span></span>
        </a>
        <button class="spray-bar-btn remove" data-action="remove-save">×</button>
      </div>`).join("");

    return shareRow + `<div class="card" style="padding:0;">${rows}</div>`;
  }

  function wireMySavesSection() {
    const toggle = document.getElementById("savesVisibilityToggle");
    if (toggle) {
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          const current = toggle.textContent.trim() === "Share my saves";
          await api("/api/my/saves/visibility", { method: "POST", body: JSON.stringify({ is_public: current }) });
          renderYou();
        } catch (e) {
          toast(e.message || "Couldn't update sharing");
          toggle.disabled = false;
        }
      });
    }
    const copyBtn = document.getElementById("savesShareCopy");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const input = document.getElementById("savesShareUrl");
        if (!input) return;
        input.select();
        navigator.clipboard?.writeText(input.value).then(() => toast("Link copied")).catch(() => toast("Couldn't copy — select and copy manually"));
      });
    }
    document.querySelectorAll('[data-save-id] [data-action="remove-save"]').forEach(btn => {
      btn.addEventListener("click", async () => {
        const row = btn.closest("[data-save-id]");
        const id = row?.dataset.saveId;
        if (!id) return;
        btn.disabled = true;
        try {
          await api(`/api/my/saves/${id}`, { method: "DELETE" });
          renderYou();
        } catch (e) {
          toast(e.message || "Couldn't remove that");
          btn.disabled = false;
        }
      });
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

  const WHATS_THIS_COPY = "SOURCE! gives you the news you need, without the billionaires' algorithms. Choose from handpicked Sprays of vetted RSS feeds. Or create your own and share it with anyone as its own RSS feed.";

  function showOnboarding() {
    const el = document.createElement("div");
    el.className = "onboarding";
    el.id = "onboarding";
    el.innerHTML = `
      <div class="ob-wordmark">SOURCE!</div>
      <div class="ob-rule"></div>
      <h1>Take Back Your Mind</h1>
      <button class="ob-btn" id="obStart">Just dig in</button>
      <button class="ob-btn secondary" id="obOwn">Pick my own sources</button>
      <a href="#" class="ob-whats-this" id="obWhatsThis">What's this?</a>
    `;
    document.body.appendChild(el);
    document.getElementById("obStart").addEventListener("click", () => dismissOnboarding("read"));
    document.getElementById("obOwn").addEventListener("click", () => dismissOnboarding("sources"));
    document.getElementById("obWhatsThis").addEventListener("click", (e) => {
      e.preventDefault();
      toggleWhatsThis();
    });
  }

  function toggleWhatsThis() {
    const existing = document.getElementById("obWhatsThisPanel");
    if (existing) { existing.remove(); return; }
    const el = document.getElementById("onboarding");
    if (!el) return;
    const panel = document.createElement("div");
    panel.className = "ob-whats-this-panel";
    panel.id = "obWhatsThisPanel";
    panel.innerHTML = `
      <p>${escapeHtml(WHATS_THIS_COPY)}</p>
      <button class="ob-whats-this-close" id="obWhatsThisClose" aria-label="Close">×</button>
    `;
    el.appendChild(panel);
    document.getElementById("obWhatsThisClose").addEventListener("click", () => panel.remove());
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
  // ----- Public "shared saves" view (?saves=<slug>) -----
  // A visitor opening a shared save-list link doesn't sign in or land on
  // a normal tab — this renders read-only, straight into #main, same
  // "?spray=<slug> auto-opens on load" pattern spray.html already uses
  // for its own shareable links.
  async function renderPublicSaves(slug) {
    const main = document.getElementById("main");
    main.innerHTML = `<div class="card"><div class="card-meta">Loading saved items…</div></div>`;
    let data;
    try {
      data = await api(`/api/saves/${encodeURIComponent(slug)}`);
    } catch (e) {
      main.innerHTML = `<div class="card"><div class="card-meta">This save list isn't public (or doesn't exist).</div></div>`;
      return;
    }
    const items = data.items || [];
    main.innerHTML = `
      <div class="section-label">SHARED SAVES</div>
      <div class="section-sub">${items.length} item${items.length === 1 ? "" : "s"} someone chose to keep — read-only, not a Spray.</div>
      ${items.length === 0
        ? `<div class="card"><div class="card-meta">Nothing here yet.</div></div>`
        : items.map(it => `
          <div class="card">
            <a class="card-link" href="${escapeHtml(it.link)}" target="_blank" rel="noopener">
              <div class="card-meta">${outletChip(it.outlet)}<span>${relTime(it.saved_at)}</span></div>
              <div class="card-title">${escapeHtml(it.title)}</div>
              ${it.excerpt ? `<div class="card-excerpt">${escapeHtml(it.excerpt)}</div>` : ""}
            </a>
          </div>`).join("")}
      <a href="/source/" class="ob-whats-this" style="display:block; margin-top:16px;">← Back to SOURCE!</a>`;
  }

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
      const panelList = document.getElementById("panelSettingsList");
      const panelBtn = document.getElementById("panelSettingsBtn");
      if (panelList && !panelList.hidden) {
        panelList.hidden = true;
        if (panelBtn) panelBtn.setAttribute("aria-expanded", "false");
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

    const sharedSavesSlug = new URLSearchParams(location.search).get("saves");
    if (sharedSavesSlug) {
      renderPublicSaves(sharedSavesSlug);
    } else {
      renderActiveTab();
    }
    renderDesktopSidePanel();

    if (!localStorage.getItem(ONBOARDED_KEY)) {
      showOnboarding();
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/source/sw.js").catch(() => { /* fail soft */ });
    }
  });
})();
