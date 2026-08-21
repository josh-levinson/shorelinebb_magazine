# Shoreline Basketball — Weekly Summary

Generates a weekly writeup of the Shoreline men's basketball league
([leagues.teamlinkt.com/shorelinebball](https://leagues.teamlinkt.com/shorelinebball)):
game recaps, updated standings, and statistical movers-and-shakers.

## How the data works (the important part)

TeamLinkt is a server-rendered jQuery/DataTables site. The pages are public, but
the data endpoints require the site's own session context — hitting them with
plain `curl` returns empty. So the collector drives a **headless browser**
(Playwright), loads the real pages, and captures the JSON the site fetches.

Endpoints in play (association `10372`, current season `54723`):

| Data | Source | Notes |
|------|--------|-------|
| Standings | `GET /leagues/getStandings/10372/54723` | JSON: W/L, pts for/against, streak, rank, last-10 |
| Games + scores | `GET /leagues/getAllEvents/10372` | Final score appended to team cell as `(57)` once entered |
| Player stats (full) | `#stats_table` on the Players tab of `/Statistics` | 24 players × ~22 columns (pts, reb, ast, stl, blk, shooting). **Cumulative.** |
| Stat leaders | `GET /leagues/getLeadPlayerStatisticCardsJSON/54723` | Top-5 per stat (supplementary) |
| Per-game box score | `getPlayerStatsForEvent/10372` | Currently empty — see below |

### The cumulative-stats problem (and the fix)
The stats table only shows **season totals**, so the original approach was to
snapshot it every run and diff the two most recent snapshots:
`thisWeek = thisSnapshot − lastSnapshot`, per player, per stat.

**That diff is no longer the primary source — Hoopsalytics box scores are.**
TeamLinkt's cumulative table lags unpredictably: it sat on identical totals
across the 2026-08-09 and 2026-08-19 snapshots, then caught up three games at
once by 2026-08-21. Diffing across that produces a "week" containing however
many games the table happened to catch up on — which is how a 55-45 game once
reported an 81-point line. So `summarize.js` now prefers
`weeklyProductionFromBoxscores()`, summing the real per-game Hoopsalytics box
scores (see below) for exactly the games that went final this week, and falls
back to the cumulative diff only when those box scores aren't published yet.

### Stats availability / timing
Stats are produced by Hoopsalytics **over the weekend after game film is
analyzed**. As of the first snapshot (2026-06-25), only week 1 (June 17) is in
the totals (`GP=1`); the June 24 games and per-event box scores are still
pending. Per-event box scores (`getPlayerStatsForEvent`) return empty even for
analyzed games, so the **full cumulative table is the source of truth** — the
weekly diff gives us per-week lines without needing per-event box scores.
**Run the collector on Sunday/Monday**, after the weekend analysis lands.

## Hoopsalytics — advanced stats (draft board source)

TeamLinkt's basic box score is actually republished from **Hoopsalytics**, the
league's stats provider, which exposes far more per-player detail directly at
`hoopsalytics.com` — the site the draft board (`src/draft.js`) is valued from.

Hoopsalytics sits behind a login, but it's **email-only** (type your email,
you're in — no password). `src/collect-hoopsalytics.js` drives this with
Playwright, the same way `src/collect.js` drives TeamLinkt: log in, then load
`stats/show-league.php?season_id=19&view=<View>` for each of seven views
(Offense, Defense, Key Stats, Scouting, Shooting, Deluxe Stats, Shooting from
Sets) and scrape the rendered `#league-table` — this site is plain
server-rendered HTML per view, no pagination and no separate JSON endpoint to
sniff. The views are merged into one row per player (49 roster slots, one
unnamed/unused) and written to
`data/snapshots/<date>/hoopsalytics_stats.json`.

One quirk worth knowing if you touch the parser: the site renders player names
with `U+00A0` (non-breaking space) between first/last name, which breaks
name-keyed lookups unless normalized — `parsePlayerCell()` handles this.

Discovery notes and raw per-view captures (headers, sample rows, login-flow
HTML) live in `data/probe/hoopsalytics/` (gitignored) from
`src/probe-hoopsalytics.js` and `src/probe-hoopsalytics-views.js` — useful
reference if a view's columns change.

Set `HOOPSALYTICS_EMAIL` in `.env` (see `.env.example`) before running it.

## Layout

```
src/collect.js             # Playwright collector (TeamLinkt) → writes a weekly snapshot
src/collect-hoopsalytics.js # Playwright collector (Hoopsalytics) → advanced stats, draft board source
src/collect-hoopsalytics-boxscores.js # Playwright collector (Hoopsalytics) → per-game box scores, weekly stat source
src/draft.js                # draft board generator (valuation model + snake draft sim)
src/draft-page.js           # renders <date>-draft.json into the published <date>-draft-board.html
src/site.js                 # static-site builder → renders summaries/ into dist/ (the magazine)
src/magazine.css            # magazine stylesheet (copied to dist/style.css on build)
src/probe*.js                # one-off discovery scripts (kept for debugging)
data/snapshots/<date>/
  standings.json           # parsed standings
  games.json               # parsed games + scores + event ids
  player_stats.json        # full per-player cumulative stat lines (TeamLinkt) ← diff source
  hoopsalytics_stats.json  # full per-player advanced stat lines (Hoopsalytics) ← draft board source
  leaders.json             # top-5 leader cards
  boxscores/<id>.json      # per-event box score (empty until published)
  raw/                     # untouched JSON, for re-parsing if a layout changes
  manifest.json            # counts + season url
```

## Usage

```bash
npm install                        # first time
npx playwright install chromium    # first time
cp .env.example .env               # then fill in .env (API key for the article step, login email for Hoopsalytics)

npm run weekly                     # collect snapshot → deterministic summary → AI article
# or step by step:
npm run collect                    # writes data/snapshots/<today>/
npm run summary                    # writes summaries/<today>.md (deterministic; no API key needed)
npm run article                    # writes summaries/<today>-article.md (AI-written; needs API key)
npm run site                       # builds the magazine into dist/ (no API key needed)
node src/article.js 2026-06-29     # render a specific snapshot as "latest"

npm run collect:hoopsalytics       # writes data/snapshots/<today>/hoopsalytics_stats.json (needs HOOPSALYTICS_EMAIL)
npm run collect:hoopsalytics-boxscores  # writes data/snapshots/<today>/hoopsalytics_boxscores/ — the weekly stat source
npm run draft                      # writes summaries/<today>-draft.{md,json} from the latest snapshot
npm run draft:page                 # renders that into summaries/<today>-draft-board.html (published as dist/draft.html)
```

A full weekly run, in order:

```bash
npm run collect                        # TeamLinkt: schedule, scores, standings
npm run collect:hoopsalytics           # Hoopsalytics: advanced per-player season stats
npm run collect:hoopsalytics-boxscores # Hoopsalytics: per-game box scores (weekly stat lines)
npm run summary                        # deterministic summary, from the box scores
npm run article                        # AI recap (needs ANTHROPIC_API_KEY)
npm run draft && npm run draft:page    # refresh the draft board
npm run site                           # rebuild dist/
```

Note that `npm run weekly` still runs only the TeamLinkt collect → summary →
article → site chain; run the two Hoopsalytics collectors before it if you want
the summary sourced from real per-game box scores rather than the fallback diff.

`npm run weekly` now ends by building the site, so a normal run produces the
snapshot, both markdown outputs, **and** the rebuilt `dist/`.

**Run it Sunday or Monday**, after the weekend stats analysis lands. Each run
produces two outputs from the same snapshot data:

- **`summaries/<date>.md`** — a deterministic, structured summary (game recaps,
  standings with rank movement ▲/▼, movers & shakers). No API key required.
- **`summaries/<date>-article.md`** — an **AI-written, ESPN-style recap article**.
  Claude (`claude-opus-4-8`) turns the same structured data into a narrative
  column. It's instructed to use only the real numbers — no invented quotes or
  stats about real players. Needs a Claude API key (get one at
  [console.anthropic.com](https://console.anthropic.com/)): put it in a `.env`
  file as `ANTHROPIC_API_KEY=sk-ant-...` (copy `.env.example`), or export it in
  your shell. `.env` is gitignored.

Leading scorers and weekly lines come from the Hoopsalytics per-game box scores
for the games that went final that week — real per-game data, so a lagging
cumulative table can't smear several games into one "week". If those box scores
aren't available, the summary falls back to the snapshot diff (a player's
week-over-week stat delta), and says so in its footer credit.

## Status

- [x] **Collector** (`src/collect.js`) — standings, games/scores, full player stats, leaders. Validated live.
- [x] **Hoopsalytics collector** (`src/collect-hoopsalytics.js`) — advanced per-player stats across 7 views. Validated live.
- [x] **Analyzer** (`src/lib.js`) — snapshot diff → weekly production; standings movement; double-doubles.
- [x] **Summarizer** (`src/summarize.js`) — renders the deterministic `summaries/<date>.md`.
- [x] **Article writer** (`src/article.js`) — Claude-written ESPN-style `summaries/<date>-article.md`.
- [x] **Draft board** (`src/draft.js`) — valuation model + snake draft sim, sourced from Hoopsalytics. Manual step, not part of `npm run weekly`.
- [x] **Draft board page** (`src/draft-page.js`) — renders the board JSON into the published HTML page.

### Possible next steps
- Auto-email the article each week (your Gmail is connected to Claude Code).
- Tune the article's voice/length in `src/article.js` (system prompt + `effort`).

## Publishing (the magazine)

Each week becomes an **issue**: the AI article is the feature column and the
deterministic summary is reproduced below it as "The Record" (box scores,
standings, stat leaders). `src/site.js` renders `summaries/*.md` into a static
magazine in `dist/` — plain HTML + one stylesheet, no framework.

The masthead also links to a **Draft Board** page. `src/site.js` picks up the
newest `summaries/<date>-draft-board.html` (a self-contained page —
title/style/script with the draft data inlined) and publishes it as
`dist/draft.html`; if none exists, the nav link is simply omitted.

`npm run draft:page` produces that file. The board's design was hand-built once
and is carried forward as a template: the generator takes the most recent
existing `-draft-board.html`, swaps in the new week's `DATA` blob from
`summaries/<date>-draft.json`, and refreshes the derived numbers baked into the
surrounding prose (player/round counts, the recorded-games denominator and its
availability multiplier table, the GP range, the "Through &lt;date&gt;" line,
the footer credit). Two lines are genuinely editorial — the value curve's note
and the "Reading the board" paragraph — and are regenerated from the top of the
board; reword them in `src/draft-page.js` if the board's shape changes.

`dist/` is a build artifact (gitignored). It's published to **GitHub Pages** by
`.github/workflows/pages.yml`, which runs on every push to `main`: it builds the
site from the committed markdown and deploys it. So the weekly rhythm is:

```bash
npm run weekly          # collect → summary → article → site
git add summaries/      # commit the week's new markdown
git commit -m "Issue: week of <date>"
git push                # the Action rebuilds dist/ and deploys to Pages
```

One-time setup: in the repo's **Settings → Pages**, set **Source: GitHub
Actions**. After the first successful run the site is live at
`https://<user>.github.io/<repo>/`.
