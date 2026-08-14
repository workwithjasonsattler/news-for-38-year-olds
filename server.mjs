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

// ---------- YouTube channel identifier helper ----------
// Accepts a raw channel ID ("UCxxxxxxxxxxxxxxxxxxxxxx"), an @handle (with or
// without the @ or a full youtube.com URL), or a legacy /user//c/ URL, and
// strips it down to the bare identifier resolveYoutubeUploadsPlaylist() expects.
function normalizeYoutubeChannel(input) {
  if (!input) return "";
  let h = String(input).trim();
  const channelUrlMatch = h.match(/youtube\.com\/channel\/([^/?#\s]+)/i);
  if (channelUrlMatch) return channelUrlMatch[1];
  const handleUrlMatch = h.match(/youtube\.com\/@([^/?#\s]+)/i);
  if (handleUrlMatch) h = handleUrlMatch[1];
  else {
    const legacyUrlMatch = h.match(/youtube\.com\/(?:user|c)\/([^/?#\s]+)/i);
    if (legacyUrlMatch) h = legacyUrlMatch[1];
  }
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
    // Phase 2: "conscious filtering" — readers set an explicit tier per
    // source (pinned/normal/less/hidden) rather than an algorithm inferring
    // a score. `rating` stores the tier as TEXT (SQLite has no strict
    // column typing, so re-using this pre-existing column is safe).
    `CREATE TABLE IF NOT EXISTS user_source_ratings (
      user_id INTEGER NOT NULL,
      outlet TEXT NOT NULL,
      rating TEXT NOT NULL DEFAULT 'normal',
      PRIMARY KEY (user_id, outlet)
    )`,
    // ---------- Super RSS Reader: reader-submitted custom sources ----------
    // A signed-in reader's own "bring your own RSS" list. Deliberately
    // separate from the curated `feeds` table and NOT touched by the 20-min
    // import job — an unvetted feed (malformed XML, redirect loop, hostile
    // content) must never be able to degrade the pipeline that powers the
    // main curated wire. `submission_status` gates visibility in a public,
    // shareable mix (future work) — it does NOT gate a reader's own wire;
    // an unapproved custom source still powers the reader's own view
    // immediately, same as it's their own reading list.
    `CREATE TABLE IF NOT EXISTS user_custom_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      feed_url TEXT NOT NULL,
      validated INTEGER NOT NULL DEFAULT 0,
      submission_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, feed_url)
    )`,
    // ---------- Super RSS Reader, Session 2: Mixes ----------
    // A reader's named, shareable snapshot of curated + custom sources.
    // Public directory + view + clone, per SCOPING-super-rss-reader doc.
    `CREATE TABLE IF NOT EXISTS feed_mixes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      creator_user_id INTEGER NOT NULL,
      location_label TEXT,
      is_public INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS feed_mix_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mix_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      outlet TEXT,
      custom_source_id INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`,
    // ---------- Follows: curated Topics taxonomy ----------
    // A real, growing, named taxonomy (like Indie Media/Data Centers/People
    // Power) — NOT a free-text tag. Readers can propose new topics; proposals
    // land as 'pending' and aren't selectable/browsable until an admin
    // approves, same queue-and-approve pattern as YouTube channels and
    // custom RSS sources.
    `CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      suggested_by_user_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ---------- View & layout preferences ----------
    // Which visual skin (Drudge-ish/BBS/RSS Reader/Right Wing) and which
    // homepage sections a signed-in reader wants to see. Anonymous readers
    // still get this via localStorage only (frontend-only, no row here) —
    // this table is just the cross-device save for registered readers.
    `CREATE TABLE IF NOT EXISTS user_layout_prefs (
      user_id INTEGER PRIMARY KEY,
      view TEXT NOT NULL DEFAULT 'drudge',
      hidden_components TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    // ---------- Thumbs-up (personal ranking, Feature B) ----------
    // A reader thumbs-up a source; togglable (thumbs again = remove). Only
    // ever affects THAT reader's own wire ordering (as a same-day tiebreak
    // ahead of recency, never a full re-sort) — the shared/default Wire for
    // everyone else is completely untouched. Aggregate counts across all
    // readers are surfaced as a transparent, read-only leaderboard in the
    // Sources box; seeing the leaderboard never changes anyone's own order.
    `CREATE TABLE IF NOT EXISTS feed_thumbs (
      user_id INTEGER NOT NULL,
      outlet TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, outlet)
    )`,
    // ---------- Bluesky bot posting log ----------
    // Tracks what the headlines bot has already posted so nothing double-
    // posts across restarts/cache misses — same "just a tracking table"
    // philosophy as feed_thumbs/clone_count elsewhere in this codebase.
    `CREATE TABLE IF NOT EXISTS bluesky_bot_posts (
      dispatch_id INTEGER PRIMARY KEY,
      posted_at TEXT NOT NULL DEFAULT (datetime('now')),
      bluesky_post_uri TEXT
    )`,
    // Small reusable key/value table for single-value bot state that needs
    // to survive restarts (e.g. "what was the last roundup post's URL") —
    // deliberately generic so future single-value bot state doesn't need
    // its own one-off table each time.
    `CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT
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
    `ALTER TABLE feeds ADD COLUMN youtube_channel_id TEXT`,
    `ALTER TABLE feeds ADD COLUMN submission_status TEXT NOT NULL DEFAULT 'approved'`,
    `ALTER TABLE headlines ADD COLUMN subhead TEXT`,
    `ALTER TABLE feed_mixes ADD COLUMN topic_id INTEGER`,
    `ALTER TABLE feed_mixes ADD COLUMN clone_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE feed_mixes ADD COLUMN is_official INTEGER NOT NULL DEFAULT 0`,
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
    youtube_channel_id TEXT,
    submission_status TEXT NOT NULL DEFAULT 'approved',
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

// ---------- curated starting YouTube channel list ----------
// Jason's confirmed list. Two entries (Democracy Now!, Degenerate Art) have
// no @handle on YouTube, so they're stored as their legacy username / raw
// channel ID instead — see SESSION-NOTES-youtube-video-feed for how each
// was resolved.
const STARTER_YOUTUBE_CHANNELS = [
  { outlet: "More Perfect Union", youtube_channel_id: "moreperfectunion" },
  { outlet: "Democracy Now!", youtube_channel_id: "democracynow" },
  { outlet: "Degenerate Art", youtube_channel_id: "UCGbfp7gMn8nk0SUTb9ooCuw" },
  { outlet: "PBS NewsHour", youtube_channel_id: "PBSNewsHour" },
  { outlet: "MS NOW", youtube_channel_id: "msnow" },
  { outlet: "Second Thought", youtube_channel_id: "SecondThought" },
  { outlet: "emptywheel", youtube_channel_id: "emptywheel" },
  { outlet: "The Daily Show", youtube_channel_id: "TheDailyShow" },
  { outlet: "Last Week Tonight", youtube_channel_id: "LastWeekTonight" },
  { outlet: "Majority Report", youtube_channel_id: "TheMajorityReport" },
];

// Idempotent: matches an existing outlet by name (case-insensitive) first
// and just attaches a channel id if it's missing one, rather than creating
// ---------- Sprays® Branding: official "Headlines: Best in the World" ----------
// The flagship Spray. Per the locked decision, this is NOT a hand-picked
// subset — it IS the existing default blend of curated outlets already
// powering the unfiltered Wire, auto-synced rather than a separately
// maintained source list that could drift out of sync. It's implemented as
// a single seeded, unchanging feed_mixes row (is_official=1) whose actual
// sources/items are resolved LIVE at request time in resolveMixSources()
// (see below) rather than stored in feed_mix_sources — so there is nothing
// to keep in sync, it always reflects whatever outlets currently have
// dispatches live.
const OFFICIAL_HEADLINES_SPRAY_SLUG = "headlines-best-in-the-world";
async function seedOfficialHeadlinesSpray() {
  const existing = await dbGet(`SELECT id FROM feed_mixes WHERE slug = ?`, [OFFICIAL_HEADLINES_SPRAY_SLUG]);
  if (existing) return;
  // creator_user_id has no FK constraint; 0 is a safe "system" sentinel since
  // real users.id starts at 1 (AUTOINCREMENT) and never reaches 0.
  await dbRun(
    `INSERT INTO feed_mixes (slug, name, creator_user_id, location_label, is_public, is_official)
     VALUES (?, 'Headlines: Best in the World', 0, NULL, 1, 1)`,
    [OFFICIAL_HEADLINES_SPRAY_SLUG]
  );
}

// a duplicate row. Only inserts a new row when no matching outlet exists.
async function seedYoutubeChannels() {
  const existingFeeds = await dbAll(`SELECT id, outlet, youtube_channel_id FROM feeds`);
  const byOutletLower = new Map(existingFeeds.map(f => [f.outlet.toLowerCase(), f]));
  let attached = 0, inserted = 0;
  for (const ch of STARTER_YOUTUBE_CHANNELS) {
    const match = byOutletLower.get(ch.outlet.toLowerCase());
    if (match) {
      if (!match.youtube_channel_id) {
        await dbRun(`UPDATE feeds SET youtube_channel_id = ? WHERE id = ?`, [ch.youtube_channel_id, match.id]);
        attached++;
      }
      continue;
    }
    await dbRun(
      `INSERT INTO feeds (outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, beat_keywords, items_per_feed, bluesky_handle, feed_type, youtube_channel_id, submission_status)
       VALUES (?, '', NULL, '', '', 'Indie Media', '{}', 3, '', 'outlet', ?, 'approved')`,
      [ch.outlet, ch.youtube_channel_id]
    );
    inserted++;
  }
  if (attached || inserted) console.log(`YouTube channel seed: attached ${attached} to existing outlets, inserted ${inserted} new row(s).`);
}

// Degenerate Art's beehiiv RSS URL has been stale/erroring since it was
// added and Jason confirmed this is effectively permanent (beehiiv appears
// to be blocking non-browser traffic on this feed) — dropping the RSS pull
// entirely rather than continuing to retry a dead feed. The outlet row and
// its YouTube channel (seeded above) stay intact; this only clears feed_url
// so the 20-min import job stops attempting it. Idempotent: no-ops once
// feed_url is already null.
async function dropDegenerateArtRss() {
  const result = await dbRun(
    `UPDATE feeds SET feed_url = NULL WHERE outlet = 'Degenerate Art' AND feed_url IS NOT NULL`
  );
  if (result.changes) console.log("Dropped Degenerate Art's stale beehiiv RSS feed_url (permanent block, per Jason).");
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

// Resolves a session token from EITHER the existing cookie OR an
// `Authorization: Bearer <token>` header — both paths point at the same
// `sessions` table row, this is not a second auth system, just a second
// way to present the same session token (for the future mobile app shell,
// which can't reliably carry cookie sessions in a native webview).
function getAuthToken(req) {
  const { n38_session } = parseCookies(req);
  if (n38_session) return n38_session;
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function getCurrentUser(req) {
  const token = getAuthToken(req);
  if (!token) return null;
  const row = await dbGet(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`,
    [token]
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

  // Mobile/app-shell clients ask for JSON explicitly via ?format=json (more
  // robust than relying on an Accept header, which some webviews mangle).
  // The cookie above is still set either way (harmless for a bearer client),
  // but a JSON caller gets the raw token back to store and send as
  // `Authorization: Bearer <token>` on subsequent requests.
  const wantsJson = req.query.format === "json" || (req.headers.accept || "").includes("application/json");
  if (wantsJson) {
    return res.json({ ok: true, token: sessionToken, user: { email: user.email } });
  }
  res.redirect(302, "/");
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getAuthToken(req);
  if (token) await dbRun(`DELETE FROM sessions WHERE token = ?`, [token]);
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

// ---------- reader source tiers (Phase 2: conscious filtering, not an algorithm) ----------
// Readers set an explicit tier per source instead of a hidden score:
//   pinned  -> always sorts first (within admin-pinned breaking items)
//   normal  -> default, sorts by time like today
//   less    -> still shows, sinks toward the bottom
//   hidden  -> filtered out entirely (same effect as old feed-prefs "off")
const VALID_TIERS = new Set(["pinned", "normal", "less", "hidden"]);

app.get("/api/my/source-tiers", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const rows = await dbAll(`SELECT outlet, rating AS tier FROM user_source_ratings WHERE user_id = ?`, [user.id]);
  res.json(rows);
});

app.post("/api/my/source-tiers", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const { tiers } = req.body || {};
  if (!Array.isArray(tiers)) return res.status(400).json({ error: "tiers must be an array" });
  for (const t of tiers) {
    if (!t.outlet || !VALID_TIERS.has(t.tier)) continue;
    await dbRun(
      `INSERT INTO user_source_ratings (user_id, outlet, rating) VALUES (?, ?, ?)
       ON CONFLICT(user_id, outlet) DO UPDATE SET rating = excluded.rating`,
      [user.id, t.outlet, t.tier]
    );
  }
  res.json({ ok: true });
});

// ---------- View & layout preferences ----------
// Lets a signed-in reader save which visual skin + which homepage sections
// they want, so it follows them across devices. Anonymous readers get the
// same picker but it only persists to localStorage on their own browser
// (handled entirely client-side — nothing hits these routes when signed out).
const VALID_VIEWS = new Set(["drudge", "bbs", "rss", "rightwing"]);

// hidden_components historically stored a flat array of hidden keys, e.g.
// ["videos","resources"]. It now stores { hidden: [...], order: [...] } so a
// reader can also reorder sections, not just hide them. Old rows saved before
// this feature existed are still a plain array — parseLayoutBlob() normalizes
// either shape into { hidden, order } so nothing breaks on old saved prefs.
function parseLayoutBlob(raw){
  let parsed = [];
  try { parsed = JSON.parse(raw || "[]"); } catch { /* ignore */ }
  if (Array.isArray(parsed)) return { hidden: parsed, order: [] };
  if (parsed && typeof parsed === "object") {
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      order: Array.isArray(parsed.order) ? parsed.order : [],
    };
  }
  return { hidden: [], order: [] };
}

app.get("/api/my/layout-prefs", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const row = await dbGet(`SELECT view, hidden_components FROM user_layout_prefs WHERE user_id = ?`, [user.id]);
  if (!row) return res.json({ saved: false });
  const { hidden, order } = parseLayoutBlob(row.hidden_components);
  res.json({ saved: true, view: row.view || "drudge", hiddenComponents: hidden, order });
});

app.post("/api/my/layout-prefs", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  let { view, hiddenComponents, order } = req.body || {};
  if (!VALID_VIEWS.has(view)) view = "drudge";
  if (!Array.isArray(hiddenComponents)) hiddenComponents = [];
  hiddenComponents = hiddenComponents
    .filter(c => typeof c === "string" && c.length <= 50)
    .slice(0, 20);
  if (!Array.isArray(order)) order = [];
  order = order
    .filter(c => typeof c === "string" && c.length <= 50)
    .slice(0, 20);
  const blob = JSON.stringify({ hidden: hiddenComponents, order });
  await dbRun(
    `INSERT INTO user_layout_prefs (user_id, view, hidden_components, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET view = excluded.view, hidden_components = excluded.hidden_components, updated_at = excluded.updated_at`,
    [user.id, view, blob]
  );
  res.json({ ok: true });
});

// ---------- Super RSS Reader: reader-submitted custom sources ----------
// "Bring your own RSS." Validated live (fetch + parse) before saving so
// typos/dead feeds never get stored. Fetched on-demand and cached BY URL
// (not per-user) with a short TTL — five readers adding the same local
// paper's feed only triggers one fetch — and completely separate from the
// curated `feeds` table / 20-min import job (see schema comment above).
const CUSTOM_SOURCE_CAP = 50; // per reader
const CUSTOM_SOURCE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes — shorter than the curated 20-min cycle since these aren't pre-warmed by a background job
const customSourceCache = new Map(); // feed_url -> { data, fetchedAt }

async function fetchCustomSourceItems(feedUrl) {
  const cached = customSourceCache.get(feedUrl);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CUSTOM_SOURCE_CACHE_TTL_MS) return cached.data;

  const resp = await fetch(feedUrl, {
    headers: { "User-Agent": "n38-cms/1.0 (+https://news-for-38-year-olds.onrender.com)" },
    signal: AbortSignal.timeout(8000), // a slow/hanging custom feed must not stall the request that triggered it
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const xml = await resp.text();
  const parsed = xmlParser.parse(xml);
  const items = extractItems(parsed)
    .filter((it) => it.title && it.link)
    .slice(0, 10)
    .map((it) => ({ title: stripHtml(it.title), link: it.link, pubDate: it.pubDate || null }));

  customSourceCache.set(feedUrl, { data: items, fetchedAt: now });
  return items;
}

app.get("/api/my/custom-sources", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const rows = await dbAll(
    `SELECT id, name, feed_url, submission_status, created_at FROM user_custom_sources WHERE user_id = ? ORDER BY created_at DESC`,
    [user.id]
  );
  res.json(rows);
});

app.post("/api/my/custom-sources", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });

  const feedUrl = String(req.body?.feed_url || "").trim();
  const name = String(req.body?.name || "").trim();
  if (!feedUrl) return res.status(400).json({ error: "feed_url is required" });
  if (!/^https?:\/\//i.test(feedUrl)) return res.status(400).json({ error: "feed_url must be a valid http(s) URL" });

  const count = (await dbGet(`SELECT COUNT(*) AS n FROM user_custom_sources WHERE user_id = ?`, [user.id])).n;
  if (count >= CUSTOM_SOURCE_CAP) {
    return res.status(400).json({ error: `You've reached the ${CUSTOM_SOURCE_CAP}-source limit for custom feeds.` });
  }

  const existing = await dbGet(`SELECT id FROM user_custom_sources WHERE user_id = ? AND feed_url = ?`, [user.id, feedUrl]);
  if (existing) return res.status(409).json({ error: "You've already added that source." });

  try {
    // fast-xml-parser doesn't reject non-RSS HTML/XML outright — it just
    // yields zero items — so require at least one parsed item to count as
    // "actually a feed" rather than trusting a 200 status alone.
    const items = await fetchCustomSourceItems(feedUrl); // also warms the cache for this URL
    if (items.length === 0) throw new Error("no items found");
  } catch (err) {
    return res.status(400).json({ error: "Couldn't read that as an RSS/Atom feed — double-check the URL." });
  }

  let sourceName = name;
  if (!sourceName) {
    try { sourceName = new URL(feedUrl).hostname.replace(/^www\./, ""); }
    catch { sourceName = feedUrl; }
  }

  const info = await dbRun(
    `INSERT INTO user_custom_sources (user_id, name, feed_url, validated, submission_status) VALUES (?, ?, ?, 1, 'pending')`,
    [user.id, sourceName, feedUrl]
  );
  res.json({ id: info.lastInsertRowid, name: sourceName, feed_url: feedUrl });
});

app.delete("/api/my/custom-sources/:id", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  await dbRun(`DELETE FROM user_custom_sources WHERE id = ? AND user_id = ?`, [req.params.id, user.id]);
  res.json({ ok: true });
});

// ---------- Super RSS Reader, Session 2: Mixes ----------
// A reader's named, shareable snapshot of curated + custom sources. Public
// directory browsing (GET /api/mixes?location=) is Session 3 — this session
// covers save / view / clone only, per the locked scoping doc.
const MIX_SOURCE_CAP = 25; // per mix, Jason's call

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "mix";
}

async function generateUniqueMixSlug(name) {
  const base = slugify(name);
  const existing = await dbGet(`SELECT id FROM feed_mixes WHERE slug = ?`, [base]);
  if (!existing) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${newToken(3)}`;
    const clash = await dbGet(`SELECT id FROM feed_mixes WHERE slug = ?`, [candidate]);
    if (!clash) return candidate;
  }
  return `${base}-${newToken(5)}`; // astronomically unlikely to still clash
}

// Resolves a mix's saved sources into live wire items — admin_outlet rows
// pull from the curated `dispatches` table (already fetched by the 20-min
// import job), custom rows fetch on-demand via the same cached helper used
// for a reader's own wire. `includePending` shows a mix owner their own
// not-yet-approved custom sources (still their own reading list); public
// viewers only ever see approved ones, matching decision #5 in the scoping
// doc — approval gates visibility in OTHERS' view, not the owner's own.
async function resolveMixSources(mix, { includePending = false } = {}) {
  // mix may be passed as either the full row (preferred) or a bare id for
  // backward compatibility with any caller that hasn't been updated.
  const mixId = typeof mix === "object" ? mix.id : mix;
  const isOfficial = typeof mix === "object" && !!mix.is_official;

  if (isOfficial) {
    // Auto-synced: sources = every outlet actually contributing to the
    // current unfiltered wire right now (not a stored, driftable list).
    const outletRows = await dbAll(`SELECT DISTINCT outlet FROM dispatches ORDER BY outlet ASC`);
    const items = await dbAll(`SELECT * FROM dispatches ORDER BY pinned DESC, date DESC, id DESC LIMIT 60`);
    return {
      sources: outletRows.map((r) => ({ source_type: "admin_outlet", outlet: r.outlet, pending: false })),
      items,
    };
  }

  const sourceRows = await dbAll(
    `SELECT fms.*, ucs.name AS custom_name, ucs.feed_url AS custom_feed_url, ucs.submission_status AS custom_status
     FROM feed_mix_sources fms
     LEFT JOIN user_custom_sources ucs ON ucs.id = fms.custom_source_id
     WHERE fms.mix_id = ? ORDER BY fms.sort_order ASC, fms.id ASC`,
    [mixId]
  );

  const outletNames = sourceRows.filter((s) => s.source_type === "admin_outlet").map((s) => s.outlet);
  const customRows = sourceRows.filter((s) => s.source_type === "custom" && s.custom_feed_url &&
    (includePending || s.custom_status === "approved"));

  let dispatchItems = [];
  if (outletNames.length > 0) {
    const placeholders = outletNames.map(() => "?").join(",");
    dispatchItems = await dbAll(
      `SELECT * FROM dispatches WHERE outlet IN (${placeholders}) ORDER BY pinned DESC, date DESC, id DESC LIMIT 60`,
      outletNames
    );
  }

  let customItems = [];
  if (customRows.length > 0) {
    const results = await Promise.allSettled(
      customRows.map(async (cs) => {
        const items = await fetchCustomSourceItems(cs.custom_feed_url);
        return items.map((it) => ({
          id: `mix-custom-${cs.custom_source_id}-${Buffer.from(it.link).toString("base64url").slice(0, 16)}`,
          name: cs.custom_name,
          outlet: cs.custom_name,
          beat: "Custom",
          date: formatDate(it.pubDate),
          headline: it.title,
          excerpt: null,
          link: it.link,
          tip_url: null,
          subscribe_url: null,
          pinned: 0,
        }));
      })
    );
    results.filter((r) => r.status === "rejected").forEach((r) => console.error("Mix custom source fetch failed:", r.reason?.message || r.reason));
    customItems = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  }

  return {
    sources: sourceRows.map((s) => ({
      source_type: s.source_type,
      outlet: s.source_type === "admin_outlet" ? s.outlet : s.custom_name,
      pending: s.source_type === "custom" && s.custom_status !== "approved",
    })),
    items: [...customItems, ...dispatchItems],
  };
}

app.post("/api/mixes", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });

  const name = String(req.body?.name || "").trim();
  const locationLabel = req.body?.location_label ? String(req.body.location_label).trim().slice(0, 100) : null;
  const isPublic = req.body?.is_public === false ? 0 : 1; // default public
  const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];

  if (!name) return res.status(400).json({ error: "name is required" });
  if (sources.length === 0) return res.status(400).json({ error: "a mix needs at least one source" });
  if (sources.length > MIX_SOURCE_CAP) return res.status(400).json({ error: `mixes are capped at ${MIX_SOURCE_CAP} sources` });

  // Topic is optional (a mix can be Local, Topical, or neither), but if
  // given, must reference an APPROVED topic — a pending/proposed topic
  // can't be tagged onto a mix until an admin has signed off on it.
  let topicId = null;
  if (req.body?.topic_id !== undefined && req.body.topic_id !== null) {
    const topic = await dbGet(`SELECT id FROM topics WHERE id = ? AND status = 'approved'`, [req.body.topic_id]);
    if (!topic) return res.status(400).json({ error: "Unknown or unapproved topic" });
    topicId = topic.id;
  }

  // Validate every source up front so a mix never half-saves.
  const validated = [];
  for (const s of sources) {
    if (s.source_type === "admin_outlet") {
      const outlet = String(s.outlet || "").trim();
      if (!outlet) return res.status(400).json({ error: "admin_outlet source missing outlet name" });
      const exists = await dbGet(`SELECT id FROM feeds WHERE outlet = ? AND submission_status = 'approved'`, [outlet]);
      if (!exists) return res.status(400).json({ error: `Unknown source: ${outlet}` });
      validated.push({ source_type: "admin_outlet", outlet, custom_source_id: null });
    } else if (s.source_type === "custom") {
      const csId = Number(s.custom_source_id);
      if (!csId) return res.status(400).json({ error: "custom source missing custom_source_id" });
      const owned = await dbGet(`SELECT id FROM user_custom_sources WHERE id = ? AND user_id = ?`, [csId, user.id]);
      if (!owned) return res.status(400).json({ error: "you can only add your own custom sources to a mix" });
      validated.push({ source_type: "custom", outlet: null, custom_source_id: csId });
    } else {
      return res.status(400).json({ error: `unknown source_type: ${s.source_type}` });
    }
  }

  const slug = await generateUniqueMixSlug(name);
  const info = await dbRun(
    `INSERT INTO feed_mixes (slug, name, creator_user_id, location_label, is_public, topic_id) VALUES (?, ?, ?, ?, ?, ?)`,
    [slug, name, user.id, locationLabel, isPublic, topicId]
  );
  for (let i = 0; i < validated.length; i++) {
    const v = validated[i];
    await dbRun(
      `INSERT INTO feed_mix_sources (mix_id, source_type, outlet, custom_source_id, sort_order) VALUES (?, ?, ?, ?, ?)`,
      [info.lastInsertRowid, v.source_type, v.outlet, v.custom_source_id, i]
    );
  }
  res.json({ id: info.lastInsertRowid, slug, name, location_label: locationLabel, is_public: !!isPublic, topic_id: topicId });
});

app.put("/api/mixes/:slug", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });

  const mix = await dbGet(`SELECT * FROM feed_mixes WHERE slug = ?`, [req.params.slug]);
  if (!mix) return res.status(404).json({ error: "mix not found" });
  if (mix.creator_user_id !== user.id) return res.status(403).json({ error: "not your mix" });

  const name = req.body?.name !== undefined ? String(req.body.name).trim() : mix.name;
  const locationLabel = req.body?.location_label !== undefined
    ? (req.body.location_label ? String(req.body.location_label).trim().slice(0, 100) : null)
    : mix.location_label;
  const isPublic = req.body?.is_public !== undefined ? (req.body.is_public ? 1 : 0) : mix.is_public;
  if (!name) return res.status(400).json({ error: "name is required" });

  let topicId = mix.topic_id;
  if (req.body?.topic_id !== undefined) {
    if (req.body.topic_id === null) {
      topicId = null;
    } else {
      const topic = await dbGet(`SELECT id FROM topics WHERE id = ? AND status = 'approved'`, [req.body.topic_id]);
      if (!topic) return res.status(400).json({ error: "Unknown or unapproved topic" });
      topicId = topic.id;
    }
  }

  await dbRun(
    `UPDATE feed_mixes SET name = ?, location_label = ?, is_public = ?, topic_id = ?, updated_at = datetime('now') WHERE id = ?`,
    [name, locationLabel, isPublic, topicId, mix.id]
  );

  // Sources are optional on edit — only replace them if the caller sent a
  // sources array at all, so a plain "rename this mix" call doesn't need to
  // re-send the whole source list.
  if (Array.isArray(req.body?.sources)) {
    const sources = req.body.sources;
    if (sources.length === 0) return res.status(400).json({ error: "a mix needs at least one source" });
    if (sources.length > MIX_SOURCE_CAP) return res.status(400).json({ error: `mixes are capped at ${MIX_SOURCE_CAP} sources` });
    const validated = [];
    for (const s of sources) {
      if (s.source_type === "admin_outlet") {
        const outlet = String(s.outlet || "").trim();
        const exists = outlet && await dbGet(`SELECT id FROM feeds WHERE outlet = ? AND submission_status = 'approved'`, [outlet]);
        if (!exists) return res.status(400).json({ error: `Unknown source: ${outlet}` });
        validated.push({ source_type: "admin_outlet", outlet, custom_source_id: null });
      } else if (s.source_type === "custom") {
        const csId = Number(s.custom_source_id);
        const owned = csId && await dbGet(`SELECT id FROM user_custom_sources WHERE id = ? AND user_id = ?`, [csId, user.id]);
        if (!owned) return res.status(400).json({ error: "you can only add your own custom sources to a mix" });
        validated.push({ source_type: "custom", outlet: null, custom_source_id: csId });
      } else {
        return res.status(400).json({ error: `unknown source_type: ${s.source_type}` });
      }
    }
    await dbRun(`DELETE FROM feed_mix_sources WHERE mix_id = ?`, [mix.id]);
    for (let i = 0; i < validated.length; i++) {
      const v = validated[i];
      await dbRun(
        `INSERT INTO feed_mix_sources (mix_id, source_type, outlet, custom_source_id, sort_order) VALUES (?, ?, ?, ?, ?)`,
        [mix.id, v.source_type, v.outlet, v.custom_source_id, i]
      );
    }
  }

  res.json({ ok: true, slug: mix.slug });
});

app.get("/api/mixes/:slug", async (req, res) => {
  const mix = await dbGet(`SELECT * FROM feed_mixes WHERE slug = ?`, [req.params.slug]);
  if (!mix) return res.status(404).json({ error: "mix not found" });

  const user = await getCurrentUser(req);
  const isOwner = !!(user && user.id === mix.creator_user_id);
  if (!mix.is_public && !isOwner) return res.status(404).json({ error: "mix not found" });

  const topic = mix.topic_id ? await dbGet(`SELECT name, slug FROM topics WHERE id = ?`, [mix.topic_id]) : null;
  const { sources, items } = await resolveMixSources(mix, { includePending: isOwner });
  res.json({
    slug: mix.slug,
    name: mix.name,
    location_label: mix.location_label,
    is_public: !!mix.is_public,
    is_owner: isOwner,
    is_official: !!mix.is_official,
    created_at: mix.created_at,
    clone_count: mix.clone_count,
    topic: topic ? { name: topic.name, slug: topic.slug } : null,
    sources,
    items,
  });
});

// RSS output for any PUBLIC Spray/Mix (general capability, not Headlines-
// only — see SCOPING-headlines-rss-bluesky-bot.md Part 1, Q2, "recommend
// building it general"). Reuses the exact same resolveMixSources() live
// query every web/app Spray view already uses — no new data source, just
// an XML serialization layer. Short-TTL cache, fails soft: if the
// underlying query throws, serve the last good cached XML rather than a
// broken feed, since a silently-stale-but-valid feed is far better
// behavior for RSS readers/aggregators than one that starts erroring on
// every poll (most readers just quietly drop a feed that errors).
const RSS_FEED_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RSS_FEED_ITEM_CAP = 100; // more history than the 60-item web view, matches RSS-reader convention
const rssFeedCache = new Map(); // slug -> { xml, fetchedAt }

function escapeXml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRfc822(dateLike) {
  const d = new Date(dateLike);
  return isNaN(d) ? new Date().toUTCString() : d.toUTCString();
}

function buildMixRssXml(mix, items) {
  const channelTitle = mix.is_official ? `${mix.name} — News for 38 Year Olds` : `${mix.name} — a Spray on News for 38 Year Olds`;
  const channelLink = `${SITE_URL}/spray.html?spray=${encodeURIComponent(mix.slug)}`;
  const channelDesc = mix.is_official
    ? "The official flagship Spray — every outlet currently powering the unfiltered Wire, auto-synced in real time."
    : `A reader-created Spray${mix.location_label ? ` (${mix.location_label})` : ""} on News for 38 Year Olds.`;

  const itemsXml = items
    .slice(0, RSS_FEED_ITEM_CAP)
    .map((it) => {
      const guid = escapeXml(it.link);
      const pubDate = toRfc822(it.created_at || it.date);
      return `    <item>
      <title>${escapeXml(it.headline)}</title>
      <link>${escapeXml(it.link)}</link>
      <guid isPermaLink="true">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      ${it.excerpt ? `<description>${escapeXml(it.excerpt)}</description>` : ""}
      ${it.outlet ? `<dc:creator>${escapeXml(it.outlet)}</dc:creator>` : ""}
      ${it.outlet ? `<source>${escapeXml(it.outlet)}</source>` : ""}
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${escapeXml(channelLink)}</link>
    <description>${escapeXml(channelDesc)}</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${itemsXml}
  </channel>
</rss>`;
}

app.get("/api/mixes/:slug/rss", async (req, res) => {
  const slug = req.params.slug;
  try {
    const mix = await dbGet(`SELECT * FROM feed_mixes WHERE slug = ?`, [slug]);
    if (!mix || !mix.is_public) return res.status(404).type("text/plain").send("feed not found");

    const cached = rssFeedCache.get(slug);
    if (cached && Date.now() - cached.fetchedAt < RSS_FEED_CACHE_TTL_MS) {
      return res.type("application/rss+xml; charset=utf-8").send(cached.xml);
    }

    const { items } = await resolveMixSources(mix, { includePending: false });
    const xml = buildMixRssXml(mix, items);
    rssFeedCache.set(slug, { xml, fetchedAt: Date.now() });
    res.type("application/rss+xml; charset=utf-8").send(xml);
  } catch (err) {
    console.error("RSS feed generation failed for", slug, err);
    const cached = rssFeedCache.get(slug);
    if (cached) return res.type("application/rss+xml; charset=utf-8").send(cached.xml); // fail soft: stale beats broken
    res.status(500).type("text/plain").send("feed temporarily unavailable");
  }
});

// ---------- Bluesky headlines bot ----------
// Posts the "top story" from the Headlines: Best in the World Spray to a
// Bluesky bot account every BLUESKY_BOT_INTERVAL_MINUTES (Jason's call:
// batch, one post per window, not one-post-per-headline — see
// SCOPING-headlines-rss-bluesky-bot.md Part 2). First live-write
// integration in this codebase; everything else Bluesky-related so far is
// read-only via the public unauthenticated AT Protocol AppView endpoints.
// Fails soft throughout: a down API, an expired/unrefreshable session, or
// any posting error just gets logged and retried next cycle — never
// affects the main site.
const BLUESKY_BOT_HANDLE = normalizeHandle(process.env.BLUESKY_BOT_HANDLE || "");
const BLUESKY_BOT_APP_PASSWORD = process.env.BLUESKY_BOT_APP_PASSWORD || "";
const BLUESKY_BOT_INTERVAL_MINUTES = Number(process.env.BLUESKY_BOT_INTERVAL_MINUTES || 15);
const BLUESKY_POST_CHAR_LIMIT = 300;

let blueskyBotSession = null; // { accessJwt, refreshJwt, did, fetchedAt }
const BLUESKY_SESSION_REFRESH_MS = 90 * 60 * 1000; // Bluesky access tokens run ~2h; refresh a bit early to be safe

async function getBlueskyBotSession() {
  if (!BLUESKY_BOT_HANDLE || !BLUESKY_BOT_APP_PASSWORD) return null; // not configured — fail soft, same pattern as YOUTUBE_API_KEY

  if (blueskyBotSession && Date.now() - blueskyBotSession.fetchedAt < BLUESKY_SESSION_REFRESH_MS) {
    return blueskyBotSession;
  }

  // Try refreshing an existing session first (cheaper, doesn't re-spend the
  // app password), fall back to a fresh login if there's nothing to refresh
  // or the refresh itself fails.
  if (blueskyBotSession?.refreshJwt) {
    try {
      const resp = await fetch("https://bsky.social/xrpc/com.atproto.server.refreshSession", {
        method: "POST",
        headers: { Authorization: `Bearer ${blueskyBotSession.refreshJwt}` },
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json();
        blueskyBotSession = { accessJwt: data.accessJwt, refreshJwt: data.refreshJwt, did: data.did, fetchedAt: Date.now() };
        return blueskyBotSession;
      }
    } catch (err) {
      console.error("Bluesky bot session refresh failed, falling back to fresh login:", err.message);
    }
  }

  try {
    const resp = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: BLUESKY_BOT_HANDLE, password: BLUESKY_BOT_APP_PASSWORD }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`createSession ${resp.status}`);
    const data = await resp.json();
    blueskyBotSession = { accessJwt: data.accessJwt, refreshJwt: data.refreshJwt, did: data.did, fetchedAt: Date.now() };
    return blueskyBotSession;
  } catch (err) {
    console.error("Bluesky bot login failed:", err.message);
    blueskyBotSession = null;
    return null;
  }
}

function utf8ByteLength(str) {
  return Buffer.byteLength(str, "utf8");
}

// Bluesky facets need byte offsets (UTF-8), not JS string-index offsets —
// those can diverge whenever the text contains anything outside plain
// ASCII (emoji, curly quotes, etc.) ahead of the URL.
function buildLinkFacet(fullText, url) {
  const idx = fullText.indexOf(url);
  if (idx === -1) return null;
  const byteStart = utf8ByteLength(fullText.slice(0, idx));
  const byteEnd = byteStart + utf8ByteLength(url);
  return { index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri: url }] };
}

// Format: headline / outlet / link / (tip-or-subscribe line, only if one
// exists — omitted entirely, not left as a dangling blank paragraph, if
// the dispatch has neither). Headline gets truncated (not the fixed
// outlet/link/tip parts) to keep the whole post under Bluesky's 300-char
// limit. Both the article link and the tip/subscribe link (if present)
// get real clickable facets, not just plain text — a post built via the
// API doesn't get Bluesky's own client-side auto-link-detection.
function buildBlueskyPostRecord(story) {
  const outlet = story.outlet || "";
  const link = story.link;

  let tipLine = null;
  let tipUrl = null;
  if (story.tip_url) {
    tipUrl = story.tip_url;
    tipLine = `TIP YOUR REPORTER: ${tipUrl}`;
  } else if (story.subscribe_url) {
    tipUrl = story.subscribe_url;
    tipLine = `SUBSCRIBE: ${tipUrl}`;
  }

  const suffixParts = [outlet, link];
  if (tipLine) suffixParts.push(tipLine);
  const suffix = "\n\n" + suffixParts.filter(Boolean).join("\n\n");

  const maxHeadlineLen = Math.max(0, BLUESKY_POST_CHAR_LIMIT - suffix.length);
  let headline = story.headline;
  if (headline.length > maxHeadlineLen) {
    headline = headline.slice(0, Math.max(0, maxHeadlineLen - 1)).trimEnd() + "…";
  }

  const text = headline + suffix;

  const facets = [];
  const linkFacet = buildLinkFacet(text, link);
  if (linkFacet) facets.push(linkFacet);
  if (tipUrl) {
    const tipFacet = buildLinkFacet(text, tipUrl);
    if (tipFacet) facets.push(tipFacet);
  }

  return { text, facets };
}

// ---------- Bluesky: link-card image previews ----------
// Posting via the raw API (as this bot does) does NOT get Bluesky's own
// client-side link-card generation — that only happens when the official
// app/web client composes a post, fetches the target URL's OG tags itself,
// uploads a thumbnail blob, and attaches an app.bsky.embed.external record
// BEFORE the post is created. A raw createRecord call with no embed shows
// as plain text + a clickable link, no image, no card. This builds that
// embed manually so the bot's posts look the same as a normal share.
const OG_IMAGE_FETCH_TIMEOUT_MS = 6000;
const BLUESKY_THUMB_MAX_BYTES = 950000; // Bluesky's external-embed thumb cap is ~1,000,000 bytes; stay safely under it

async function fetchOgImage(pageUrl) {
  try {
    const resp = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; N38Bot/1.0; +https://news-for-38-year-olds.onrender.com)" },
      signal: AbortSignal.timeout(OG_IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    // og:image first, twitter:image as a fallback — attribute order (content
    // before/after property) varies by site, so try both orderings.
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    for (const re of patterns) {
      const match = html.match(re);
      if (match?.[1]) {
        try {
          return new URL(match[1], pageUrl).href; // resolve relative URLs against the page
        } catch {
          continue;
        }
      }
    }
    return null;
  } catch {
    return null; // fail soft — timeout, blocked, no og:image, whatever — just means no thumbnail
  }
}

async function uploadImageBlobToBluesky(session, imageUrl) {
  try {
    const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(OG_IMAGE_FETCH_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.byteLength > BLUESKY_THUMB_MAX_BYTES || buf.byteLength === 0) return null;

    const uploadResp = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": contentType },
      body: buf,
      signal: AbortSignal.timeout(OG_IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!uploadResp.ok) return null;
    const data = await uploadResp.json();
    return data.blob || null;
  } catch {
    return null; // fail soft — a missing/broken thumbnail should never block the actual post
  }
}

function buildExternalEmbed({ uri, title, description, thumbBlob }) {
  const embed = {
    $type: "app.bsky.embed.external",
    external: {
      uri,
      title: (title || "").slice(0, 300),
      description: (description || "").slice(0, 1000),
    },
  };
  if (thumbBlob) embed.external.thumb = thumbBlob;
  return embed;
}

// "Newest, full stop" — Jason's explicit call after the first live post
// picked an old PINNED item over a genuinely newer one. Pinned is a
// website-prominence signal (what shows at the top of the Wire), not a
// freshness signal, and this bot's whole point is real-time — so pinned
// status is deliberately NOT part of this ordering, unlike the Wire/
// official Spray. Tracked via an explicit NOT IN (already-posted ids),
// not a MAX(id) watermark — a watermark would break the moment any
// out-of-id-order pick ever happens again (harmless today since this is
// now a pure date/id sort, but NOT IN costs nothing and is more robust
// if the selection logic ever changes again).
async function pickTopStoryForBot() {
  const candidates = await dbAll(
    `SELECT * FROM dispatches
     WHERE id NOT IN (SELECT dispatch_id FROM bluesky_bot_posts)
     ORDER BY date DESC, id DESC LIMIT 1`
  );
  return candidates[0] || null;
}

async function postDueHeadlineToBluesky() {
  const session = await getBlueskyBotSession();
  if (!session) return; // not configured, or login/refresh failed — logged already, retry next cycle

  try {
    const story = await pickTopStoryForBot();
    if (!story) return; // nothing new since the last post — skip silently, not an error

    const { text: postText, facets } = buildBlueskyPostRecord(story);

    // Best-effort link-card image — never let a missing/slow/broken
    // thumbnail hold up or fail the actual post. embed stays undefined
    // (posts as plain text + clickable link, today's existing behavior)
    // if anything here doesn't pan out.
    let embed;
    try {
      const ogImageUrl = await fetchOgImage(story.link);
      if (ogImageUrl) {
        const thumbBlob = await uploadImageBlobToBluesky(session, ogImageUrl);
        if (thumbBlob) {
          embed = buildExternalEmbed({
            uri: story.link,
            title: story.headline,
            description: story.outlet || "",
            thumbBlob,
          });
        }
      }
    } catch (err) {
      console.error("Bluesky bot link-card image failed (posting without it):", err.message);
    }

    const resp = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text: postText,
          facets: facets.length ? facets : undefined,
          embed,
          createdAt: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`createRecord ${resp.status}: ${await resp.text().catch(() => "")}`);
    const data = await resp.json();

    await dbRun(
      `INSERT INTO bluesky_bot_posts (dispatch_id, bluesky_post_uri) VALUES (?, ?)`,
      [story.id, data.uri || null]
    );
    console.log(`Bluesky bot posted dispatch #${story.id}: ${story.headline}`);
  } catch (err) {
    console.error("Bluesky bot posting failed:", err.message); // fail soft — never affects the main site, retried next cycle
  }
}

if (BLUESKY_BOT_HANDLE && BLUESKY_BOT_APP_PASSWORD) {
  setInterval(postDueHeadlineToBluesky, BLUESKY_BOT_INTERVAL_MINUTES * 60 * 1000);
  console.log(`Bluesky headlines bot enabled — posting every ${BLUESKY_BOT_INTERVAL_MINUTES}min as @${BLUESKY_BOT_HANDLE}`);
} else {
  console.log("Bluesky headlines bot disabled (BLUESKY_BOT_HANDLE / BLUESKY_BOT_APP_PASSWORD not set)");
}

// ---------- Bluesky: "Top of the Nerve Center" roundup post ----------
// A second, much lower-cadence job on the SAME bot account/session as the
// headlines bot above — no new credentials needed. Purpose is different
// from the headlines bot: this doesn't post news, it posts a "here's
// what's trending on Nerve Center right now" roundup that LINKS BACK TO
// NERVE CENTER ITSELF (not the underlying article), specifically to drive
// people to the Nerve Center page. Picks the single top-scoring post across
// ALL sections from the same ranked blueskyCache the homepage Popular on
// Bluesky box uses (Jason's call: "top skeets from all", not filtered to
// one Focus category).
const BLUESKY_ROUNDUP_INTERVAL_MINUTES = Number(process.env.BLUESKY_ROUNDUP_INTERVAL_MINUTES || 8 * 60);
const ROUNDUP_STATE_KEY = "last_roundup_posted_url";

// The roundup always links to the same page (nerve-center.html), so it
// always shows the same branded card image (nerve-center-og.png, already
// built for social-share meta tags in an earlier session) — upload it ONCE
// and cache the resulting blob ref in memory, rather than re-uploading an
// unchanging file on every single roundup post.
let cachedNerveCenterThumbBlob = null;

async function getNerveCenterThumbBlob(session) {
  if (cachedNerveCenterThumbBlob) return cachedNerveCenterThumbBlob;
  try {
    const imagePath = path.join(__dirname, "public", "nerve-center-og.png");
    const buf = await readFile(imagePath);
    const uploadResp = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": "image/png" },
      body: buf,
      signal: AbortSignal.timeout(OG_IMAGE_FETCH_TIMEOUT_MS),
    });
    if (!uploadResp.ok) return null;
    const data = await uploadResp.json();
    cachedNerveCenterThumbBlob = data.blob || null;
    return cachedNerveCenterThumbBlob;
  } catch (err) {
    console.error("Nerve Center roundup thumb upload failed (posting without it):", err.message);
    return null;
  }
}

function buildNerveCenterRoundupPost(topPost) {
  const nerveCenterLink = `${SITE_URL}/nerve-center.html`;
  const snippetMax = 160;
  let snippet = (topPost.text || "").trim();
  if (snippet.length > snippetMax) snippet = snippet.slice(0, snippetMax - 1).trimEnd() + "…";

  const intro = "🗞️ TOP OF THE NERVE CENTER";
  const body = `${topPost.outlet} on Bluesky: "${snippet}"`;
  const cta = `See what's trending → ${nerveCenterLink}`;
  const text = [intro, body, cta].join("\n\n");

  const facets = [];
  const linkFacet = buildLinkFacet(text, nerveCenterLink);
  if (linkFacet) facets.push(linkFacet);
  return { text, facets };
}

async function postNerveCenterRoundupToBluesky() {
  const session = await getBlueskyBotSession();
  if (!session) return; // not configured, or login/refresh failed — logged already, retry next cycle

  try {
    const now = Date.now();
    if (now - blueskyCache.fetchedAt > BLUESKY_CACHE_TTL_MS) {
      const data = await fetchBlueskyPopular();
      blueskyCache = { data, fetchedAt: now };
    }
    const topPost = blueskyCache.data[0];
    if (!topPost) return; // nothing to roundup — skip silently, not an error

    // Persisted (not in-memory) so this guard survives a restart — this is
    // what makes it safe to also kick this job shortly after boot (see the
    // startup section below), the same way the headlines bot's DB-backed
    // dedup makes its own boot-time kick safe.
    const lastRow = await dbGet(`SELECT value FROM bot_state WHERE key = ?`, [ROUNDUP_STATE_KEY]);
    if (lastRow?.value === topPost.blueskyUrl) return; // same top skeet as last post, don't repeat verbatim

    const { text: postText, facets } = buildNerveCenterRoundupPost(topPost);

    const nerveCenterLink = `${SITE_URL}/nerve-center.html`;
    let embed;
    try {
      const thumbBlob = await getNerveCenterThumbBlob(session);
      if (thumbBlob) {
        embed = buildExternalEmbed({
          uri: nerveCenterLink,
          title: "News for 38 Year Olds — Nerve Center",
          description: "What's trending on Bluesky, ranked with no algorithm you can't see.",
          thumbBlob,
        });
      }
    } catch (err) {
      console.error("Nerve Center roundup link-card image failed (posting without it):", err.message);
    }

    const resp = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessJwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record: {
          $type: "app.bsky.feed.post",
          text: postText,
          facets: facets.length ? facets : undefined,
          embed,
          createdAt: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`createRecord ${resp.status}: ${await resp.text().catch(() => "")}`);

    await dbRun(
      `INSERT INTO bot_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [ROUNDUP_STATE_KEY, topPost.blueskyUrl]
    );
    console.log(`Bluesky Nerve Center roundup posted — top skeet: ${topPost.outlet}`);
  } catch (err) {
    console.error("Bluesky Nerve Center roundup posting failed:", err.message); // fail soft, retried next cycle
  }
}

if (BLUESKY_BOT_HANDLE && BLUESKY_BOT_APP_PASSWORD) {
  setInterval(postNerveCenterRoundupToBluesky, BLUESKY_ROUNDUP_INTERVAL_MINUTES * 60 * 1000);
  console.log(`Bluesky Nerve Center roundup enabled — posting every ${BLUESKY_ROUNDUP_INTERVAL_MINUTES}min as @${BLUESKY_BOT_HANDLE}`);
}

app.post("/api/mixes/:slug/clone", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });

  const mix = await dbGet(`SELECT * FROM feed_mixes WHERE slug = ?`, [req.params.slug]);
  if (!mix) return res.status(404).json({ error: "mix not found" });
  const isOwner = user.id === mix.creator_user_id;
  if (!mix.is_public && !isOwner) return res.status(404).json({ error: "mix not found" });

  // Official Spray: no stored feed_mix_sources rows to read — clone the
  // live outlet list (whatever's actually contributing to the wire right
  // now), same auto-sync principle as resolveMixSources() above.
  const sourceRows = mix.is_official
    ? (await dbAll(`SELECT DISTINCT outlet FROM dispatches`)).map((r) => ({ source_type: "admin_outlet", outlet: r.outlet }))
    : await dbAll(
        `SELECT fms.*, ucs.name AS custom_name, ucs.feed_url AS custom_feed_url, ucs.submission_status AS custom_status
         FROM feed_mix_sources fms
         LEFT JOIN user_custom_sources ucs ON ucs.id = fms.custom_source_id
         WHERE fms.mix_id = ? ORDER BY fms.sort_order ASC, fms.id ASC`,
        [mix.id]
      );

  let outletsAdded = 0, customAdded = 0, customSkipped = 0;
  const existingCount = (await dbGet(`SELECT COUNT(*) AS n FROM user_custom_sources WHERE user_id = ?`, [user.id])).n;
  let customBudget = CUSTOM_SOURCE_CAP - existingCount;

  for (const s of sourceRows) {
    if (s.source_type === "admin_outlet") {
      await dbRun(
        `INSERT INTO user_feed_prefs (user_id, outlet, enabled) VALUES (?, ?, 1)
         ON CONFLICT(user_id, outlet) DO UPDATE SET enabled = 1`,
        [user.id, s.outlet]
      );
      outletsAdded++;
    } else if (s.source_type === "custom" && s.custom_feed_url) {
      // Cloning others' custom sources into your own wire only makes sense
      // once they've cleared moderation (your own mix's pending ones are
      // yours already, so always allowed there).
      if (!isOwner && s.custom_status !== "approved") { customSkipped++; continue; }
      const already = await dbGet(`SELECT id FROM user_custom_sources WHERE user_id = ? AND feed_url = ?`, [user.id, s.custom_feed_url]);
      if (already) continue; // already have it, nothing to do
      if (customBudget <= 0) { customSkipped++; continue; }
      await dbRun(
        `INSERT INTO user_custom_sources (user_id, name, feed_url, validated, submission_status) VALUES (?, ?, ?, 1, 'pending')`,
        [user.id, s.custom_name, s.custom_feed_url]
      );
      customBudget--;
      customAdded++;
    }
  }

  await dbRun(`UPDATE feed_mixes SET clone_count = clone_count + 1 WHERE id = ?`, [mix.id]);
  res.json({ ok: true, outlets_added: outletsAdded, custom_added: customAdded, custom_skipped: customSkipped });
});

app.get("/api/my/mixes", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const rows = await dbAll(
    `SELECT slug, name, location_label, is_public, created_at FROM feed_mixes WHERE creator_user_id = ? ORDER BY created_at DESC`,
    [user.id]
  );
  res.json(rows);
});

// ---------- Follows: Topics taxonomy ----------
// Topics are a real curated list (approved by an admin), not free-text tags.
// Readers can propose new ones; a proposal is 'pending' until approved —
// same visibility rule as everywhere else in this codebase: not selectable
// when creating/editing a Mix, and not shown in the public browse list,
// until approved.
app.get("/api/topics", async (req, res) => {
  const rows = await dbAll(
    `SELECT t.id, t.name, t.slug, COUNT(fm.id) AS mix_count
     FROM topics t LEFT JOIN feed_mixes fm ON fm.topic_id = t.id AND fm.is_public = 1
     WHERE t.status = 'approved'
     GROUP BY t.id
     ORDER BY mix_count DESC, t.name ASC`
  );
  res.json(rows);
});

app.post("/api/topics", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });

  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "name is required" });

  const slug = slugify(name);
  const existing = await dbGet(`SELECT id, status FROM topics WHERE slug = ?`, [slug]);
  if (existing) {
    return res.status(409).json({ error: existing.status === "approved" ? "That topic already exists." : "That topic has already been suggested." });
  }

  await dbRun(
    `INSERT INTO topics (name, slug, status, suggested_by_user_id) VALUES (?, ?, 'pending', ?)`,
    [name, slug, user.id]
  );
  res.json({ ok: true, slug, status: "pending" });
});

app.get("/api/admin/pending-topics", requireAdmin, async (req, res) => {
  const rows = await dbAll(
    `SELECT t.id, t.name, t.slug, t.created_at, u.email AS suggested_by
     FROM topics t LEFT JOIN users u ON u.id = t.suggested_by_user_id
     WHERE t.status = 'pending' ORDER BY t.created_at ASC`
  );
  res.json(rows);
});

app.post("/api/admin/topics/:id/approve", requireAdmin, async (req, res) => {
  await dbRun(`UPDATE topics SET status = 'approved' WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

app.delete("/api/admin/topics/:id", requireAdmin, async (req, res) => {
  await dbRun(`DELETE FROM topics WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// Directory: browse public mixes, filtered by topic slug or free-text
// location, ranked by clone count (cheap "eventually ranked" proxy per the
// locked scoping doc — no new tracking infra, just COUNT() at query time),
// tie-broken by most recent.
app.get("/api/mixes", async (req, res) => {
  const { topic, location } = req.query;
  const conditions = [`fm.is_public = 1`, `fm.is_official = 0`];
  const params = [];

  if (topic) {
    conditions.push(`t.slug = ?`);
    params.push(String(topic));
  }
  if (location) {
    conditions.push(`fm.location_label LIKE ?`);
    params.push(`%${String(location).trim()}%`);
  }

  const rows = await dbAll(
    `SELECT fm.slug, fm.name, fm.location_label, fm.created_at, fm.clone_count,
            t.name AS topic_name, t.slug AS topic_slug
     FROM feed_mixes fm
     LEFT JOIN topics t ON t.id = fm.topic_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY fm.clone_count DESC, fm.created_at DESC
     LIMIT 60`,
    params
  );
  res.json(rows);
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

  // Personalize for signed-in readers via conscious filtering — the reader
  // sets an explicit tier per source (pinned/normal/less/hidden), not an
  // algorithm inferring one from behavior. No saved tiers yet (new reader,
  // or not signed in) means everyone sees the full wire, curated-default
  // order — nothing narrows or reorders without the reader opting in.
  const user = await getCurrentUser(req);

  // Blend in the signed-in reader's own custom RSS sources (Super RSS
  // Reader). Cached by URL, fetched on demand — never touches the curated
  // 20-min import job. A slow or broken custom feed just contributes
  // nothing (Promise.allSettled), it can never delay or break the rest of
  // the wire. Only blended into the main unfiltered wire, not a beat-
  // filtered view — custom sources aren't categorized into a beat.
  if (user && !beat) {
    const customSources = await dbAll(`SELECT id, name, feed_url FROM user_custom_sources WHERE user_id = ?`, [user.id]);
    if (customSources.length > 0) {
      const results = await Promise.allSettled(
        customSources.map(async (cs) => {
          const items = await fetchCustomSourceItems(cs.feed_url);
          return items.map((it) => ({
            id: `custom-${cs.id}-${Buffer.from(it.link).toString("base64url").slice(0, 16)}`,
            name: cs.name,
            outlet: cs.name,
            beat: "My Sources",
            date: formatDate(it.pubDate),
            headline: it.title,
            excerpt: null,
            link: it.link,
            tip_url: null,
            subscribe_url: null,
            pinned: 0,
          }));
        })
      );
      results.filter((r) => r.status === "rejected").forEach((r) => console.error("Custom source fetch failed:", r.reason?.message || r.reason));
      const customRows = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
      rows = [...customRows, ...rows];
    }
  }

  if (user) {
    const tierRows = await dbAll(`SELECT outlet, rating AS tier FROM user_source_ratings WHERE user_id = ?`, [user.id]);
    // Thumbs-up personal ranking (Feature B): opt-in only, and only ever
    // reorders THIS reader's own wire. Recency stays primary — thumbs-up is
    // a same-day tiebreak, not a full re-sort, and sits INSIDE tier order
    // (a thumbed "less"-tier source still can't jump ahead of a "normal"-
    // tier source — thumbs only break ties among items that already sort
    // together). An item from a thumbed source never jumps ahead of a
    // genuinely more recent item from a different day. Un-thumbed sources
    // get no penalty (neutral default).
    const thumbRows = await dbAll(`SELECT outlet FROM feed_thumbs WHERE user_id = ?`, [user.id]);
    const thumbed = new Set(thumbRows.map(r => r.outlet));

    if (tierRows.length > 0) {
      const tierMap = new Map(tierRows.map(r => [r.outlet, r.tier]));
      const tierRank = { pinned: 0, normal: 1, less: 2, hidden: 3 };
      rows = rows
        .filter(r => (tierMap.get(r.outlet) || "normal") !== "hidden")
        .map(r => ({
          ...r,
          _tier: tierRank[tierMap.get(r.outlet)] ?? 1,
          _dayBucket: (r.date || "").slice(0, 10),
          _thumbed: thumbed.has(r.outlet) ? 0 : 1,
        }))
        .sort((a, b) => {
          // editorial breaking-news pin (admin-set) always wins first
          if (a.pinned !== b.pinned) return b.pinned - a.pinned;
          if (a._tier !== b._tier) return a._tier - b._tier;
          if (a._dayBucket !== b._dayBucket) return a._dayBucket < b._dayBucket ? 1 : -1;
          if (a._thumbed !== b._thumbed) return a._thumbed - b._thumbed;
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;
          return b.id - a.id;
        })
        .map(({ _tier, _dayBucket, _thumbed, ...rest }) => rest);
    } else {
      // fall back to the old on/off feed-prefs for readers who customized
      // their wire before this feature existed, but haven't re-saved yet
      const prefRows = await dbAll(`SELECT outlet, enabled FROM user_feed_prefs WHERE user_id = ?`, [user.id]);
      if (prefRows.length > 0) {
        const allowed = new Set(prefRows.filter(r => r.enabled).map(r => r.outlet));
        rows = rows.filter(r => allowed.has(r.outlet));
      }
      if (thumbed.size > 0) {
        rows = rows
          .map(r => ({ ...r, _dayBucket: (r.date || "").slice(0, 10), _thumbed: thumbed.has(r.outlet) ? 0 : 1 }))
          .sort((a, b) => {
            if (a.pinned !== b.pinned) return b.pinned - a.pinned;
            if (a._dayBucket !== b._dayBucket) return a._dayBucket < b._dayBucket ? 1 : -1;
            if (a._thumbed !== b._thumbed) return a._thumbed - b._thumbed;
            if (a.date !== b.date) return a.date < b.date ? 1 : -1;
            return b.id - a.id;
          })
          .map(({ _dayBucket, _thumbed, ...rest }) => rest);
      }
    }
  }

  res.json(rows);
});

app.get("/api/sources", async (req, res) => {
  const rows = await dbAll(
    `SELECT outlet, default_author, subscribe_url, tip_url, feed_url, bluesky_handle, feed_type FROM feeds WHERE submission_status = 'approved' ORDER BY outlet ASC`
  );
  res.json(rows);
});

// ---------- Thumbs-up (Feature B) ----------
app.post("/api/my/thumbs/:outlet", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const outlet = (req.params.outlet || "").trim();
  if (!outlet) return res.status(400).json({ error: "outlet required" });
  const existing = await dbGet(`SELECT 1 FROM feed_thumbs WHERE user_id = ? AND outlet = ?`, [user.id, outlet]);
  if (existing) {
    await dbRun(`DELETE FROM feed_thumbs WHERE user_id = ? AND outlet = ?`, [user.id, outlet]);
    return res.json({ ok: true, thumbed: false });
  }
  await dbRun(`INSERT INTO feed_thumbs (user_id, outlet) VALUES (?, ?)`, [user.id, outlet]);
  res.json({ ok: true, thumbed: true });
});

app.get("/api/my/thumbs", async (req, res) => {
  const user = await getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  const rows = await dbAll(`SELECT outlet FROM feed_thumbs WHERE user_id = ?`, [user.id]);
  res.json(rows.map(r => r.outlet));
});

// Transparent, read-only leaderboard — every reader sees the same aggregate
// counts. Seeing this never changes anyone's own Wire order; only a
// reader's own thumbs-ups (via POST /api/my/thumbs/:outlet above) affect
// their own /api/dispatches ordering.
app.get("/api/feeds/favorites", async (req, res) => {
  const rows = await dbAll(
    `SELECT outlet, COUNT(*) AS count FROM feed_thumbs GROUP BY outlet HAVING count > 0 ORDER BY count DESC, outlet ASC`
  );
  res.json(rows.map(r => ({ outlet: r.outlet, count: Number(r.count) })));
});

// ---------- "Most Popular on Bluesky" ----------
// Pulls each outlet's Bluesky posts from the last 24h via the public,
// no-auth AT Protocol AppView API, keeps ones that link out to an
// article, and ranks by engagement. Cached in memory so a burst of
// page views doesn't hammer Bluesky's public API on every request.
const BLUESKY_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
let blueskyCache = { data: [], fetchedAt: 0 };
// Raw, pre-dedup post list from the same fetch — every individual's post survives here,
// even when their post links the same article as another outlet/journalist's post (which
// the deduped `blueskyCache.data` above would otherwise collapse down to just one winner).
// On Trend / chatter matching needs this so a journalist's own take on a story doesn't get
// silently dropped just because an outlet also posted about the same link.
let blueskyAllPostsCache = { data: [], fetchedAt: 0 };

async function fetchBlueskyPopular() {
  const feeds = await dbAll(
    `SELECT outlet, bluesky_handle, fallback_beat, feed_type FROM feeds WHERE bluesky_handle IS NOT NULL AND bluesky_handle != ''`
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
        const blueskyUrl = `https://bsky.app/profile/${f.bluesky_handle}/post/${String(post.uri).split("/").pop()}`;
        const embedType = post.embed?.$type || "";
        const hasQuote = embedType === "app.bsky.embed.record#view" || embedType === "app.bsky.embed.recordWithMedia#view";
        const likeCount = post.likeCount || 0;
        const repostCount = post.repostCount || 0;
        const replyCount = post.replyCount || 0;
        items.push({
          outlet: f.outlet,
          feedType: f.feed_type === "journalist" ? "journalist" : "outlet",
          section: f.fallback_beat || "Indie Media",
          text: (post.record?.text || "").slice(0, 260),
          link: link || blueskyUrl, // fall back to the Bluesky post itself when there's no external link
          hasLink: !!link,
          hasQuote,
          blueskyUrl,
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

  // Stash the raw, undeduped list (every individual's post) for chatter matching to use —
  // done here, as a side effect of the fetch we're already making, so it doesn't cost a
  // second round of API calls just to keep the two caches in sync.
  blueskyAllPostsCache = { data: all.sort((a, b) => b.score - a.score), fetchedAt: Date.now() };

  // de-dupe by link (multiple mentions of the same article), keep the highest-scoring post —
  // this is what keeps the homepage "Popular on Bluesky" box from showing the same story
  // over and over just because several outlets/journalists all posted about it.
  const byLink = new Map();
  for (const item of all) {
    const existing = byLink.get(item.link);
    if (!existing || item.score > existing.score) byLink.set(item.link, item);
  }
  const dedupedByLink = [...byLink.values()];

  // Also cap to ONE post per outlet/journalist (their single highest-scoring post survives) —
  // a prolific poster (e.g. someone who posts many times a day) would otherwise flood the
  // Popular list with several of their own posts and crowd everyone else out. This cap is
  // applied here, before any section/Focus filtering downstream, so it holds no matter which
  // Focus category a reader picks.
  const byOutlet = new Map();
  for (const item of dedupedByLink) {
    const existing = byOutlet.get(item.outlet);
    if (!existing || item.score > existing.score) byOutlet.set(item.outlet, item);
  }
  return [...byOutlet.values()].sort((a, b) => b.score - a.score); // full ranked list; callers slice as needed
}

app.get("/api/bluesky-popular", async (req, res) => {
  const filterData = (data) => {
    if (req.query.filter === "links") return data.filter(i => i.hasLink);
    if (req.query.filter === "quotes") return data.filter(i => i.hasQuote);
    return data;
  };
  try {
    const now = Date.now();
    if (now - blueskyCache.fetchedAt > BLUESKY_CACHE_TTL_MS) {
      const data = await fetchBlueskyPopular();
      blueskyCache = { data, fetchedAt: now };
    }
    res.json(filterData(blueskyCache.data).slice(0, 25));
  } catch (err) {
    console.error("Bluesky popular error:", err);
    res.json(filterData(blueskyCache.data).slice(0, 25)); // fail soft — never break the page over this
  }
});

// ---------- Nerve Center: Popular on Bluesky (feeds + starter packs) ----------
// Feeds: Bluesky's own "most popular custom feeds" ranking, straight from their API.
// Starter packs: Bluesky doesn't expose a platform-wide "most popular" ranking for
// these, so we search a handful of politics/news-relevant terms and rank the
// combined results ourselves by joinedAllTimeCount (their own join-count field).
const BLUESKY_DISCOVER_TTL_MS = 60 * 60 * 1000; // 1 hour — this changes slowly, no need to hammer the API
let blueskyDiscoverCache = { feeds: [], starterPacks: [], fetchedAt: 0 };
const STARTER_PACK_SEARCH_TERMS = ["news", "politics", "journalism", "indie media"];

async function fetchPopularBlueskyFeeds() {
  const url = "https://public.api.bsky.app/xrpc/app.bsky.unspecced.getPopularFeedGenerators?limit=10";
  const resp = await fetch(url, { headers: { "User-Agent": "n38-cms/1.0" } });
  if (!resp.ok) throw new Error(`getPopularFeedGenerators ${resp.status}`);
  const json = await resp.json();
  return (json.feeds || []).map(f => ({
    uri: f.uri,
    name: f.displayName || "Untitled feed",
    description: (f.description || "").slice(0, 160),
    creatorHandle: f.creator?.handle || "",
    likeCount: f.likeCount || 0,
    avatar: f.avatar || null,
    link: `https://bsky.app/profile/${f.creator?.handle || f.did}/feed/${String(f.uri).split("/").pop()}`,
  })).sort((a, b) => b.likeCount - a.likeCount).slice(0, 10);
}

async function fetchPopularStarterPacks() {
  const perTerm = await Promise.allSettled(
    STARTER_PACK_SEARCH_TERMS.map(async (term) => {
      const url = `https://public.api.bsky.app/xrpc/app.bsky.graph.searchStarterPacks?q=${encodeURIComponent(term)}&limit=25`;
      const resp = await fetch(url, { headers: { "User-Agent": "n38-cms/1.0" } });
      if (!resp.ok) throw new Error(`searchStarterPacks(${term}) ${resp.status}`);
      const json = await resp.json();
      return json.starterPacks || [];
    })
  );
  const all = perTerm.filter(r => r.status === "fulfilled").flatMap(r => r.value);
  perTerm.filter(r => r.status === "rejected").forEach(r => console.error("Starter pack search failed:", r.reason?.message || r.reason));

  const byUri = new Map();
  for (const sp of all) {
    if (!byUri.has(sp.uri)) byUri.set(sp.uri, sp);
  }
  return [...byUri.values()]
    .map(sp => ({
      uri: sp.uri,
      name: sp.record?.name || "Untitled starter pack",
      description: (sp.record?.description || "").slice(0, 160),
      creatorHandle: sp.creator?.handle || "",
      joinedAllTimeCount: sp.joinedAllTimeCount || 0,
      listItemCount: sp.listItemCount || 0,
      link: `https://bsky.app/starter-pack/${sp.creator?.handle}/${String(sp.uri).split("/").pop()}`,
    }))
    .sort((a, b) => b.joinedAllTimeCount - a.joinedAllTimeCount)
    .slice(0, 10);
}

app.get("/api/nerve-center/bluesky-discover", async (req, res) => {
  try {
    const now = Date.now();
    if (now - blueskyDiscoverCache.fetchedAt > BLUESKY_DISCOVER_TTL_MS) {
      const [feeds, starterPacks] = await Promise.all([
        fetchPopularBlueskyFeeds().catch(err => { console.error("Popular feeds error:", err.message); return blueskyDiscoverCache.feeds; }),
        fetchPopularStarterPacks().catch(err => { console.error("Popular starter packs error:", err.message); return blueskyDiscoverCache.starterPacks; }),
      ]);
      blueskyDiscoverCache = { feeds, starterPacks, fetchedAt: now };
    }
    res.json({ feeds: blueskyDiscoverCache.feeds, starterPacks: blueskyDiscoverCache.starterPacks });
  } catch (err) {
    console.error("Bluesky discover error:", err);
    res.json({ feeds: blueskyDiscoverCache.feeds, starterPacks: blueskyDiscoverCache.starterPacks }); // fail soft
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
    const { section, filter } = req.query;
    let data = blueskyCache.data;
    if (section && VALID_NERVE_SECTIONS.includes(section)) data = data.filter(i => i.section === section);
    if (filter === "links") data = data.filter(i => i.hasLink);
    else if (filter === "quotes") data = data.filter(i => i.hasQuote);
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
  // generic news/legal scaffolding — too common across unrelated stories to be useful signals
  "judge","judges","federal","order","orders","halt","halts","halted","halting",
  "block","blocked","blocking","dismiss","dismissed","dismisses","dismissing",
  "case","cases","court","courts","ruling","rulings","rules","ruled",
  "official","officials","calls","called","calling","plan","plans","planned",
  "planning","million","billion","government","administration","week","weeks",
  "day","days","year","years","state","states","national","city","county",
  "department","agency","agencies","law","laws","act","bill","bills","news",
  "breaking","exclusive","analysis","opinion","latest","turn","turns","turned",
  "against","still","yet","another","continue","continues","continuing","pour",
  "pours","pouring","success","rate","losses","outstanding","appointed","target",
  "targets","targeting","targeted","lost","win","wins","won","take","takes","taken",
]);

// Words that read as proper nouns/entities — capitalized mid-sentence, or an ALL-CAPS
// acronym — are far more distinctive than generic verbs/nouns, so they're the keywords
// we actually want to match Bluesky posts against (e.g. "Trump", "BBC" beat "federal", "judge").
function extractKeywords(title) {
  const words = title.split(/\s+/);
  const candidates = [];
  words.forEach((raw, i) => {
    const clean = raw.replace(/[^A-Za-z0-9]/g, "");
    if (!clean) return;
    const lower = clean.toLowerCase();
    const isAllCaps = clean.length > 1 && clean === clean.toUpperCase() && /[A-Z]/.test(clean);
    const isProper = isAllCaps || (i > 0 && /^[A-Z]/.test(clean));
    const minLen = isProper ? 2 : 4; // acronyms/proper nouns (BBC, DOJ) can be short and still distinctive
    if (lower.length < minLen || STOP_WORDS.has(lower)) return;
    candidates.push({ word: lower, proper: isProper, length: lower.length });
  });
  candidates.sort((a, b) => (b.proper - a.proper) || (b.length - a.length));
  const seen = new Set();
  const keywords = [];
  for (const c of candidates) {
    if (seen.has(c.word)) continue;
    seen.add(c.word);
    keywords.push(c);
    if (keywords.length >= 5) break;
  }
  return keywords;
}

function postMatchesKeywords(post, keywords) {
  if (!keywords.length) return false;
  const text = (post.text || "").toLowerCase();
  const hits = keywords.filter(kw => text.includes(kw.word));
  // Require 2+ distinct keyword hits. A single hit — even a proper noun like "Trump" — is
  // too common across unrelated posts on a politics site to be a reliable match on its own.
  return hits.length >= 2;
}

app.get("/api/nerve-center/chatter", async (req, res) => {
  try {
    // 1. Get the frontpage stories (already cached from the homepage Frontpage box)
    const stories = await getSimpleFeed("frontpage");
    if (!stories.length) return res.json([]);

    // 2. Get our journalists'/outlets' Bluesky posts. Uses the UNDEDUPED list
    // (blueskyAllPostsCache), not the homepage's link-deduped blueskyCache — the homepage
    // box intentionally collapses multiple posts about the same article down to one, but
    // that would silently drop a journalist's own commentary whenever it links the same
    // article an outlet already posted, which is exactly the content this panel exists to
    // surface. fetchBlueskyPopular() populates both caches in the same fetch.
    const now = Date.now();
    if (now - blueskyAllPostsCache.fetchedAt > BLUESKY_CACHE_TTL_MS) {
      const data = await fetchBlueskyPopular(); // side effect: also refreshes blueskyAllPostsCache
      blueskyCache = { data, fetchedAt: now };
    }
    const posts = blueskyAllPostsCache.data;

    // 3. For each story, find any Bluesky posts from our journalists that match
    const result = stories.map(story => {
      const keywords = extractKeywords(story.title);
      const matches = posts.filter(post => postMatchesKeywords(post, keywords));
      return {
        story: story.title,
        storyLink: story.link,
        keywords: keywords.map(k => k.word),
        chatter: matches.map(p => ({
          outlet: p.outlet,
          feedType: p.feedType,
          text: p.text,
          blueskyUrl: p.blueskyUrl,
          likeCount: p.likeCount,
          repostCount: p.repostCount,
          replyCount: p.replyCount,
          score: p.score,
          createdAt: p.createdAt,
        })).sort((a, b) => b.score - a.score),
      };
    }).filter(s => s.chatter.length > 0) // only stories where someone in our network said something
      .sort((a, b) => (b.chatter[0]?.score || 0) - (a.chatter[0]?.score || 0)); // lead with what's trending hardest on Bluesky

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
  actions: { url: "https://susanrogan.substack.com/feed", max: 20 },       // Rogan's List
  frontpage: { url: "https://www.theguardian.com/us-news/rss", max: 20 },  // Guardian US — Scott Trust owned since 1936, structurally billionaire-proof
  climate: { url: "https://www.theguardian.com/environment/climate-crisis/rss", max: 20 }, // Guardian Climate Crisis feed
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
    .map((it, i) => ({
      title: stripHtml(it.title),
      link: it.link,
      // Preview data (excerpt + thumbnail) only needed for the top item — no point
      // carrying it for the rest of a 20-item list.
      excerpt: i === 0 ? truncate(stripHtml(it.summary || ""), 200) : undefined,
      image: i === 0 ? (it.image || undefined) : undefined,
    }));
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

// ---------- National average gas price (eyebrow-bar stat) ----------
// AAA's Fuel Gauge Report page has no public JSON API, so this scrapes the
// "Today's AAA National Average $X.XXX" text off their public HTML page —
// same fail-soft, cached philosophy as SIMPLE_FEEDS above, just a regex
// pull instead of an RSS parse. Updates once a day on AAA's end, so a long
// cache TTL is fine.
const GAS_PRICE_URL = "https://gasprices.aaa.com/";
const GAS_PRICE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
let gasPriceCache = { price: null, fetchedAt: 0 };

async function fetchNationalGasPrice() {
  const r = await fetch(GAS_PRICE_URL, { headers: { "User-Agent": "Mozilla/5.0 (compatible; n38-cms/1.0; +https://news-for-38-year-olds.onrender.com)" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  const m = html.match(/Today['’]s AAA\s*National Average[\s\S]{0,80}?\$(\d\.\d{2,3})/i);
  if (!m) throw new Error("Could not find national average in page");
  return Number(m[1]);
}

async function getNationalGasPrice() {
  const now = Date.now();
  if (now - gasPriceCache.fetchedAt > GAS_PRICE_CACHE_TTL_MS) {
    try {
      const price = await fetchNationalGasPrice();
      gasPriceCache = { price, fetchedAt: now };
    } catch (err) {
      console.error("gas price fetch error:", err.message);
      // leave stale cache (or null) in place, try again next request
    }
  }
  return gasPriceCache.price;
}

app.get("/api/gas-price", async (req, res) => res.json({ price: await getNationalGasPrice() }));

// ---------- YouTube video feed (curated, not algorithmic) ----------
// Pulls each curated channel's "uploads" playlist via playlistItems.list
// (~1 quota unit/call, vs. 100 for search.list). Thumbnail+link-out only,
// no embedded players — matches the Bluesky box's page-weight philosophy.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";
const youtubeUploadsPlaylistCache = new Map(); // identifier -> {playlistId, channelTitle, thumbnail, cachedAt}
const YOUTUBE_PLAYLIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — channel->playlist mapping barely ever changes

async function resolveYoutubeUploadsPlaylist(identifier) {
  if (!YOUTUBE_API_KEY) throw new Error("YOUTUBE_API_KEY not configured");
  const cached = youtubeUploadsPlaylistCache.get(identifier);
  if (cached && Date.now() - cached.cachedAt < YOUTUBE_PLAYLIST_CACHE_TTL_MS) return cached;

  const base = "https://www.googleapis.com/youtube/v3/channels";
  const looksLikeChannelId = /^UC[a-zA-Z0-9_-]{22}$/.test(identifier);
  const attempts = looksLikeChannelId
    ? [`id=${encodeURIComponent(identifier)}`]
    : [`forHandle=${encodeURIComponent(identifier.replace(/^@/, ""))}`, `forUsername=${encodeURIComponent(identifier)}`];

  let channel = null;
  for (const qs of attempts) {
    const resp = await fetch(`${base}?part=contentDetails,snippet&${qs}&key=${YOUTUBE_API_KEY}`);
    if (!resp.ok) continue;
    const json = await resp.json();
    if (json.items?.[0]) { channel = json.items[0]; break; }
  }
  if (!channel) throw new Error(`YouTube channel not found for "${identifier}"`);

  const result = {
    playlistId: channel.contentDetails?.relatedPlaylists?.uploads,
    channelTitle: channel.snippet?.title || identifier,
    thumbnail: channel.snippet?.thumbnails?.default?.url || "",
    cachedAt: Date.now(),
  };
  if (!result.playlistId) throw new Error(`No uploads playlist for "${identifier}"`);
  youtubeUploadsPlaylistCache.set(identifier, result);
  return result;
}

async function fetchChannelVideos(identifier, outletName) {
  const { playlistId, channelTitle, thumbnail: channelThumb } = await resolveYoutubeUploadsPlaylist(identifier);
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=5&playlistId=${encodeURIComponent(playlistId)}&key=${YOUTUBE_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`playlistItems ${resp.status} for ${identifier}`);
  const json = await resp.json();
  return (json.items || []).map(item => {
    const s = item.snippet || {};
    const videoId = s.resourceId?.videoId;
    return {
      channel: outletName || channelTitle,
      channelThumbnail: channelThumb,
      title: s.title || "",
      thumbnail: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || "",
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
      published_at: s.publishedAt || null,
    };
  }).filter(v => v.url && v.title);
}

const YOUTUBE_VIDEO_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
let youtubeVideoCache = { data: [], fetchedAt: 0 };

async function getVideoFeed() {
  if (!YOUTUBE_API_KEY) return []; // fail soft — box just won't render
  const now = Date.now();
  if (now - youtubeVideoCache.fetchedAt < YOUTUBE_VIDEO_CACHE_TTL_MS) return youtubeVideoCache.data;

  const channels = await dbAll(
    `SELECT outlet, youtube_channel_id FROM feeds WHERE youtube_channel_id IS NOT NULL AND youtube_channel_id != '' AND submission_status = 'approved'`
  );
  const results = await Promise.allSettled(
    channels.map(c => fetchChannelVideos(c.youtube_channel_id, c.outlet))
  );
  results.filter(r => r.status === "rejected").forEach(r => console.error("YouTube fetch failed:", r.reason?.message || r.reason));

  // Round-robin interleave by channel, each channel's own videos sorted
  // newest-first internally, rather than one flat sort across everything.
  // A prolific channel (e.g. a cable-news account posting many clips a day)
  // would otherwise crowd out slower-posting channels entirely, especially
  // in a capped teaser list — this keeps the curated list actually diverse.
  const perChannel = results
    .filter(r => r.status === "fulfilled")
    .map(r => [...r.value].sort((a, b) => new Date(b.published_at) - new Date(a.published_at)))
    .filter(list => list.length > 0);

  const all = [];
  let round = 0;
  while (perChannel.some(list => list.length > round)) {
    for (const list of perChannel) {
      if (list[round]) all.push(list[round]);
    }
    round++;
  }

  youtubeVideoCache = { data: all, fetchedAt: now };
  return all;
}

app.get("/api/video-feed", async (req, res) => {
  try {
    res.json(await getVideoFeed());
  } catch (err) {
    console.error("Video feed error:", err);
    res.json(youtubeVideoCache.data); // fail soft — never break the page over this
  }
});

// ---------- reader-submitted YouTube channel suggestions ----------
// Simple per-IP cooldown (in-memory, not persistent across restarts — fine
// at this scale) plus a honeypot field the frontend form must include as a
// visually-hidden input. Validates the channel actually resolves on YouTube
// before saving, so typos/fake channels never even hit the pending queue.
const suggestCooldowns = new Map(); // ip -> last-submit timestamp
const SUGGEST_COOLDOWN_MS = 60 * 1000;

app.post("/api/video-feed/suggest", async (req, res) => {
  const { channel, website } = req.body || {};
  if (website) return res.json({ ok: true }); // honeypot tripped — pretend success, do nothing
  if (!channel || !String(channel).trim()) return res.status(400).json({ error: "Channel is required." });
  if (!YOUTUBE_API_KEY) return res.status(503).json({ error: "Video suggestions aren't available right now." });

  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const last = suggestCooldowns.get(ip) || 0;
  if (Date.now() - last < SUGGEST_COOLDOWN_MS) {
    return res.status(429).json({ error: "Please wait a moment before suggesting another channel." });
  }

  const identifier = normalizeYoutubeChannel(channel);
  let resolved;
  try {
    resolved = await resolveYoutubeUploadsPlaylist(identifier);
  } catch (err) {
    return res.status(400).json({ error: "Couldn't find that channel on YouTube — double-check the handle or URL." });
  }

  const existing = await dbGet(`SELECT id FROM feeds WHERE youtube_channel_id = ?`, [identifier]);
  if (existing) return res.status(409).json({ error: "That channel has already been suggested." });

  suggestCooldowns.set(ip, Date.now());
  await dbRun(
    `INSERT INTO feeds (outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, beat_keywords, items_per_feed, bluesky_handle, feed_type, youtube_channel_id, submission_status)
     VALUES (?, '', NULL, '', '', 'Indie Media', '{}', 3, '', 'outlet', ?, 'pending')`,
    [resolved.channelTitle, identifier]
  );
  res.json({ ok: true });
});

app.post("/api/feeds/:id/approve", requireAdmin, async (req, res) => {
  await dbRun(`UPDATE feeds SET submission_status = 'approved' WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// ---------- admin moderation: reader-submitted custom RSS sources ----------
// Same shape as the YouTube channel approve/reject flow above. Approving a
// custom source only affects whether it can show up in OTHERS' view/clone of
// a mix (see resolveMixSources/decision #5) — it already powers the
// submitting reader's own wire regardless of status. Rejecting reuses the
// existing per-owner DELETE route below (no separate admin-delete endpoint —
// an admin rejecting one is functionally the same row removal).
app.get("/api/admin/pending-custom-sources", requireAdmin, async (req, res) => {
  const rows = await dbAll(
    `SELECT ucs.id, ucs.name, ucs.feed_url, ucs.created_at, u.email AS submitted_by
     FROM user_custom_sources ucs JOIN users u ON u.id = ucs.user_id
     WHERE ucs.submission_status = 'pending' ORDER BY ucs.created_at ASC`
  );
  res.json(rows);
});

app.post("/api/admin/custom-sources/:id/approve", requireAdmin, async (req, res) => {
  await dbRun(`UPDATE user_custom_sources SET submission_status = 'approved' WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

app.delete("/api/admin/custom-sources/:id", requireAdmin, async (req, res) => {
  await dbRun(`DELETE FROM user_custom_sources WHERE id = ?`, [req.params.id]);
  res.json({ ok: true });
});

// Accepts either the stored value ('journalist') or the newer display-facing
// word ('individual') from any input source (bulk paste, suggest form, admin
// single-add, a future mobile client) and always resolves to the one value
// actually stored in the DB. Display layer was renamed to Individual/
// Organization; the stored feed_type enum deliberately was NOT, to avoid
// touching every feed_type === 'journalist' read-path in this file for a
// copy-only change. This is the one place that normalization has to happen
// consistently, regardless of which endpoint the input comes through.
function normalizeFeedType(input) {
  return ["journalist", "individual"].includes(String(input || "").trim().toLowerCase())
    ? "journalist"
    : "outlet";
}

// ---------- Feature A: suggest an outlet or journalist (public, unified feeds queue) ----------
// A PUBLIC suggestion — becomes a real shared outlet/journalist row in the
// curated `feeds` table (submission_status='pending'), NOT the private
// user_custom_sources flow. Reuses the exact same submission_status/approve
// pattern already used for reader-suggested YouTube channels — a suggested
// outlet/journalist just lands in the same pending queue admin already sees.
async function blueskyHandleResolves(handle) {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return false;
  const data = await resp.json();
  return Boolean(data && data.did);
}

const feedSuggestCooldowns = new Map(); // ip -> last-submit timestamp (separate from the YouTube suggest cooldown map)

app.post("/api/feeds/suggest", async (req, res) => {
  const { outlet, type, feed_url, bluesky_handle, website } = req.body || {};
  if (website) return res.json({ ok: true }); // honeypot tripped — pretend success, do nothing

  const outletName = String(outlet || "").trim();
  if (!outletName) return res.status(400).json({ error: "A name for the outlet or journalist is required." });
  const feedType = normalizeFeedType(type);
  const feedUrl = String(feed_url || "").trim();
  const handle = normalizeHandle(bluesky_handle);

  if (feedType === "journalist" && !handle) {
    return res.status(400).json({ error: "Individual suggestions need a Bluesky handle." });
  }
  if (feedType === "outlet" && !feedUrl && !handle) {
    return res.status(400).json({ error: "Outlet suggestions need an RSS feed URL, a Bluesky handle, or both." });
  }
  if (feedUrl && !/^https?:\/\//i.test(feedUrl)) {
    return res.status(400).json({ error: "Feed URL must be a valid http(s) URL." });
  }

  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const last = feedSuggestCooldowns.get(ip) || 0;
  if (Date.now() - last < SUGGEST_COOLDOWN_MS) {
    return res.status(429).json({ error: "Please wait a moment before suggesting another source." });
  }

  // dedupe against anything already in the curated table, pending or approved
  const existingByName = await dbGet(`SELECT id FROM feeds WHERE LOWER(outlet) = LOWER(?)`, [outletName]);
  if (existingByName) return res.status(409).json({ error: "A source with that name has already been suggested or added." });
  if (feedUrl) {
    const existingByUrl = await dbGet(`SELECT id FROM feeds WHERE feed_url = ?`, [feedUrl]);
    if (existingByUrl) return res.status(409).json({ error: "That feed URL has already been suggested or added." });
  }
  if (handle) {
    const existingByHandle = await dbGet(`SELECT id FROM feeds WHERE bluesky_handle = ?`, [handle]);
    if (existingByHandle) return res.status(409).json({ error: "That Bluesky handle has already been suggested or added." });
  }

  // Live-validate before it ever hits the pending queue — same spirit as the
  // YouTube channel suggest flow and the custom-sources RSS validation.
  if (feedUrl) {
    try {
      const resp = await fetch(feedUrl, {
        headers: { "User-Agent": "n38-cms/1.0 (+https://news-for-38-year-olds.onrender.com)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const parsed = xmlParser.parse(xml);
      const items = extractItems(parsed).filter((it) => it.title && it.link);
      if (items.length === 0) throw new Error("no items found");
    } catch (err) {
      return res.status(400).json({ error: "Couldn't read that as an RSS/Atom feed — double-check the URL." });
    }
  }
  if (handle) {
    let resolves = false;
    try { resolves = await blueskyHandleResolves(handle); } catch { resolves = false; }
    if (!resolves) {
      return res.status(400).json({ error: "Couldn't find that Bluesky handle — double-check it." });
    }
  }

  feedSuggestCooldowns.set(ip, Date.now());
  const info = await dbRun(
    `INSERT INTO feeds (outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, beat_keywords, items_per_feed, bluesky_handle, feed_type, youtube_channel_id, submission_status)
     VALUES (?, '', ?, '', '', 'Indie Media', '{}', 3, ?, ?, NULL, 'pending')`,
    [outletName, feedType === "journalist" ? null : (feedUrl || null), handle, feedType]
  );
  res.json({ id: info.lastInsertRowid, ok: true });
});

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
function extractImage(it, summaryHtml) {
  const mediaContent = it["media:content"];
  const mediaList = Array.isArray(mediaContent) ? mediaContent : (mediaContent ? [mediaContent] : []);
  const mediaImg = mediaList.find(m => (m["@_medium"] === "image") || (m["@_type"] || "").startsWith("image"));
  if (mediaImg?.["@_url"]) return mediaImg["@_url"];

  const thumb = it["media:thumbnail"];
  const thumbUrl = Array.isArray(thumb) ? thumb[0]?.["@_url"] : thumb?.["@_url"];
  if (thumbUrl) return thumbUrl;

  const enclosure = it.enclosure;
  if (enclosure?.["@_url"] && (enclosure["@_type"] || "").startsWith("image")) return enclosure["@_url"];

  const imgMatch = (summaryHtml || "").match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return null;
}

function extractItems(parsed) {
  const rssItems = parsed?.rss?.channel?.item;
  if (rssItems) {
    const items = Array.isArray(rssItems) ? rssItems : [rssItems];
    return items.map((it) => {
      const summaryHtml = textOf(it.description ?? it["content:encoded"]);
      return {
        title: textOf(it.title), link: textOf(it.link),
        pubDate: textOf(it.pubDate ?? it["dc:date"]),
        author: textOf(it["dc:creator"] ?? it.author),
        summary: summaryHtml,
        image: extractImage(it, summaryHtml),
      };
    });
  }
  const atomEntries = parsed?.feed?.entry;
  if (atomEntries) {
    const entries = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
    return entries.map((e) => {
      const linkField = Array.isArray(e.link) ? e.link[0] : e.link;
      const summaryHtml = textOf(e.summary ?? e.content);
      return {
        title: textOf(e.title), link: (linkField && linkField["@_href"]) || textOf(linkField),
        pubDate: textOf(e.updated ?? e.published), author: textOf(e.author?.name),
        summary: summaryHtml,
        image: extractImage(e, summaryHtml),
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
  const { outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, items_per_feed, bluesky_handle, feed_type, youtube_channel_id } = req.body;
  const handle = normalizeHandle(bluesky_handle);
  const ytChannel = normalizeYoutubeChannel(youtube_channel_id);
  const type = normalizeFeedType(feed_type);
  if (!outlet) return res.status(400).json({ error: "outlet is required" });
  if (type === "journalist" && !handle) return res.status(400).json({ error: "individual feeds need a Bluesky handle" });
  if (type === "outlet" && !feed_url && !handle && !ytChannel) return res.status(400).json({ error: "outlet is required, and either feed_url, bluesky_handle, or youtube_channel_id" });
  try {
    const info = await dbRun(
      `INSERT INTO feeds (outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, beat_keywords, items_per_feed, bluesky_handle, feed_type, youtube_channel_id, submission_status)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'approved')`,
      [outlet, default_author || "", type === "journalist" ? null : (feed_url || null), tip_url || "", subscribe_url || "", fallback_beat || "Indie Media", items_per_feed || 3, handle, type, ytChannel || null]
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
    const ytChannel = normalizeYoutubeChannel(f.youtube_channel_id);
    const type = normalizeFeedType(f.feed_type);
    if (!f.outlet) {
      errors.push(`Skipped a row — outlet name is required: ${JSON.stringify(f)}`);
      continue;
    }
    if (type === "journalist" && !handle) {
      errors.push(`Skipped ${f.outlet} — individual rows need a Bluesky handle.`);
      continue;
    }
    if (type === "outlet" && !f.feed_url && !handle && !ytChannel) {
      errors.push(`Skipped a row — needs outlet plus a feed URL, Bluesky handle, or YouTube channel: ${JSON.stringify(f)}`);
      continue;
    }
    try {
      await dbRun(
        `INSERT INTO feeds (outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, beat_keywords, items_per_feed, bluesky_handle, feed_type, youtube_channel_id, submission_status)
         VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'approved')`,
        [f.outlet, f.default_author || "", type === "journalist" ? null : (f.feed_url || null), f.tip_url || "", f.subscribe_url || "", f.fallback_beat || "Indie Media", f.items_per_feed || 3, handle, type, ytChannel || null]
      );
      added++;
    } catch (err) {
      errors.push(`${f.outlet}: ${err.message}`);
    }
  }
  res.json({ added, errors });
});

app.put("/api/feeds/:id", requireAdmin, async (req, res) => {
  const { outlet, default_author, feed_url, tip_url, subscribe_url, fallback_beat, items_per_feed, bluesky_handle, feed_type, youtube_channel_id } = req.body;
  const handle = normalizeHandle(bluesky_handle);
  const ytChannel = normalizeYoutubeChannel(youtube_channel_id);
  const type = normalizeFeedType(feed_type);
  if (!outlet) return res.status(400).json({ error: "outlet is required" });
  if (type === "journalist" && !handle) return res.status(400).json({ error: "individual feeds need a Bluesky handle" });
  if (type === "outlet" && !feed_url && !handle && !ytChannel) return res.status(400).json({ error: "outlet is required, and either feed_url, bluesky_handle, or youtube_channel_id" });
  try {
    // An admin editing/saving a feed doubles as the approval action for a
    // pending reader-submitted channel — no separate step needed.
    await dbRun(
      `UPDATE feeds SET outlet=?, default_author=?, feed_url=?, tip_url=?, subscribe_url=?, fallback_beat=?, items_per_feed=?, bluesky_handle=?, feed_type=?, youtube_channel_id=?, submission_status='approved'
       WHERE id=?`,
      [outlet, default_author || "", type === "journalist" ? null : (feed_url || null), tip_url || "", subscribe_url || "", fallback_beat || "Indie Media", items_per_feed || 3, handle, type, ytChannel || null, req.params.id]
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
      await seedYoutubeChannels();
      await dropDegenerateArtRss();
      await seedOfficialHeadlinesSpray();
      app.listen(PORT, () => console.log(`News for 38 Year Olds CMS running on http://localhost:${PORT}`));
      // Post once shortly after boot (not immediately — give the process a
      // moment to settle) so a fresh deploy doesn't cost up to a full
      // BLUESKY_BOT_INTERVAL_MINUTES of silence before you can tell it's
      // actually working. Safe to call on every restart: the NOT IN dedup
      // in pickTopStoryForBot() means it's a no-op if there's nothing new
      // to post, it never reposts something already in bluesky_bot_posts.
      if (BLUESKY_BOT_HANDLE && BLUESKY_BOT_APP_PASSWORD) {
        setTimeout(postDueHeadlineToBluesky, 15000);
        // Roundup's dedup guard is now DB-backed (bot_state table), not
        // in-memory, so this boot-time kick is safe the same way the
        // headlines bot's is: if the top skeet hasn't changed since the
        // last real post, this is a genuine no-op, not a duplicate.
        // Staggered a few seconds after the headlines kick so the two
        // don't fire in the same instant.
        setTimeout(postNerveCenterRoundupToBluesky, 20000);
      }
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
