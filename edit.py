def sub(path, pairs):
    s=open(path,encoding="utf-8").read()
    for old,new in pairs:
        assert s.count(old)==1, (path, old[:70])
        s=s.replace(old,new)
    open(path,"w",encoding="utf-8").write(s)

# ---------------- server ----------------
sub("server.mjs",[
# markers also carry a single safe Support URL
("""    `SELECT outlet, is_corporate, parent_company FROM feeds WHERE outlet IN (${placeholders})`,
    outlets
  );
  return new Map(rows.map((r) => [r.outlet, { is_corporate: !!r.is_corporate, parent_company: r.parent_company || null }]));""",
"""    `SELECT outlet, is_corporate, parent_company, tip_url, subscribe_url FROM feeds WHERE outlet IN (${placeholders})`,
    outlets
  );
  // support_url: the outlet's tip link, else its subscribe link, http(s) only.
  // Corporate/conglomerate outlets get none (a subscribe page there is a
  // paywall pitch, not a tip jar).
  const safeUrl = (u) => (/^https?:\\/\\//i.test(String(u || "").trim()) ? String(u).trim() : null);
  return new Map(rows.map((r) => [r.outlet, {
    is_corporate: !!r.is_corporate,
    parent_company: r.parent_company || null,
    support_url: r.is_corporate ? null : safeUrl(r.tip_url) || safeUrl(r.subscribe_url),
  }]));"""),
("""        is_corporate: markers.get(r.outlet)?.is_corporate || false,
        parent_company: markers.get(r.outlet)?.parent_company || null,
      })),
      items,""",
"""        is_corporate: markers.get(r.outlet)?.is_corporate || false,
        parent_company: markers.get(r.outlet)?.parent_company || null,
        support_url: markers.get(r.outlet)?.support_url || null,
      })),
      items,"""),
("""        is_corporate: marker?.is_corporate || false,
        parent_company: marker?.parent_company || null,
      };
    }),
    items: [...customItems, ...dispatchItems],""",
"""        is_corporate: marker?.is_corporate || false,
        parent_company: marker?.parent_company || null,
        support_url: marker?.support_url || null,
      };
    }),
    items: [...customItems, ...dispatchItems],"""),
# share card text for support lists
("""      const by = packCurator(mix);
      const parts = [];
      if (by) parts.push(`A Pack from ${by}`);
      if (names.length) parts.push(`${names.join(", ")}${total > names.length ? ` and ${total - names.length} more` : ""}`);
      parts.push("Newest first. No algorithm.");
      desc = parts.join(" · ");""",
"""      const by = packCurator(mix);
      const parts = [];
      const isSupportList = /^\\s*publications i support\\s*$/i.test(mix.name || "");
      if (isSupportList && total > 0) {
        // A person's list of who they back: say that, with a source count (not a follower count).
        title = `${by ? `${by} backs` : "A reader backs"} ${total} publication${total === 1 ? "" : "s"} — SOURCE!`;
        if (names.length) parts.push(`${names.join(", ")}${total > names.length ? ` and ${total - names.length} more` : ""}`);
        parts.push("Make your own list on SOURCE!");
      } else {
        if (by) parts.push(`A Pack from ${by}`);
        if (names.length) parts.push(`${names.join(", ")}${total > names.length ? ` and ${total - names.length} more` : ""}`);
        parts.push("Newest first. No algorithm.");
      }
      desc = parts.join(" · ");"""),
])

# ---------------- client ----------------
sub("public/source/source.js",[
("""      <span class="tile-sheet-chip">${escapeHtml(s.outlet || s.name || "Custom source")}${s.is_corporate ? `<span class="source-corporate-mark" title="${escapeHtml(s.parent_company || "Corporate/conglomerate-owned")}">*</span>` : ""}</span>`).join("");""",
"""      <span class="tile-sheet-chip">${escapeHtml(s.outlet || s.name || "Custom source")}${s.is_corporate ? `<span class="source-corporate-mark" title="${escapeHtml(s.parent_company || "Corporate/conglomerate-owned")}">*</span>` : ""}${/^https?:\\/\\//i.test(s.support_url || "") ? `<a class="chip-support" href="${escapeHtml(s.support_url)}" target="_blank" rel="noopener noreferrer">Support</a>` : ""}</span>`).join("");"""),
("""        ${packShareButtonHtml(mix)}
        <a href="${location.origin}/api/mixes/${encodeURIComponent(mix.slug)}/rss" class="tile-sheet-rss" target="_blank" rel="noopener">📡 Subscribe via RSS</a>
        ${latest ?""",
"""        ${packShareButtonHtml(mix)}
        <button class="btn" id="packMakeOwnBtn" style="width:100%; margin-top:10px;">${isSupportList ? "Make your own list of publications you support" : "Make your own RSS Pack"}</button>
        <a href="${location.origin}/api/mixes/${encodeURIComponent(mix.slug)}/rss" class="tile-sheet-rss" target="_blank" rel="noopener">📡 Subscribe via RSS</a>
        ${latest ?"""),
("""    const following = (sprayBarData?.sprays || []).some(x => x.slug === mix.slug);
    const followLabel = !currentUser""",
"""    const isSupportList = /^\\s*publications i support\\s*$/i.test(mix.name || "");
    const following = (sprayBarData?.sprays || []).some(x => x.slug === mix.slug);
    const followLabel = !currentUser"""),
("""    wirePackShareButton(main, mix);
    document.getElementById("packFollowBtn")""",
"""    wirePackShareButton(main, mix);
    document.getElementById("packMakeOwnBtn").addEventListener("click", async () => {
      // Leave the ?pack= URL so a refresh doesn't bounce back to this page.
      try { history.replaceState(null, "", "/source/"); } catch (e) {}
      if (isSupportList) {
        await switchTab("you");
        const card = document.getElementById("youSupportCard");
        if (card && card.scrollIntoView) card.scrollIntoView({ block: "start" });
      } else {
        await switchTab("sources");
        openCreateFlow();
      }
    });
    document.getElementById("packFollowBtn")"""),
])

sub("public/source/source.css",[
(""".tile-sheet-chip {
  display: inline-flex;""",
""".chip-support {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-dim);
  text-decoration: underline;
  padding: 2px 6px 2px 2px;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
}
.tile-sheet-chip {
  display: inline-flex;"""),
])
t=open("public/source/sw.js").read().replace("-v95","-v96"); open("public/source/sw.js","w").write(t)
