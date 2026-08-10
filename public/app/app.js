(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Auth: cookie-first (this is a same-origin browser-tab PWA today, so
  // the existing magic-link -> Set-Cookie flow just works via
  // credentials:'include'). We also read/store a bearer token in
  // localStorage if we ever get one back from the server (a client asking
  // for JSON at verify time) so the SAME code path is ready for a future
  // Capacitor-wrapped native shell, where cookies won't survive across a
  // system-browser hop the way they do in a plain mobile browser tab.
  // ---------------------------------------------------------------------
  const TOKEN_KEY = "n38_app_token";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }
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
    } catch (e) {
      currentUser = null;
    }
    return currentUser;
  }

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // ---------------------------------------------------------------------
  // Shared state helpers
  // ---------------------------------------------------------------------
  const BURST_SVG = `<svg class="burst-mark" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="15" fill="currentColor"/>
    <g stroke="currentColor" stroke-width="6" stroke-linecap="round">
      <line x1="50" y1="10" x2="50" y2="26"/><line x1="50" y1="74" x2="50" y2="90"/>
      <line x1="10" y1="50" x2="26" y2="50"/><line x1="74" y1="50" x2="90" y2="50"/>
      <line x1="21.7" y1="21.7" x2="32.5" y2="32.5"/><line x1="67.5" y1="67.5" x2="78.3" y2="78.3"/>
      <line x1="78.3" y1="21.7" x2="67.5" y2="32.5"/><line x1="32.5" y1="67.5" x2="21.7" y2="78.3"/>
    </g></svg>`;

  function stateBlock({ title, body, spin }) {
    return `<div class="state-block">${BURST_SVG.replace('class="burst-mark"', `class="burst-mark${spin ? " spin" : ""}"`)}
      <h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p></div>`;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function timeAgo(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  }

  // ---------------------------------------------------------------------
  // WIRE tab
  // ---------------------------------------------------------------------
  const WIRE_CACHE_KEY = "n38_wire_cache_v1";

  async function loadWire(root, { fromCache } = {}) {
    if (fromCache) {
      const cached = readWireCache();
      if (cached) renderWireList(root, cached, { stale: true });
    }
    if (!root.dataset.loaded) root.innerHTML = stateBlock({ title: "Loading the wire", body: "Pulling the latest dispatches.", spin: true });
    try {
      const rows = await api("/api/dispatches");
      renderWireList(root, rows);
      writeWireCache(rows);
    } catch (e) {
      if (!root.dataset.loaded) {
        const cached = readWireCache();
        if (cached) renderWireList(root, cached, { stale: true });
        else root.innerHTML = stateBlock({ title: "Couldn't load the wire", body: "Check your connection and try again." });
      } else {
        toast("Couldn't refresh — showing what's already loaded.");
      }
    }
  }

  function readWireCache() {
    try {
      const raw = localStorage.getItem(WIRE_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeWireCache(rows) {
    try { localStorage.setItem(WIRE_CACHE_KEY, JSON.stringify(rows.slice(0, 60))); } catch (e) { /* storage full, ignore */ }
  }

  function renderWireList(root, rows, { stale } = {}) {
    root.dataset.loaded = "1";
    if (!rows || rows.length === 0) {
      root.innerHTML = stateBlock({ title: "Nothing on the wire yet", body: "Pull to refresh in a moment." });
      return;
    }
    const staleNote = stale ? `<div class="section-eyebrow">Showing your last saved wire — reconnecting…</div>` : `<div class="section-eyebrow">Latest dispatches</div>`;
    root.innerHTML = staleNote + rows.map(dispatchCard).join("");
  }

  function dispatchCard(r) {
    const tip = r.tip_url ? `<a class="tip-link" href="${escapeHtml(r.tip_url)}" target="_blank" rel="noopener">Tip your reporter</a>` : "";
    const sub = r.subscribe_url ? `<a href="${escapeHtml(r.subscribe_url)}" target="_blank" rel="noopener">Subscribe</a>` : "";
    return `<article class="card">
      <h2 class="dispatch-headline"><a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(r.headline)}</a></h2>
      ${r.excerpt ? `<p class="dispatch-excerpt">${escapeHtml(r.excerpt)}</p>` : ""}
      <div class="dispatch-meta">
        <span class="outlet">${escapeHtml(r.outlet || r.name)}</span>
        ${r.beat ? `<span>${escapeHtml(r.beat)}</span>` : ""}
        <span>${escapeHtml(timeAgo(r.date))}</span>
        ${r.pinned ? `<span class="pin-badge">Pinned</span>` : ""}
      </div>
      ${(tip || sub) ? `<div class="dispatch-actions">${tip}${sub}</div>` : ""}
    </article>`;
  }

  // ---------------------------------------------------------------------
  // VIDEOS tab
  // ---------------------------------------------------------------------
  async function loadVideos(root) {
    if (!root.dataset.loaded) root.innerHTML = stateBlock({ title: "Loading videos", body: "Pulling from curated channels.", spin: true });
    try {
      const rows = await api("/api/video-feed");
      root.dataset.loaded = "1";
      if (!rows || rows.length === 0) {
        root.innerHTML = stateBlock({ title: "No videos right now", body: "Check back soon — this refreshes every 30 minutes." });
        return;
      }
      root.innerHTML = `<div class="section-eyebrow">Curated channels</div>` + rows.map(videoCard).join("");
    } catch (e) {
      root.innerHTML = stateBlock({ title: "Couldn't load videos", body: "Check your connection and try again." });
    }
  }

  function videoCard(v) {
    return `<a class="card video-card" href="${escapeHtml(v.url)}" target="_blank" rel="noopener" style="display:flex;color:inherit;text-decoration:none;">
      ${v.thumbnail ? `<img class="video-thumb" src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy">` : `<div class="video-thumb"></div>`}
      <div class="video-info">
        <h3 class="video-title">${escapeHtml(v.title)}</h3>
        <div class="video-channel">${escapeHtml(v.channel)} · ${escapeHtml(timeAgo(v.published_at))}</div>
      </div>
    </a>`;
  }

  // ---------------------------------------------------------------------
  // FOLLOWS tab (topics + directory + custom sources + create)
  // ---------------------------------------------------------------------
  let followsState = { topic: null, location: "" };

  async function loadFollows(root) {
    if (!root.dataset.loaded) root.innerHTML = stateBlock({ title: "Loading Follows", body: "Fetching topics and mixes.", spin: true });
    try {
      const topics = await api("/api/topics");
      root.dataset.loaded = "1";
      renderFollows(root, topics);
      loadMixDirectory(root);
    } catch (e) {
      root.innerHTML = stateBlock({ title: "Couldn't load Follows", body: "Check your connection and try again." });
    }
  }

  function renderFollows(root, topics) {
    root.innerHTML = `
      <div class="section-eyebrow">What do you want to follow?</div>
      <div class="field">
        <label for="followsLocation">Search by place</label>
        <input type="search" id="followsLocation" placeholder="e.g. Ann Arbor, MI">
      </div>
      ${topics && topics.length ? `<div class="chip-row" id="topicChips">
        <button class="chip" data-topic="">All</button>
        ${topics.map((t) => `<button class="chip" data-topic="${escapeHtml(t.slug)}">${escapeHtml(t.name)}<span class="chip-count">${t.mix_count || 0}</span></button>`).join("")}
      </div>` : `<p style="color:var(--muted);font-size:13px;margin:0 0 16px;">No topics yet — be the first to propose one below.</p>`}
      <button class="btn secondary small" id="createFollowBtn" style="margin-bottom:16px;">+ Create a Follow</button>
      <div id="mixDirectory"></div>
    `;

    const chips = root.querySelectorAll(".chip");
    chips.forEach((c) => c.addEventListener("click", () => {
      chips.forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      followsState.topic = c.dataset.topic || null;
      loadMixDirectory(root);
    }));
    root.querySelector("#topicChips .chip")?.classList.add("active");

    let locTimer = null;
    root.querySelector("#followsLocation").addEventListener("input", (e) => {
      clearTimeout(locTimer);
      locTimer = setTimeout(() => {
        followsState.location = e.target.value.trim();
        loadMixDirectory(root);
      }, 400);
    });

    root.querySelector("#createFollowBtn").addEventListener("click", () => openCreateFollow(topics));
  }

  async function loadMixDirectory(root) {
    const dirEl = root.querySelector("#mixDirectory");
    if (!dirEl) return;
    dirEl.innerHTML = stateBlock({ title: "Loading Follows", body: "", spin: true });
    const params = new URLSearchParams();
    if (followsState.topic) params.set("topic", followsState.topic);
    if (followsState.location) params.set("location", followsState.location);
    try {
      const mixes = await api("/api/mixes" + (params.toString() ? "?" + params.toString() : ""));
      if (!mixes || mixes.length === 0) {
        dirEl.innerHTML = stateBlock({ title: "No Follows match yet", body: "Try a different topic or place, or create your own." });
        return;
      }
      dirEl.innerHTML = mixes.map(mixCard).join("");
      dirEl.querySelectorAll("[data-mix-slug]").forEach((el) => {
        el.addEventListener("click", () => openMixDetail(el.dataset.mixSlug));
      });
    } catch (e) {
      dirEl.innerHTML = stateBlock({ title: "Couldn't load Follows", body: "Check your connection and try again." });
    }
  }

  function mixCard(m) {
    return `<div class="card mix-card" data-mix-slug="${escapeHtml(m.slug)}" style="cursor:pointer;">
      <h3 class="mix-name">${escapeHtml(m.name)}</h3>
      <div class="mix-meta">
        ${m.topic ? `<span>${escapeHtml(m.topic.name)}</span>` : ""}
        ${m.location_label ? `<span>${escapeHtml(m.location_label)}</span>` : ""}
        <span>${m.clone_count || 0} clones</span>
      </div>
    </div>`;
  }

  async function openMixDetail(slug) {
    const overlay = getOverlay();
    overlay.body.innerHTML = stateBlock({ title: "Loading", body: "", spin: true });
    overlay.title.textContent = "Follow";
    overlay.open();
    try {
      const mix = await api(`/api/mixes/${encodeURIComponent(slug)}`);
      overlay.title.textContent = mix.name;
      const items = (mix.items || []).slice(0, 40).map(dispatchCard).join("");
      const cloneBtn = currentUser
        ? `<button class="btn" id="cloneMixBtn">Copy this Follow into my account</button>`
        : `<p style="color:var(--muted);font-size:13px;">Sign in from the Account tab to copy this Follow.</p>`;
      overlay.body.innerHTML = `
        <div class="mix-meta" style="margin-bottom:16px;">
          ${mix.topic ? `<span>${escapeHtml(mix.topic.name)}</span>` : ""}
          ${mix.location_label ? `<span>${escapeHtml(mix.location_label)}</span>` : ""}
          <span>${mix.clone_count || 0} clones</span>
        </div>
        ${cloneBtn}
        <hr class="divider">
        ${items || stateBlock({ title: "No items yet", body: "This Follow's sources haven't published anything recently." })}
      `;
      overlay.body.querySelector("#cloneMixBtn")?.addEventListener("click", async () => {
        try {
          const r = await api(`/api/mixes/${encodeURIComponent(slug)}/clone`, { method: "POST" });
          toast(`Copied — ${r.outlets_added || 0} outlets, ${r.custom_added || 0} of your sources added.`);
        } catch (e) {
          toast(e.message || "Couldn't copy this Follow.");
        }
      });
    } catch (e) {
      overlay.body.innerHTML = stateBlock({ title: "Couldn't load this Follow", body: "It may have been removed." });
    }
  }

  async function openCreateFollow(topics) {
    if (!currentUser) {
      toast("Sign in from the Account tab first.");
      return;
    }
    const overlay = getOverlay();
    overlay.title.textContent = "Create a Follow";
    overlay.open();
    overlay.body.innerHTML = stateBlock({ title: "Loading your sources", body: "", spin: true });

    let sources = [], customSources = [];
    try {
      [sources, customSources] = await Promise.all([
        api("/api/sources"),
        api("/api/my/custom-sources"),
      ]);
    } catch (e) {
      overlay.body.innerHTML = stateBlock({ title: "Couldn't load sources", body: "Check your connection and try again." });
      return;
    }

    overlay.body.innerHTML = `
      <div class="field"><label for="mixName">Name</label><input type="text" id="mixName" placeholder="e.g. Ann Arbor Local News"></div>
      <div class="field"><label for="mixTopic">Topic (optional)</label>
        <select id="mixTopic"><option value="">— none —</option>${topics.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("")}</select>
      </div>
      <div class="field"><label for="mixLocation">Place (optional)</label><input type="text" id="mixLocation" placeholder="e.g. Ann Arbor, MI"></div>
      <div class="field"><label>Add your own RSS source</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="newCustomUrl" placeholder="https://..." style="flex:1;">
          <button class="btn small" id="addCustomBtn" type="button">Add</button>
        </div>
      </div>
      <div class="field"><label>Pick sources for this Follow</label>
        <div id="sourceChecks">${sources.map((s) => `<div class="checkbox-row"><input type="checkbox" value="outlet:${escapeHtml(s.outlet)}" id="src-${escapeHtml(s.outlet)}"><label for="src-${escapeHtml(s.outlet)}" style="margin:0;text-transform:none;font-family:var(--body);font-size:14px;color:var(--paper);">${escapeHtml(s.outlet)}</label></div>`).join("")}
        <div id="customSourceChecks">${customSources.map(customSourceRow).join("")}</div></div>
      </div>
      <div class="field checkbox-row"><input type="checkbox" id="mixPublic" checked><label for="mixPublic" style="margin:0;text-transform:none;font-family:var(--body);font-size:14px;color:var(--paper);">Make this Follow public (others can view/copy it)</label></div>
      <button class="btn" id="saveMixBtn">Save Follow</button>
    `;

    overlay.body.querySelector("#addCustomBtn").addEventListener("click", async () => {
      const urlInput = overlay.body.querySelector("#newCustomUrl");
      const url = urlInput.value.trim();
      if (!url) return;
      try {
        const created = await api("/api/my/custom-sources", { method: "POST", body: JSON.stringify({ feed_url: url }) });
        urlInput.value = "";
        overlay.body.querySelector("#customSourceChecks").insertAdjacentHTML("beforeend", customSourceRow(created));
        toast("Source added.");
      } catch (e) {
        toast(e.message || "Couldn't validate that feed.");
      }
    });

    overlay.body.querySelector("#saveMixBtn").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget;
      const name = overlay.body.querySelector("#mixName").value.trim();
      if (!name) { toast("Give this Follow a name first."); return; }
      const checked = [...overlay.body.querySelectorAll("#sourceChecks input:checked")].map((el) => el.value);
      if (checked.length === 0) { toast("Pick at least one source."); return; }
      const body = {
        name,
        topic_id: overlay.body.querySelector("#mixTopic").value || null,
        location_label: overlay.body.querySelector("#mixLocation").value.trim() || null,
        is_public: overlay.body.querySelector("#mixPublic").checked,
        sources: checked.map((v) => {
          const [type, id] = v.split(":");
          return type === "outlet" ? { source_type: "admin_outlet", outlet: id } : { source_type: "custom", custom_source_id: Number(id) };
        }),
      };
      btn.disabled = true;
      try {
        await api("/api/mixes", { method: "POST", body: JSON.stringify(body) });
        toast("Follow created.");
        overlay.close();
        loadMixDirectory(document.getElementById("view-follows"));
      } catch (e) {
        toast(e.message || "Couldn't save this Follow.");
      } finally {
        btn.disabled = false;
      }
    });
  }

  function customSourceRow(cs) {
    return `<div class="checkbox-row"><input type="checkbox" value="custom:${cs.id}" id="csrc-${cs.id}"><label for="csrc-${cs.id}" style="margin:0;text-transform:none;font-family:var(--body);font-size:14px;color:var(--paper);">${escapeHtml(cs.name)} <span style="color:var(--muted);">(yours)</span></label></div>`;
  }

  // ---------------------------------------------------------------------
  // ACCOUNT tab
  // ---------------------------------------------------------------------
  async function loadAccount(root) {
    await refreshSession();
    if (currentUser) {
      root.innerHTML = `
        <div class="account-signed-in">
          <span class="account-email">${escapeHtml(currentUser.email)}</span>
          <button class="btn secondary small" id="signOutBtn">Sign out</button>
        </div>
        <div class="section-eyebrow">Your sources</div>
        <div id="myCustomSources">${stateBlock({ title: "Loading", body: "", spin: true })}</div>
      `;
      root.querySelector("#signOutBtn").addEventListener("click", async () => {
        try { await api("/api/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
        setToken("");
        currentUser = null;
        loadAccount(root);
        toast("Signed out.");
      });
      loadMyCustomSources(root);
    } else {
      root.innerHTML = `
        <div class="section-eyebrow">Sign in</div>
        <p style="color:var(--muted);font-size:13px;margin:0 0 16px;">No password — we'll email you a link. Tap it and you're in, in this browser.</p>
        <div class="field"><label for="signInEmail">Email</label><input type="email" id="signInEmail" placeholder="you@example.com"></div>
        <button class="btn" id="sendLinkBtn">Send sign-in link</button>
        <p id="signInStatus" style="color:var(--muted);font-size:12px;margin-top:12px;"></p>
      `;
      root.querySelector("#sendLinkBtn").addEventListener("click", async (ev) => {
        const btn = ev.currentTarget;
        const email = root.querySelector("#signInEmail").value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Enter a valid email."); return; }
        btn.disabled = true;
        try {
          await api("/api/auth/request-link", { method: "POST", body: JSON.stringify({ email }) });
          root.querySelector("#signInStatus").textContent = "Check your email and tap the link — then come back to this tab.";
        } catch (e) {
          toast(e.message || "Couldn't send that link.");
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  async function loadMyCustomSources(root) {
    const el = root.querySelector("#myCustomSources");
    if (!el) return;
    try {
      const rows = await api("/api/my/custom-sources");
      if (!rows || rows.length === 0) {
        el.innerHTML = `<p style="color:var(--muted);font-size:13px;">No custom sources yet — add one when creating a Follow.</p>`;
        return;
      }
      el.innerHTML = rows.map((r) => `
        <div class="checkbox-row" style="border-bottom:1px solid var(--line);">
          <div style="flex:1;">
            <div style="font-size:14px;color:var(--paper);">${escapeHtml(r.name)}</div>
            <div style="font-family:var(--mono);font-size:11px;color:var(--muted);">${r.submission_status === "approved" ? "approved" : "pending review"}</div>
          </div>
          <button class="btn secondary small" data-remove="${r.id}">Remove</button>
        </div>`).join("");
      el.querySelectorAll("[data-remove]").forEach((btn) => btn.addEventListener("click", async () => {
        try {
          await api(`/api/my/custom-sources/${btn.dataset.remove}`, { method: "DELETE" });
          loadMyCustomSources(root);
        } catch (e) { toast("Couldn't remove that source."); }
      }));
    } catch (e) {
      el.innerHTML = `<p style="color:var(--muted);font-size:13px;">Couldn't load your sources.</p>`;
    }
  }

  // ---------------------------------------------------------------------
  // Overlay (mix detail / create follow)
  // ---------------------------------------------------------------------
  let overlayEl = null;
  function getOverlay() {
    if (overlayEl) return overlayEl;
    const div = document.createElement("div");
    div.className = "overlay";
    div.innerHTML = `<div class="overlay-header"><button class="overlay-back" aria-label="Back">←</button><span class="overlay-title"></span></div><div class="overlay-body"></div>`;
    document.body.appendChild(div);
    const title = div.querySelector(".overlay-title");
    const body = div.querySelector(".overlay-body");
    div.querySelector(".overlay-back").addEventListener("click", () => div.classList.remove("open"));
    overlayEl = {
      el: div, title, body,
      open: () => div.classList.add("open"),
      close: () => div.classList.remove("open"),
    };
    return overlayEl;
  }

  // ---------------------------------------------------------------------
  // Tab routing
  // ---------------------------------------------------------------------
  const TABS = ["wire", "follows", "videos", "account"];
  const loaders = { wire: loadWire, follows: loadFollows, videos: loadVideos, account: loadAccount };

  function ensureViewSections() {
    const root = document.getElementById("viewRoot");
    TABS.forEach((tab) => {
      const sec = document.createElement("section");
      sec.className = "view-section";
      sec.id = "view-" + tab;
      root.appendChild(sec);
    });
  }

  function activateTab(tab, { forceReload } = {}) {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".view-section").forEach((s) => s.classList.toggle("active", s.id === "view-" + tab));
    const root = document.getElementById("view-" + tab);
    if (forceReload) root.dataset.loaded = "";
    if (!root.dataset.loaded || tab === "account") loaders[tab](root, { fromCache: tab === "wire" });
    localStorage.setItem("n38_app_last_tab", tab);
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  async function init() {
    ensureViewSections();
    await refreshSession();

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => activateTab(btn.dataset.tab));
    });

    document.getElementById("refreshBtn").addEventListener("click", (ev) => {
      const btn = ev.currentTarget;
      btn.classList.add("spinning");
      const activeTab = TABS.find((t) => document.getElementById("view-" + t).classList.contains("active"));
      Promise.resolve(loaders[activeTab](document.getElementById("view-" + activeTab)))
        .finally(() => setTimeout(() => btn.classList.remove("spinning"), 300));
    });

    const startTab = TABS.includes(localStorage.getItem("n38_app_last_tab")) ? localStorage.getItem("n38_app_last_tab") : "wire";
    activateTab(startTab);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/app/sw.js").catch(() => { /* offline support is best-effort */ });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
