// server.mjs — News for 38 Year Olds: minimal CMS + stats + wire feed
// Uses libSQL (Turso's client) instead of better-sqlite3 so the database
// lives outside the app's disk — survives redeploys, restarts, and Render's
// free-tier ephemeral filesystem. Falls back to a local file automatically
// when no TURSO_DATABASE_URL is set, so local dev needs no extra setup.
import express from "express";
import { createClient } from "@libsql/client";
import { XMLParser } from "fast-xml-parser";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "letmein";
const PORT = process.env.PORT || 3000;

const DB_URL = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, "n38.db")}`;
const client = createClient({
  url: DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN, // ignored/undefined for local file mode
});
console.log(`Database: ${DB_URL.startsWith("file:") ? "local file (dev mode)" : "remote Turso"}`);

// Safety net: a transient Turso hiccup on a single in-flight request
// (a brief 5xx, a dropped connection) shouldn't take the whole server down
// for every reader. Node crashes the process on an unhandled promise
// rejection by default — log it and keep serving everyone else instead.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (server staying up):", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server staying up):", err);
});

// ---------- Bluesky handle helper ----------
// Accepts a plain handle ("marisakabas.bsky.social"), an @-prefixed handle,
// or a full profile URL ("https://bsky.app/profile/marisakabas.bsky.social")
// and normalizes to the bare handle the AT Protocol API expects.
function normalizeHandle(input) {
  if (!input) return "";
  let h = String(input).trim();
  const urlMatch = h.match(/bsky\.app\/profile\/([^/?#\s]+)/i);
  if (urlMatch) h = urlMatch[1];
  return h.replace(/^@/, "").trim();
}

// ---------- thin helpers so the rest of the file reads like sync SQLite ----------
async function dbAll(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}
async function dbGet(sql, args = []) {
  const rows = await dbAll(sql, args);
  return rows[0];
}
async function dbRun(sql, args = []) {
  const res = await client.execute({ sql, args });
  return { lastInsertRowid: Number(res.lastInsertRowid ?? 0), changes: res.rowsAffected ?? 0 };
}

// ---------- schema ----------
async function initSchema() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      outlet TEXT NOT NULL,
      beat TEXT NOT NULL,
      date TEXT,
      headline TEXT NOT NULL,
      excerpt TEXT,
      link TEXT NOT NULL UNIQUE,
      tip_url TEXT,
      subscribe_url TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      view_type TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS tip_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id INTEGER,
      amount INTEGER,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS headlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      link TEXT,
      image_url TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      outlet TEXT NOT NULL,
      default_author TEXT,
      feed_url TEXT UNIQUE,
      tip_url TEXT,
      subscribe_url TEXT,
      fallback_beat TEXT NOT NULL DEFAULT 'Indie Media',
      beat_keywords TEXT NOT NULL DEFAULT '{}',
      items_per_feed INTEGER NOT NULL DEFAULT 3,
      feed_type TEXT NOT NULL DEFAULT 'outlet',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ---------- reader accounts (Phase 1: customizable feeds / Phase 2: ratings) ----------
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS login_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS user_feed_prefs (
      user_id INTEGER NOT NULL,
      outlet TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, outlet)
    )`,
    `CREATE TABLE IF NOT EXISTS user_source_ratings (
      user_id INTEGER NOT NULL,
      outlet TEXT NOT NULL,
      rating INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, outlet)
    )`,
  ];
  for (const sql of statements) await dbRun(sql);

  // migrate existing tables if they predate newer columns
  for (const stmt of [
    `ALTER TABLE dispatches ADD COLUMN tip_url TEXT`,
    `ALTER TABLE dispatches ADD COLUMN subscribe_url TEXT`,
    `ALTER TABLE feeds ADD COLUMN subscribe_url TEXT`,
    `ALTER TABLE feeds ADD COLUMN bluesky_handle TEXT`,
    `ALTER TABLE feeds ADD COLUMN feed_type TEXT NOT NULL DEFAULT 'outlet'`,
    `ALTER TABLE headlines ADD COLUMN subhead TEXT`,
  ]) {
    try { await dbRun(stmt); } catch { /* column already exists */ }
  }
}

// one-time migration: older deployments have `feed_url TEXT NOT NULL UNIQUE`,
// which blocks adding an outlet with only a Bluesky handle and no RSS feed.
// SQLite/libSQL can't drop a NOT NULL constraint with ALTER TABLE, so rebuild
// the table. Uses explicit column names on both sides so it's safe regardless
// of the physical column order any past ALTER TABLE ADD COLUMN left behind.
async function migrateFeedUrlNullable() {
  const cols = await dbAll(`PRAGMA table_info(feeds)`);
  const feedUrlCol = cols.find(c => c.name === "feed_url");
  if (!feedUrlCol || feedUrlCol.notnull === 0) return; // already nullable (or fresh install)
  console.log("Migrating feeds table: making feed_url nullable so Bluesky-only outlets can be added...");
  await dbRun(`ALTER TABLE feeds RENAME TO feeds_old`);
  await dbRun(`CREATE TABLE feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    outlet TEXT NOT NULL,
    default_author TEXT,
    feed_url TEXT UNIQUE,
    tip_url TEXT,
    subscribe_url TEXT,
    bluesky_handle TEXT,
    fallback_beat TEXT NOT NULL DEFAULT 'Indie Media',
    beat_keywords TEXT NOT NULL DEFAULT '{}',
    items_per_feed INTEGER NOT NULL DEFAULT 3,
    feed_type TEXT NOT NULL DEFAULT 'outlet',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  await dbRun(`
    INSERT INTO feeds (id, outlet, default_author, feed_url, tip_url, subscribe_url, bluesky_handle, fallback_beat, beat_keywords, items_per_feed, feed_type, created_at)
    SELECT id, outlet, default_author, feed_url, tip_url, subscribe_url, bluesky_handle, fallback_beat, beat_keywords, items_per_feed, feed_type, created_at FROM feeds_old
  `);
  await dbRun(`DROP TABLE feeds_old`);
  console.log("feeds table migration complete.");
}

// one-time migration: if feeds.json exists and the feeds table is empty, import it
async function migrateFeedsJsonIfNeeded() {
  const existing = (await dbGet(`SELECT COUNT(*) AS n FROM feeds`)).n;
  if (existing > 0) return;
  try {
    const feeds = JSON.parse(await readFile(path.join(__dirname, "feeds.json"), "utf8"));
    for (const f of feeds) {
      await dbRun(
        `INSERT OR IGNORE INTO feeds (outlet, default_author, feed_url, fallback_beat, beat_keywords, items_per_feed)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [f.outlet, f.defaultAuthor || "", f.feedUrl, f.fallbackBeat || "Indie Media", JSON.stringify(f.beatKeywords || {}), f.itemsPerFeed || 3]
      );
    }
    console.log(`Migrated ${feeds.length} feed(s) from feeds.json into the database.`);
  } catch { /* no feeds.json, nothing to migrate */ }
}

// one-time migration: old rows stored "Jul 18" style text which sorts
// alphabetically, not chronologically (e.g. "Jun" < "Jul" as text but
// scrambles once months mix). Convert those to sortable ISO dates.
async function migrateDateFormats() {
  const rows = await dbAll(`SELECT id, date FROM dispatches WHERE date IS NOT NULL AND date != ''`);
  let fixed = 0;
  for (const row of rows) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue; // already ISO
    const parsed = new Date(`${row.date}, 2026`);
    if (!isNaN(parsed)) {
      await dbRun(`UPDATE dispatches SET date = ? WHERE id = ?`, [parsed.toISOString().slice(0, 10), row.id]);
      fixed++;
    }
  }
  if (fixed) console.log(`Migrated ${fixed} dispatch date(s) to sortable ISO format.`);
}

// ---------- auto-seed on startup if the database is empty ----------
const STARTER_DISPATCHES = [
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Politics", date:"2026-07-08",
    headline:"The warning signs on a Maine Senate candidate were there long before the headline-grabbing allegation",
    excerpt:"A look at how a candidate's allies kept building him up as a model of positive masculinity while brushing off months of red flags.",
    link:"https://www.thehandbasket.co/p/graham-platner-rape-accusation-maine-senate", pinned:1 },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Courts & Rights", date:"2026-06-29",
    headline:"An exclusive excerpt on a former HUD attorney's fight against the administration",
    excerpt:"A book excerpt following one civil rights lawyer's decision to push back from inside the system.",
    link:"https://www.thehandbasket.co/p/on-courage-excerpt-paul-osadebe-julia-angwin-ami-fields-meyer" },
  { name:"Kim Kelly", outlet:"The Handbasket", beat:"Labor", date:"2026-06-26",
    headline:"A 19th-century labor massacre and a present-day prison sentence, read side by side",
    excerpt:"A guest essay drawing a line from the Haymarket affair to a recent, unusually harsh sentencing.",
    link:"https://www.thehandbasket.co/p/haymarket-prairieland-sentencing-kim-kelly" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Politics", date:"2026-06-24",
    headline:"How some progressive Jewish New Yorkers are decoupling their faith from Zionism at the ballot box",
    excerpt:"A dispatch on a shifting political identity taking shape in New York City primaries.",
    link:"https://www.thehandbasket.co/p/progressive-jewish-new-yorkers-brad-lander-primary" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Immigration", date:"2026-06-18",
    headline:"What it actually means that ICE is getting rid of seven detention warehouses",
    excerpt:"A Q&A digging into the real significance behind the agency shedding a batch of facilities.",
    link:"https://www.thehandbasket.co/p/ice-warehouses-offloading-project-salt-box-q-and-a" },
  { name:"Lee Hurley", outlet:"The Handbasket", beat:"Foreign Policy", date:"2026-06-16",
    headline:"Pinning Belfast's racist violence on one billionaire lets everyone else off the hook",
    excerpt:"A guest essay arguing a single online figure makes for a convenient scapegoat, but the causes run deeper.",
    link:"https://www.thehandbasket.co/p/elon-musk-belfast-pogrom-lee-hurley" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Media", date:"2026-06-03",
    headline:"Two very different paths for women in media, and what journalists actually owe people",
    excerpt:"A personal reflection comparing two contrasting career paths in journalism right now.",
    link:"https://www.thehandbasket.co/p/bari-weiss-cbs-scott-pelley-marisa-kabas" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Immigration", date:"2026-05-29",
    headline:"On the ground reporting from inside a violent ICE detention standoff in New Jersey",
    excerpt:"First-hand, on-site reporting on conditions and clashes at a New Jersey detention facility.",
    link:"https://www.thehandbasket.co/p/delaney-hall-hunger-strike-newark-new-jersey-ice-violence-protests" },
  { name:"Marisa Kabas", outlet:"The Handbasket", beat:"Courts & Rights", date:"2026-05-25",
    headline:"A conversation with one of the activists cleared after a grand jury misconduct finding",
    excerpt:"A Q&A with a member of a group of activists who had charges against them dropped.",
    link:"https://www.thehandbasket.co/p/kat-abughazaleh-broadview-six-grand-jury-charges-dropped" },
];

async function autoSeedIfEmpty() {
  const count = (await dbGet(`SELECT COUNT(*) AS n FROM dispatches`)).n;
  if (count > 0) return;
  let added = 0;
  for (const d of STARTER_DISPATCHES) {
    const info = await dbRun(
      `INSERT OR IGNORE INTO dispatches (name, outlet, beat, date, headline, excerpt, link, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.name, d.outlet, d.beat, d.date, d.headline, d.excerpt || "", d.link, d.pinned ? 1 : 0]
    );
    if (info.changes) added++;
  }
  console.log(`Auto-seeded ${added} starter dispatch(es) (database was empty).`);
}

// ---------- express app ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_PASSWORD) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---------- reader accounts (lightweight, no password — email magic link) ----------
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const SESSION_DAYS = 90;

function newToken(bytes = 24) {
  return randomBytes(bytes).toString("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  const secure = SITE_URL.startsWith("https") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `n38_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `n38_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Sends via Resend if RESEND_API_KEY is set; otherwise logs the link so local
// dev and early testing never require an email provider to be configured.
async function sendMagicLink(email, link) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[dev] Magic sign-in link for ${email}: ${link}`);
    return;
  }
  const from = process.env.RESEND_FROM || "News for 38 Year Olds <login@news38yearolds.com>";
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: email,
        subject: "Your sign-in link",
        html: `<p>Click to sign in to News for 38 Year Olds:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
      }),
    });
    if (!resp.ok) {
      console.error("Resend error:", await resp.text());
      console.log(`[fallback] Magic sign-in link for ${email}: ${link}`);
    }
  } catch (err) {
    console.error("Failed to send magic link email:", err.message);
    console.log(`[fallback] Magic sign-in link for ${email}: ${link}`);
  }
}

async function getCurrentUser(req) {
  const { n38_session } = parseCookies(req);
  if (!n38_session) return null;
  const row = await dbGet(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
    [n38_session]
  );
  return row || null;
}

app.post("/api/auth/request-link", async (req, res) => {
  const { email } = req.body || {};
  const normalized = (email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return res.status(400).json({ error: "valid email required" });
  }
  const token = newToken();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await dbRun(`INSERT INTO login_tokens (email, token, expires_at) VALUES (?, ?, ?)`, [normalized, token, expiresAt]);
  await sendMagicLink(normalized, `${SITE_URL}/api/auth/verify?token=${token}`);
  res.json({ ok: true });
});

app.get("/api/auth/verify", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Missing token.");
  const row = await dbGet(
    `SELECT * FROM login_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')`,
    [token]
  );
  if (!row) return res.status(400).send("This sign-in link is invalid or has expired. Go back and request a new one.");
  await dbRun(`UPDATE login_tokens SET used = 1 WHERE id = ?`, [row.id]);

  let user = await dbGet(`SELECT * FROM users WHERE email = ?`, [row.email]);
  if (!user) {
    const info = await dbRun(`INSERT INTO users (email) VALUES (?)`, [row.email]);
    user = { id: info.lastInsertRowid, email: row.email };
  }

  const sessionToken = newToken();
  const sessionExpires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await dbRun(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [sessionToken, user.id, sessionExpires]);

  setSessionCookie(res, sessionToken);
  res.redirect(302, "/");
});

app.post("/api/auth/logout", async (req, res) => {
  const { n38_session } = parseCookies(req);
  if (n38_session) await dbRun(`DELETE FROM sessions WHERE token = ?`, [n38_session]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const user = await getCurrentUser(req);
  res.json({ user: user ? { email: user.email } : null });
});

// ---------- reader feed preferences (Phase 1) ----------
app.get("/api/my/feed-prefs", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const rows = await dbAll(`SELECT outlet, enabled FROM user_feed_prefs WHERE user_id = ?`, [user.id]);
  res.json(rows);
});

app.post("/api/my/feed-prefs", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { prefs } = req.body || {};
  if (!Array.isArray(prefs)) return res.status(400).json({ error: "prefs must be an array" });
  for (const p of prefs) {
    if (!p.outlet) continue;
    await dbRun(
      `INSERT INTO user_feed_prefs (user_id, outlet, enabled) VALUES (?, ?, ?)
       ON CONFLICT(user_id, outlet) DO UPDATE SET enabled = excluded.enabled`,
      [user.id, p.outlet, p.enabled ? 1 : 0]
    );
  }
  res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) return res.json({ ok: true, token: ADMIN_PASSWORD });
  res.status(401).json({ ok: false });
});

// ---------- public read endpoints ----------
app.get("/api/dispatches", async (req, res) => {
  const { beat } = req.query;
  let rows = beat
    ? await dbAll(`SELECT * FROM dispatches WHERE beat = ? ORDER BY pinned DESC, date DESC, id DESC`, [beat])
    : await dbAll(`SELECT * FROM dispatches ORDER BY pinned DESC, date DESC, id DESC`);

  // Personalize for signed-in readers: if they've saved any feed prefs, only
  // show dispatches from outlets they've left enabled. No saved prefs yet
  // (new reader, or not signed in) means everyone sees the full wire — the
  // curated default never gets narrower without the reader opting in.
  const user = await getCurrentUser(req);
  if (user) {
    const prefRows = await dbAll(`SELECT outlet, enabled FROM user_feed_prefs WHERE user_id = ?`, [user.id]);
    if (prefRows.length > 0) {
      const allowed = new Set(prefRows.filter(r => r.enabled).map(r => r.outlet));
      rows = rows.filter(r => allowed.has(r.outlet));
    }
  }

  res.json(rows);
});

app.get("/api/sources", async (req, res) => {
  const rows = await dbAll(
    `SELECT outlet, default_author, subscribe_url, tip_url, feed_url, bluesky_handle, feed_type FROM feeds ORDER BY outlet ASC`
  );
  res.json(rows);
});

// ---------- "Most Popular on Bluesky" ----------
// Pulls each outlet's Bluesky posts from the last 24h via the public,
// no-auth AT Protocol AppView API, keeps ones that link out to an
// article, and ranks by engagement. Cached in memory so a burst of
// page views doesn't hammer Bluesky's public API on every request.
const BLUESKY_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
let blueskyCache = { data: [], fetchedAt: 0 };

async function fetchBlueskyPopular() {
  const feeds = await dbAll(
    `SELECT outlet, bluesky_handle, fallback_beat FROM feeds WHERE bluesky_handle IS NOT NULL AND bluesky_handle != ''`
  );
  const cutoff = Date.now() - 16 * 60 * 60 * 1000; // last 16h — wide enough to stay populated, tight enough to feel current

  const perOutlet = await Promise.allSettled(
    feeds.map(async (f) => {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(f.bluesky_handle)}&limit=30&filter=posts_no_replies`;
      const resp = await fetch(url, { headers: { "User-Agent": "n38-cms/1.0" } });
      if (!resp.ok) throw new Error(`Bluesky API ${resp.status} for ${f.bluesky_handle}`);
      const json = await resp.json();
      const items = [];
      for (const entry of json.feed || []) {
        const post = entry.post;
        if (!post || post.author?.handle !== f.bluesky_handle) continue; // skip reposts of others
        const createdAt = new Date(post.record?.createdAt || post.indexedAt).getTime();
        if (!createdAt || createdAt < cutoff) continue;
        const link = post.embed?.external?.uri || post.record?.embed?.external?.uri;
        if (!link) continue; // only posts sharing an external link
        const likeCount = post.likeCount || 0;
        const repostCount = post.repostCount || 0;
        const replyCount = post.replyCount || 0;
        items.push({
          outlet: f.outlet,
          section: f.fallback_beat || "Indie Media",
          text: (post.record?.text || "").slice(0, 260),
          link,
          blueskyUrl: `https://bsky.app/profile/${f.bluesky_handle}/post/${String(post.uri).split("/").pop()}`,
          likeCount, repostCount, replyCount,
          score: likeCount + repostCount * 2 + replyCount,
          createdAt,
        });
      }
      return items;
    })
  );

  const all = perOutlet.filter(r => r.status === "fulfilled").flatMap(r => r.value);
  perOutlet.filter(r => r.status === "rejected").forEach(r => console.error("Bluesky fetch failed:", r.reason?.message || r.reason));

  // de-dupe by link (multiple mentions of the same article), keep the highest-scoring post
  const byLink = new Map();
  for (const item of all) {
    const existing = byLink.get(item.link);
    if (!existing || item.score > existing.score) byLink.set(item.link, item);
  }
  return [...byLink.values()].sort((a, b) => b.score - a.score); // full ranked list; callers slice as needed
}

app.get("/api/bluesky-popular", async (req, res) => {
  try {
    const now = Date.now();
    if (now - blueskyCache.fetchedAt > BLUESKY_CACHE_TTL_MS) {
      const data = await fetchBlueskyPopular();
      blueskyCache = { data, fetchedAt: now };
    }
    res.json(blueskyCache.data.slice(0, 10));
  } catch (err) {
    console.error("Bluesky popular error:", err);
    res.json(blueskyCache.data.slice(0, 10)); // fail soft — never break the page over this
  }
});

// ---------- Nerve Center: full Bluesky trending + site engagement leaderboard ----------
// Public (no admin gate) — aggregate engagement numbers only, nothing sensitive.
// Reuses the same Bluesky cache as the homepage box (fetchBlueskyPopular pulls
// everything; the homepage box just slices the top 10 of the same cached list).
const VALID_NERVE_SECTIONS = ["Indie Media", "Data Centers", "People Power"];

app.get("/api/nerve-center/bluesky", async (req, res) => {
  try {
    const now = Date.now();
    if (now - blueskyCache.fetchedAt > BLUESKY_CACHE_TTL_MS) {
      const data = await fetchBlueskyPopular();
      blueskyCache = { data, fetchedAt: now };
    }
    const { section } = req.query;
    let data = blueskyCache.data;
    if (section && VALID_NERVE_SECTIONS.includes(section)) data = data.filter(i => i.section === section);
    res.json(data.slice(0, 40));
  } catch (err) {
    console.error("Nerve center Bluesky error:", err);
    res.json([]);
  }
});

app.get("/api/nerve-center/site", async (req, res) => {
  try {
    const { section } = req.query;
    const validSection = section && VALID_NERVE_SECTIONS.includes(section) ? section : null;
    const rows = await dbAll(
      `SELECT d.id, d.headline, d.outlet, d.name, d.beat, d.link, d.tip_url, d.subscribe_url, d.date,
              COUNT(DISTINCT c.id) AS clicks, COUNT(DISTINCT t.id) AS tip_clicks, COALESCE(SUM(t.amount),0) AS tip_amount
       FROM dispatches d
       LEFT JOIN clicks c ON c.dispatch_id = d.id
       LEFT JOIN tip_clicks t ON t.dispatch_id = d.id
       ${validSection ? "WHERE d.beat = ?" : ""}
       GROUP BY d.id
       ORDER BY clicks DESC, tip_clicks DESC
       LIMIT 40`,
      validSection ? [validSection] : []
    );
    res.json(rows);
  } catch (err) {
    console.error("Nerve center site error:", err);
    res.json([]);
  }
});

// ---------- Nerve Center: What are our journalists saying about today's big stories? ----------
// Pulls the Guardian US frontpage (our existing cached feed), then for each story
// extracts 2-3 meaningful keywords and scans our cached Bluesky posts for mentions.
// All matching is done server-side on already-cached data — zero extra API calls.

// Common words to skip when extracting keywords from a headline
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "is","are","was","were","be","been","being","have","has","had","do","does",
  "did","will","would","could","should","may","might","that","this","these",
  "those","it","its","by","as","from","about","into","than","then","so",
  "after","before","over","under","up","out","off","how","what","who","when",
  "where","which","why","not","no","new","says","said","say","us","their",
  "his","her","him","they","we","he","she","after","amid","report","reports",
]);

function extractKeywords(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w))
    .slice(0, 4); // top 4 meaningful words from the headline
}

function postMatchesKeywords(post, keywords) {
  if (!keywords.length) return false;
  const text = (post.text || "").toLowerCase();
  const matchCount = keywords.filter(kw => text.includes(kw)).length;
  // require at least 2 keyword hits, or 1 hit if the keyword is long/specific (>7 chars)
  return matchCount >= 2 || (matchCount === 1 && keywords.some(kw => kw.length > 7 && text.includes(kw)));
}

app.get("/api/nerve-center/chatter", async (req, res) => {
  try {
    // 1. Get the frontpage stories (already cached from the homepage Frontpage box)
    const stories = await getSimpleFeed("frontpage");
    if (!stories.length) return res.json([]);

    // 2. Get our journalists' Bluesky posts (already cached from the homepage box)
    const now = Date.now();
    if (now - blueskyCache.fetchedAt > BLUESKY_CACHE_TTL_MS) {
      const data = await fetchBlueskyPopular();
      blueskyCache = { data, fetchedAt: now };
    }
    const posts = blueskyCache.data;

    // 3. For each story, find any Bluesky posts from our journalists that match
    const result = stories.map(story => {
      const keywords = extractKeywords(story.title);
      const matches = posts.filter(post => postMatchesKeywords(post, keywords));
      return {
        story: story.title,
        storyLink: story.link,
        keywords,
        chatter: matches.map(p => ({
          outlet: p.outlet,
          text: p.text,
          blueskyUrl: p.blueskyUrl,
          likeCount: p.likeCount,
          repostCount: p.repostCount,
          replyCount: p.replyCount,
          score: p.score,
          createdAt: p.createdAt,
        })).sort((a, b) => b.score - a.score),
      };
    }).filter(s => s.chatter.length > 0); // only stories where someone in our network said something

    res.json(result);
  } catch (err) {
    console.error("Nerve center chatter error:", err);
    res.json([]);
  }
});

// ---------- Curated "title feed" boxes — Actions, Frontpage, Climate ----------
// All three just pull item titles+links from a public RSS/Atom feed and cache
// them for a while. Same shape, different sources, so one generic fetcher
// backs all the routes below. `max` lets a box run longer/shorter than the rest.
const SIMPLE_FEEDS = {
  actions: { url: "https://susanrogan.substack.com/feed", max: 12 },       // Rogan's List — longer box per Jason's request
  frontpage: { url: "https://www.theguardian.com/us-news/rss", max: 8 },  // Guardian US — Scott Trust owned since 1936, structurally billionaire-proof
  climate: { url: "https://www.theguardian.com/environment/climate-crisis/rss", max: 8 }, // Guardian Climate Crisis feed
};
const SIMPLE_FEED_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const simpleFeedCache = Object.fromEntries(
  Object.keys(SIMPLE_FEEDS).map(key => [key, { data: [], fetchedAt: 0 }])
);

async function fetchSimpleFeed(url, max) {
  const r = await fetch(url, { headers: { "User-Agent": "n38-cms/1.0 (+https://news-for-38-year-olds.onrender.com)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const xml = await r.text();
  const parsed = xmlParser.parse(xml);
  const items = extractItems(parsed);
  return items
    .filter(it => it.title && it.link)
    .slice(0, max || 8)
    .map(it => ({ title: stripHtml(it.title), link: it.link }));
}

async function getSimpleFeed(key) {
  const now = Date.now();
  const cache = simpleFeedCache[key];
  if (now - cache.fetchedAt > SIMPLE_FEED_CACHE_TTL_MS) {
    try {
      const data = await fetchSimpleFeed(SIMPLE_FEEDS[key].url, SIMPLE_FEEDS[key].max);
      simpleFeedCache[key] = { data, fetchedAt: now };
    } catch (err) {
      console.error(`${key} feed error:`, err.message);
      // leave the stale cache in place and try again on the next request
    }
  }
  return simpleFeedCache[key].data;
}

app.get("/api/actions-feed", async (req, res) => res.json(await getSimpleFeed("actions")));
app.get("/api/frontpage-feed", async (req, res) => res.json(await getSimpleFeed("frontpage")));
app.get("/api/climate-feed", async (req, res) => res.json(await getSimpleFeed("climate")));

app.get("/go/:id", async (req, res) => {
  const row = await dbGet(`SELECT link FROM dispatches WHERE id = ?`, [req.params.id]);
  if (!row) return res.status(404).send("Not found");
  await dbRun(`INSERT INTO clicks (dispatch_id) VALUES (?)`, [req.params.id]);
  res.redirect(302, row.link);
});

app.post("/api/track-view", async (req, res) => {
  const { view_type } = req.body || {};
  await dbRun(`INSERT INTO page_views (view_type) VALUES (?)`, [view_type || "unknown"]);
  res.json({ ok: true });
});

app.post("/api/track-tip", async (req, res) => {
  const { dispatch_id, amount } = req.body || {};
  await dbRun(`INSERT INTO tip_clicks (dispatch_id, amount) VALUES (?, ?)`, [dispatch_id || null, amount || 0]);
  res.json({ ok: true });
});

// ---------- admin write endpoints: dispatches ----------
app.post("/api/dispatches", requireAdmin, async (req, res) => {
  const { name, outlet, beat, date, headline, excerpt, link, tip_url, subscribe_url, pinned } = req.body;
  if (!name || !outlet || !beat || !headline || !link) {
    return res.status(400).json({ error: "name, outlet, beat, headline, and link are required" });
  }
  try {
    const info = await dbRun(
      `INSERT INTO dispatches (name, outlet, beat, date, headline, excerpt, link, tip_url, subscribe_url, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, outlet, beat, date || "", headline, excerpt || "", link, tip_url || "", subscribe_url || "", pinned ? 1 : 0]
    );
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/dispatches/:id", requireAdmin, async (req, res) => {
  const { name, outlet, beat, date, headline, excerpt, link, tip_url, subscribe_url, pinned } = req.body;
  await dbRun(
    `UPDATE dispatches SET name=?, outlet=?, beat=?, date=?, headline=?, excerpt=?, link=?, tip_url=?, subscribe_url=?, pinned=? WHERE id=?`,
    [name, outlet, beat, date || "", headline, excerpt || "", link, tip_url || "", subscribe_url || "", pinned ? 1 : 0, req.params.id]
  );
  res.json({ ok: true });
});

app.delete("/api/dispatches/:id", requireAdmin, async (req, res) => {
  await dbRun(`DELETE FROM dispatches WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// ---------- editor headlines (always manual, never from feeds) ----------
app.get("/api/headlines", async (req, res) => {
  const rows = await dbAll(`SELECT * FROM headlines ORDER BY sort_order ASC, id ASC`);
  res.json(rows);
});

app.post("/api/headlines", requireAdmin, async (req, res) => {
  const { text, subhead, link, image_url, sort_order } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  const info = await dbRun(
    `INSERT INTO headlines (text, subhead, link, image_url, sort_order) VALUES (?, ?, ?, ?, ?)`,
    [text, subhead || "", link || "", image_url || "", sort_order || 0]
  );
  res.json({ id: info.lastInsertRowid });
});

app.put("/api/headlines/:id", requireAdmin, async (req, res) => {
  const { text, subhead, link, image_url, sort_order } = req.body;
  await dbRun(
    `UPDATE headlines SET text=?, subhead=?, link=?, image_url=?, sort_order=? WHERE id=?`,
    [text, subhead || "", link || "", image_url || "", sort_order || 0, req.params.id]
  );
  res.json({ ok: true });
});

app.delete("/api/headlines/:id", requireAdmin, async (req, res) => {
  await dbRun(`DELETE FROM headlines WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// ---------- stats ----------
app.get("/api/stats", requireAdmin, async (req, res) => {
  const totalDispatches = (await dbGet(`SELECT COUNT(*) AS n FROM dispatches`)).n;
  const totalClicks = (await dbGet(`SELECT COUNT(*) AS n FROM clicks`)).n;
  const totalTips = await dbGet(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM tip_clicks`);
  const viewsByType = await dbAll(`SELECT view_type, COUNT(*) AS n FROM page_views GROUP BY view_type`);
  const topByClicks = await dbAll(
    `SELECT d.id, d.headline, d.outlet, d.name, COUNT(c.id) AS clicks
     FROM dispatches d LEFT JOIN clicks c ON c.dispatch_id = d.id
     GROUP BY d.id ORDER BY clicks DESC LIMIT 10`
  );
  const bySection = await dbAll(
    `SELECT d.beat, COUNT(DISTINCT d.id) AS stories, COUNT(c.id) AS clicks
     FROM dispatches d LEFT JOIN clicks c ON c.dispatch_id = d.id
     GROUP BY d.beat ORDER BY clicks DESC`
  );
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

// ---------- feed import helpers ----------
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Some feeds (long-form show notes, entity-heavy WordPress exports, etc.)
  // legitimately contain more than the library's default 1000 entity
  // expansions. Raised generously — still bounded, so this isn't reopening
  // the entity-bomb DoS the limit exists to prevent.
  processEntities: { maxTotalExpansions: 20000 },
});

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
  return isNaN(d) ? "" : d.toISOString().slice(0, 10); // sortable ISO date, e.g. "2026-07-18"
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

// ---------- feeds (DB-backed, managed from the admin UI) ----------
app.get("/api/feeds", requireAdmin, async (req, res) => {
  const rows = await dbAll(`SELECT * FROM feeds ORDER BY outlet ASC`);
  res.json(rows);
});

app.post("/api/feeds", requireAdmin, async (req, res) => {
  const { outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, items_per_feed, bluesky_handle, feed_type } = req.body;
  const handle = normalizeHandle(bluesky_handle);
  const type = feed_type === "journalist" ? "journalist" : "outlet";
  if (!outlet) return res.status(400).json({ error: "outlet is required" });
  if (type === "journalist" && !handle) return res.status(400).json({ error: "journalist feeds need a Bluesky handle" });
  if (type === "outlet" && !feed_url && !handle) return res.status(400).json({ error: "outlet is required, and either feed_url or bluesky_handle" });
  try {
    const info = await dbRun(
      `INSERT INTO feeds (outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, beat_keywords, items_per_feed, bluesky_handle, feed_type)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      [outlet, default_author || "", type === "journalist" ? null : (feed_url || null), tip_url || "", subscribe_url || "", fallback_beat || "Indie Media", items_per_feed || 3, handle, type]
    );
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/feeds/bulk", requireAdmin, async (req, res) => {
  const { feeds } = req.body;
  if (!Array.isArray(feeds) || feeds.length === 0) {
    return res.status(400).json({ error: "feeds must be a non-empty array" });
  }
  let added = 0;
  const errors = [];
  for (const f of feeds) {
    const handle = normalizeHandle(f.bluesky_handle);
    const type = f.feed_type === "journalist" ? "journalist" : "outlet";
    if (!f.outlet) {
      errors.push(`Skipped a row — outlet name is required: ${JSON.stringify(f)}`);
      continue;
    }
    if (type === "journalist" && !handle) {
      errors.push(`Skipped ${f.outlet} — journalist rows need a Bluesky handle.`);
      continue;
    }
    if (type === "outlet" && !f.feed_url && !handle) {
      errors.push(`Skipped a row — needs outlet plus either a feed URL or a Bluesky handle: ${JSON.stringify(f)}`);
      continue;
    }
    try {
      await dbRun(
        `INSERT INTO feeds (outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, beat_keywords, items_per_feed, bluesky_handle, feed_type)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
        [f.outlet, f.default_author || "", type === "journalist" ? null : (f.feed_url || null), f.tip_url || "", f.subscribe_url || "", f.fallback_beat || "Indie Media", f.items_per_feed || 3, handle, type]
      );
      added++;
    } catch (err) {
      errors.push(`${f.outlet}: ${err.message}`);
    }
  }
  res.json({ added, errors });
});

app.put("/api/feeds/:id", requireAdmin, async (req, res) => {
  const { outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, items_per_feed, bluesky_handle, feed_type } = req.body;
  const handle = normalizeHandle(bluesky_handle);
  const type = feed_type === "journalist" ? "journalist" : "outlet";
  if (!outlet) return res.status(400).json({ error: "outlet is required" });
  if (type === "journalist" && !handle) return res.status(400).json({ error: "journalist feeds need a Bluesky handle" });
  if (type === "outlet" && !feed_url && !handle) return res.status(400).json({ error: "outlet is required, and either feed_url or bluesky_handle" });
  try {
    await dbRun(
      `UPDATE feeds SET outlet=?, default_author=?, feed_url=?, tip_url=?, subscribe_url=?, fallback_beat=?, items_per_feed=?, bluesky_handle=?, feed_type=?
       WHERE id=?`,
      [outlet, default_author || "", type === "journalist" ? null : (feed_url || null), tip_url || "", subscribe_url || "", fallback_beat || "Indie Media", items_per_feed || 3, handle, type, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/feeds/:id", requireAdmin, async (req, res) => {
  await dbRun(`DELETE FROM feeds WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

async function importAllFeeds() {
  const feeds = await dbAll(`SELECT * FROM feeds`);
  if (feeds.length === 0) return { added: 0, errors: ["No feeds configured yet — add one below."] };

  let added = 0;
  const errors = [];
  for (const feed of feeds) {
    if (!feed.feed_url || feed.feed_type === "journalist") continue; // Bluesky-only journalist, no wire column
    try {
      const r = await fetch(feed.feed_url, { headers: { "User-Agent": "n38-cms/1.0" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const xml = await r.text();
      const parsed = xmlParser.parse(xml);
      const beatKeywords = JSON.parse(feed.beat_keywords || "{}");
      const items = extractItems(parsed).slice(0, feed.items_per_feed || 3);
      for (const item of items) {
        const headline = stripHtml(item.title);
        const excerpt = truncate(stripHtml(item.summary), 160);
        if (!headline || !item.link) continue;
        const info = await dbRun(
          `INSERT OR IGNORE INTO dispatches (name, outlet, beat, date, headline, excerpt, link, tip_url, subscribe_url) VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            item.author?.trim() || feed.default_author || feed.outlet,
            feed.outlet,
            pickBeat(`${headline} ${excerpt}`, beatKeywords, feed.fallback_beat || "Indie Media"),
            formatDate(item.pubDate),
            headline,
            excerpt,
            item.link,
            feed.tip_url || "",
            feed.subscribe_url || "",
          ]
        );
        if (info.changes) added++;
      }
    } catch (err) {
      errors.push(`${feed.outlet}: ${err.message}`);
    }
  }
  return { added, errors };
}

app.post("/api/import-feeds", requireAdmin, async (req, res) => {
  const result = await importAllFeeds();
  res.json(result);
});

// ---------- scheduled auto-import ----------
const AUTO_IMPORT_MINUTES = Number(process.env.AUTO_IMPORT_MINUTES || 180);
if (AUTO_IMPORT_MINUTES > 0) {
  setInterval(async () => {
    const result = await importAllFeeds();
    console.log(`Auto-import: added ${result.added} dispatch(es).` + (result.errors.length ? ` Errors: ${result.errors.join("; ")}` : ""));
  }, AUTO_IMPORT_MINUTES * 60 * 1000);
}

// ---------- startup ----------
async function start() {
  // Turso can occasionally return a transient 5xx (a host blip, a brief
  // reconnect) — retry the whole startup sequence with backoff instead of
  // crashing outright on the first hiccup. If it's a real, sustained outage
  // this still eventually exits (so Render's own restart/alerting kicks in),
  // it just doesn't give up after a single bad request.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await initSchema();
      await migrateFeedUrlNullable();
      await migrateFeedsJsonIfNeeded();
      await migrateDateFormats();
      await autoSeedIfEmpty();
      app.listen(PORT, () => console.log(`News for 38 Year Olds CMS running on http://localhost:${PORT}`));
      return;
    } catch (err) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      console.error(`Startup attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      if (isLastAttempt) {
        console.error("Giving up after repeated startup failures — the database (Turso) may be down. Check its status/dashboard.");
        throw err;
      }
      const delayMs = Math.min(2000 * 2 ** (attempt - 1), 20000); // 2s, 4s, 8s, 16s, capped at 20s
      console.log(`Retrying startup in ${delayMs / 1000}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
start();
