# News for 38 Year Olds — CMS

A minimal, working newsroom CMS: public front page (Dispatch View + Drudge-style
Wire View), an admin dashboard with stats, and a feed importer that reuses the
RSS ingestion logic from earlier.

## Setup
```
cd n38-cms
npm install
node seed.mjs      # loads the 9 real Handbasket dispatches to start
node server.mjs    # starts the site at http://localhost:3000
```

Front page: `http://localhost:3000`
Admin dashboard: `http://localhost:3000/admin.html`
Default admin password: `letmein` — change it by setting an environment
variable before starting the server: `ADMIN_PASSWORD=your-password node server.mjs`

## What's in the CMS
- **Add/edit/delete dispatches** by hand, with a "pin to top" checkbox — a
  pinned story becomes the big lead headline in Wire View, same role as
  Drudge's top banner story.
- **Import from feeds.json** — one button re-runs the same RSS-pulling logic
  as the standalone ingestion script, skipping anything already in the
  database (deduped by link).
- **Stats**: total dispatches, outbound clicks per story (every public link
  routes through `/go/:id` so clicks get counted), tip-button clicks, views
  by Dispatch View vs. Wire View, and clicks broken down by section.

## The two front-page views
- **Dispatch View** — the card-based layout from before: byline, headline,
  excerpt, tip slider, subscribe button.
- **Wire View** — a dense, Drudge-style link list: one big pinned headline up
  top, then three columns of plain bold headline links grouped by section
  (Politics, Immigration, Data Centers, etc.), no cards, no excerpts, built
  for fast scanning and fast click-through.

Both pull from the same `/api/dispatches` endpoint, so adding one dispatch
updates both views.

## Adding more publications
Add entries to `feeds.json` (same format as before — outlet name, default
author, feed URL, beat keywords) then hit "Run import now" in the admin
dashboard, or run `node -e "..."` — actually simplest is just clicking the
button once the server's running.

## Where this needs to run for real
This sandbox can't reach arbitrary external RSS feeds (its network is locked
to package registries), so feed imports will fail here — that's expected.
Run this on your own machine, a small VPS, or something like Render/Fly.io/a
Raspberry Pi with a real internet connection, and imports will work normally.

## Known limitations (it's a real MVP, not production-hardened)
- Auth is a single shared password in a request header — fine for one admin,
  not built for multiple editors or public-facing security.
- SQLite file (`n38.db`) — perfectly fine at this scale, would want Postgres
  if this grows to many writers and heavy traffic.
- Tip amounts are tracked as clicks/intent only — there's no real payment
  processor wired in yet (that'd be a Stripe Connect integration, so tips
  route directly to each writer's own account).
