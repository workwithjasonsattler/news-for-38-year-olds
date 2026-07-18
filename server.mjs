// server.mjs — News for 38 Year Olds: minimal CMS + stats + wire feed
import express from "express";
import Database from "better-sqlite3";
import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "letmein";
const PORT = process.env.PORT || 3000;

const db = new Database(path.join(__dirname, "n38.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS dispatches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    outlet TEXT NOT NULL,
    beat TEXT NOT NULL,
    date TEXT,
    headline TEXT NOT NULL,
    excerpt TEXT,
    link TEXT NOT NULL UNIQUE,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id INTEGER NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(dispatch_id) REFERENCES dispatches(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS page_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    view_type TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tip_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id INTEGER,
    amount INTEGER,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------- auto-seed on startup if the database is empty ----------
// Render's free tier resets the disk on spin-down/redeploy, so instead of
// relying on a separate `node seed.mjs` step, the server seeds itself.
const STARTER_DISPATCHES = [
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Politics", date:"Jul 8",
    headline:"The warning signs on a Maine Senate candidate were there long before the headline-grabbing allegation",
    excerpt:"A look at how a candidate's allies kept building him up as a model of positive masculinity while brushing off months of red flags.",
    link:"https://www.thehandbasket.co/p/graham-platner-rape-accusation-maine-senate", pinned:1 },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Courts & Rights", date:"Jun 29",
    headline:"An exclusive excerpt on a former HUD attorney's fight against the administration",
    excerpt:"A book excerpt following one civil rights lawyer's decision to push back from inside the system.",
    link:"https://www.thehandbasket.co/p/on-courage-excerpt-paul-osadebe-julia-angwin-ami-fields-meyer" },
  { name:"Kim Kelly", outlet:"The Handbasket", beat:"Labor", date:"Jun 26",
    headline:"A 19th-century labor massacre and a present-day prison sentence, read side by side",
    excerpt:"A guest essay drawing a line from the Haymarket affair to a recent, unusually harsh sentencing.",
    link:"https://www.thehandbasket.co/p/haymarket-prairieland-sentencing-kim-kelly" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Politics", date:"Jun 24",
    headline:"How some progressive Jewish New Yorkers are decoupling their faith from Zionism at the ballot box",
    excerpt:"A dispatch on a shifting political identity taking shape in New York City primaries.",
    link:"https://www.thehandbasket.co/p/progressive-jewish-new-yorkers-brad-lander-primary" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Immigration", date:"Jun 18",
    headline:"What it actually means that ICE is getting rid of seven detention warehouses",
    excerpt:"A Q&A digging into the real significance behind the agency shedding a batch of facilities.",
    link:"https://www.thehandbasket.co/p/ice-warehouses-offloading-project-salt-box-q-and-a" },
  { name:"Lee Hurley", outlet:"The Handbasket", beat:"Foreign Policy", date:"Jun 16",
    headline:"Pinning Belfast's racist violence on one billionaire lets everyone else off the hook",
    excerpt:"A guest essay arguing a single online figure makes for a convenient scapegoat, but the causes run deeper.",
    link:"https://www.thehandbasket.co/p/elon-musk-belfast-pogrom-lee-hurley" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Media", date:"Jun 3",
    headline:"Two very different paths for women in media, and what journalists actually owe people",
    excerpt:"A personal reflection comparing two contrasting career paths in journalism right now.",
    link:"https://www.thehandbasket.co/p/bari-weiss-cbs-scott-pelley-marisa-kabas" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Immigration", date:"May 29",
    headline:"On the ground reporting from inside a violent ICE detention standoff in New Jersey",
    excerpt:"First-hand, on-site reporting on conditions and clashes at a New Jersey detention facility.",
    link:"https://www.thehandbasket.co/p/delaney-hall-hunger-strike-newark-new-jersey-ice-violence-protests" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Courts & Rights", date:"May 25",
    headline:"A conversation with one of the activists cleared after a grand jury misconduct finding",
    excerpt:"A Q&A with a member of a group of activists who had charges against them dropped.",
    link:"https://www.thehandbasket.co/p/kat-abughazaleh-broadview-six-grand-jury-charges-dropped" },
];

function autoSeedIfEmpty() {
  const count = db.prepare(`SELECT COUNT(*) AS n FROM dispatches`).get().n;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO dispatches (name, outlet, beat, date, headline, excerpt, link, pinned)
    VALUES (@name, @outlet, @beat, @date, @headline, @excerpt, @link, @pinned)
  `);
  let added = 0;
  for (const d of STARTER_DISPATCHES) {
    const info = insert.run({ pinned: 0, excerpt: "", ...d });
    if (info.changes) added++;
  }
  console.log(`Auto-seeded ${added} starter dispatch(es) (database was empty).`);
}
autoSeedIfEmpty();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- admin auth (simple shared-password header check) ----------
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) return res.json({ ok: true, token: ADMIN_PASSWORD });
  res.status(401).json({ ok: false });
});

// ---------- public read endpoints ----------
app.get("/api/dispatches", (req, res) => {
  const { beat } = req.query;
  const rows = beat
    ? db.prepare(`SELECT * FROM dispatches WHERE beat = ? ORDER BY pinned DESC, date DESC, id DESC`).all(beat)
    : db.prepare(`SELECT * FROM dispatches ORDER BY pinned DESC, date DESC, id DESC`).all();
  res.json(rows);
});

app.get("/go/:id", (req, res) => {
  const row = db.prepare(`SELECT link FROM dispatches WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).send("Not found");
  db.prepare(`INSERT INTO clicks (dispatch_id) VALUES (?)`).run(req.params.id);
  res.redirect(302, row.link);
});

app.post("/api/track-view", (req, res) => {
  const { view_type } = req.body || {};
  db.prepare(`INSERT INTO page_views (view_type) VALUES (?)`).run(view_type || "unknown");
  res.json({ ok: true });
});

app.post("/api/track-tip", (req, res) => {
  const { dispatch_id, amount } = req.body || {};
  db.prepare(`INSERT INTO tip_clicks (dispatch_id, amount) VALUES (?, ?)`).run(dispatch_id || null, amount || 0);
  res.json({ ok: true });
});

// ---------- admin write endpoints ----------
app.post("/api/dispatches", requireAdmin, (req, res) => {
  const { name, outlet, beat, date, headline, excerpt, link, pinned } = req.body;
  if (!name || !outlet || !beat || !headline || !link) {
    return res.status(400).json({ error: "name, outlet, beat, headline, and link are required" });
  }
  try {
    const info = db
      .prepare(`INSERT INTO dispatches (name, outlet, beat, date, headline, excerpt, link, pinned)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(name, outlet, beat, date || "", headline, excerpt || "", link, pinned ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/dispatches/:id", requireAdmin, (req, res) => {
  const { name, outlet, beat, date, headline, excerpt, link, pinned } = req.body;
  db.prepare(
    `UPDATE dispatches SET name=?, outlet=?, beat=?, date=?, headline=?, excerpt=?, link=?, pinned=? WHERE id=?`
  ).run(name, outlet, beat, date || "", headline, excerpt || "", link, pinned ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/dispatches/:id", requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM dispatches WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- stats ----------
app.get("/api/stats", requireAdmin, (req, res) => {
  const totalDispatches = db.prepare(`SELECT COUNT(*) AS n FROM dispatches`).get().n;
  const totalClicks = db.prepare(`SELECT COUNT(*) AS n FROM clicks`).get().n;
  const totalTips = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM tip_clicks`).get();
  const viewsByType = db
    .prepare(`SELECT view_type, COUNT(*) AS n FROM page_views GROUP BY view_type`)
    .all();
  const topByClicks = db
    .prepare(
      `SELECT d.id, d.headline, d.outlet, d.name, COUNT(c.id) AS clicks
       FROM dispatches d LEFT JOIN clicks c ON c.dispatch_id = d.id
       GROUP BY d.id ORDER BY clicks DESC LIMIT 10`
    )
    .all();
  const bySection = db
    .prepare(
      `SELECT d.beat, COUNT(DISTINCT d.id) AS stories, COUNT(c.id) AS clicks
       FROM dispatches d LEFT JOIN clicks c ON c.dispatch_id = d.id
       GROUP BY d.beat ORDER BY clicks DESC`
    )
    .all();
  res.json({
    totalDispatches,
    totalClicks,
    totalTipClicks: totalTips.n,
    totalTipAmountEstimate: totalTips.sum,
    viewsByType,
    topByClicks,
    bySection,
  });
});

// ---------- feed import (reuses the standalone ingest logic) ----------
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });

function textOf(field) {
  if (field == null) return "";
  if (typeof field === "string") return field;
  if (typeof field === "object") return field["#text"] ?? "";
  return String(field);
}
function stripHtml(str = "") {
  return str.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "'").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ").trim();
}
function truncate(str, max = 160) {
  return str.length <= max ? str : str.slice(0, max).replace(/\s+\S*$/, "") + "…";
}
function formatDate(pubDate) {
  const d = new Date(pubDate);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function pickBeat(text, beatKeywords = {}, fallbackBeat = "General") {
  const lower = text.toLowerCase();
  for (const [beat, kws] of Object.entries(beatKeywords)) {
    if (kws.some((k) => lower.includes(k.toLowerCase()))) return beat;
  }
  return fallbackBeat;
}
function extractItems(parsed) {
  const rssItems = parsed?.rss?.channel?.item;
  if (rssItems) {
    const items = Array.isArray(rssItems) ? rssItems : [rssItems];
    return items.map((it) => ({
      title: textOf(it.title), link: textOf(it.link),
      pubDate: textOf(it.pubDate ?? it["dc:date"]),
      author: textOf(it["dc:creator"] ?? it.author),
      summary: textOf(it.description ?? it["content:encoded"]),
    }));
  }
  const atomEntries = parsed?.feed?.entry;
  if (atomEntries) {
    const entries = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    return entries.map((e) => {
      const linkField = Array.isArray(e.link) ? e.link[0] : e.link;
      return {
        title: textOf(e.title), link: (linkField && linkField["@_href"]) || textOf(linkField),
        pubDate: textOf(e.updated ?? e.published), author: textOf(e.author?.name),
        summary: textOf(e.summary ?? e.content),
      };
    });
  }
  return [];
}

app.post("/api/import-feeds", requireAdmin, async (req, res) => {
  let feeds;
  try {
    feeds = JSON.parse(await readFile(path.join(__dirname, "feeds.json"), "utf8"));
  } catch {
    return res.status(400).json({ error: "feeds.json not found or invalid" });
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO dispatches (name, outlet, beat, date, headline, excerpt, link) VALUES (?,?,?,?,?,?,?)`
  );
  let added = 0;
  const errors = [];
  for (const feed of feeds) {
    try {
      const r = await fetch(feed.feedUrl, { headers: { "User-Agent": "n38-cms/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await r.text();
      const parsed = xmlParser.parse(xml);
      const items = extractItems(parsed).slice(0, feed.itemsPerFeed || 3);
      for (const item of items) {
        const headline = stripHtml(item.title);
        const excerpt = truncate(stripHtml(item.summary), 160);
        if (!headline || !item.link) continue;
        const info = insert.run(
          item.author?.trim() || feed.defaultAuthor || feed.outlet,
          feed.outlet,
          pickBeat(`${headline} ${excerpt}`, feed.beatKeywords, feed.fallbackBeat || "General"),
          formatDate(item.pubDate),
          headline,
          excerpt,
          item.link
        );
        if (info.changes) added++;
      }
    } catch (err) {
      errors.push(`${feed.outlet}: ${err.message}`);
    }
  }
  res.json({ added, errors });
});

app.listen(PORT, () => console.log(`News for 38 Year Olds CMS running on http://localhost:${PORT}`));
