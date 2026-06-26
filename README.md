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
The stats table only shows **season totals**. To know what someone did *this
week*, the collector saves a timestamped snapshot every run; the analyzer diffs
the two most recent snapshots. `thisWeek = thisSnapshot − lastSnapshot`, per
player, per stat. That diff is the movers-and-shakers engine.

### Stats availability / timing
Stats are produced by Hoopsalytics **over the weekend after game film is
analyzed**. As of the first snapshot (2026-06-25), only week 1 (June 17) is in
the totals (`GP=1`); the June 24 games and per-event box scores are still
pending. Per-event box scores (`getPlayerStatsForEvent`) return empty even for
analyzed games, so the **full cumulative table is the source of truth** — the
weekly diff gives us per-week lines without needing per-event box scores.
**Run the collector on Sunday/Monday**, after the weekend analysis lands.

## Layout

```
src/collect.js        # Playwright collector → writes a weekly snapshot
src/site.js           # static-site builder → renders summaries/ into dist/ (the magazine)
src/magazine.css      # magazine stylesheet (copied to dist/style.css on build)
src/probe*.js         # one-off discovery scripts (kept for debugging)
data/snapshots/<date>/
  standings.json      # parsed standings
  games.json          # parsed games + scores + event ids
  player_stats.json   # full per-player cumulative stat lines  ← diff source
  leaders.json        # top-5 leader cards
  boxscores/<id>.json # per-event box score (empty until published)
  raw/                # untouched JSON, for re-parsing if a layout changes
  manifest.json       # counts + season url
```

## Usage

```bash
npm install                        # first time
npx playwright install chromium    # first time
cp .env.example .env               # then paste your key into .env (for the AI article step)

npm run weekly                     # collect snapshot → deterministic summary → AI article
# or step by step:
npm run collect                    # writes data/snapshots/<today>/
npm run summary                    # writes summaries/<today>.md (deterministic; no API key needed)
npm run article                    # writes summaries/<today>-article.md (AI-written; needs API key)
npm run site                       # builds the magazine into dist/ (no API key needed)
node src/article.js 2026-06-29     # render a specific snapshot as "latest"
```

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

Leading scorers and weekly lines come from the snapshot diff: since each team
plays once a week, a player's week-over-week stat delta *is* their line in that
week's game. The first run is a baseline (no diff yet); movement and true
per-week lines kick in on the second run.

## Status

- [x] **Collector** (`src/collect.js`) — standings, games/scores, full player stats, leaders. Validated live.
- [x] **Analyzer** (`src/lib.js`) — snapshot diff → weekly production; standings movement; double-doubles.
- [x] **Summarizer** (`src/summarize.js`) — renders the deterministic `summaries/<date>.md`.
- [x] **Article writer** (`src/article.js`) — Claude-written ESPN-style `summaries/<date>-article.md`.

### Possible next steps
- Auto-email the article each week (your Gmail is connected to Claude Code).
- Tune the article's voice/length in `src/article.js` (system prompt + `effort`).

## Publishing (the magazine)

Each week becomes an **issue**: the AI article is the feature column and the
deterministic summary is reproduced below it as "The Record" (box scores,
standings, stat leaders). `src/site.js` renders `summaries/*.md` into a static
magazine in `dist/` — plain HTML + one stylesheet, no framework.

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
