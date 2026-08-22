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
| Player stats (full) | `#stats_table` on the Players tab of `/Statistics` | **Archived only, never published** — see the sourcing rule below |
| Stat leaders | `GET /leagues/getLeadPlayerStatisticCardsJSON/54723` | Top-5 per stat (supplementary) |
| Per-game box score | `getPlayerStatsForEvent/10372` | Not used — lags Hoopsalytics badly |

## The sourcing rule

**Player statistics for the articles and the draft board come from Hoopsalytics
and never from TeamLinkt.** TeamLinkt is used only for league-administrative
data: the schedule, final scores, and standings.

The reason is that TeamLinkt republishes Hoopsalytics' numbers into a cumulative
season-totals table that lags unpredictably. It sat on identical totals across
the 2026-08-09 and 2026-08-19 snapshots, then caught up three games at once by
2026-08-21. Deriving a week by diffing consecutive snapshots of that table
(`thisWeek = thisSnapshot − lastSnapshot`) therefore yields a "week" containing
however many games the table happened to catch up on — which is how a 55-45 game
once reported an 81-point line. These are real, named people, and that number
went into a published column about them.

So there is **no TeamLinkt stat path left in the code to fall back to**.
`src/lib.js` exposes exactly one weekly-production function,
`weeklyProductionFromBoxscores()`, which sums real Hoopsalytics per-game box
scores for exactly the games that went final this week; `requireWeeklyProduction()`
wraps it and **throws** when this week's box scores aren't scored yet.
`summarize.js` and `article.js` exit with an actionable message in that case, and
`loadSnapshot()` deliberately does not expose TeamLinkt's `player_stats.json` at
all (`collect.js` still archives the file, but nothing reads it). Publishing a
day late beats publishing wrong numbers about real players.

### Stats availability / timing
Stats are produced by Hoopsalytics **over the weekend after game film is
analyzed**, so a game stays "pending" on hoopsalytics.com until then and its box
score simply doesn't exist yet. **Run the pipeline Sunday/Monday**, after the
weekend analysis lands. If you run it too early, `npm run weekly` stops at the
summary step and tells you which events are missing — that's working as intended,
not a bug to route around.

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
src/collect.js             # Playwright collector (TeamLinkt) → schedule, scores, standings
src/collect-hoopsalytics.js # Playwright collector (Hoopsalytics) → advanced stats, draft board source
src/collect-hoopsalytics-boxscores.js # Playwright collector (Hoopsalytics) → per-game box scores, weekly stat source
src/draft.js                # draft board generator (valuation model + snake draft sim)
src/draft-page.js           # renders <date>-draft.json into the published <date>-draft-board.html
src/site.js                 # static-site builder → renders summaries/ into dist/ (the magazine)
src/magazine.css            # magazine stylesheet (copied to dist/style.css on build)
src/week-status.js          # "is there a week to publish, and are its stats in?" probe
src/probe*.js                # one-off discovery scripts (kept for debugging)
scripts/weekly-run.sh       # unattended runner — see "Running it on a schedule"
scripts/systemd/            # user timer units for that runner
data/snapshots/<date>/
  standings.json           # parsed standings
  games.json               # parsed games + scores + event ids
  player_stats.json        # TeamLinkt cumulative stats — ARCHIVE ONLY, never read
  hoopsalytics_stats.json  # full per-player advanced stat lines (Hoopsalytics) ← draft board source
  hoopsalytics_boxscores/<event_id>.json  # per-game lines (Hoopsalytics) ← the ONLY weekly stat source
  leaders.json             # top-5 leader cards
  boxscores/<id>.json      # TeamLinkt per-event box score — archive only, never read
  raw/                     # untouched JSON, for re-parsing if a layout changes
  manifest.json            # counts + season url
```

## Usage

```bash
npm install                        # first time
npx playwright install chromium    # first time
cp .env.example .env               # then fill in .env (API key for the article step, login email for Hoopsalytics)

npm run weekly                     # collect (TeamLinkt + Hoopsalytics box scores) → summary → article → site
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

`npm run weekly` covers all of that except the draft board: it runs
`collect` → `collect:hoopsalytics-boxscores` → `summary` → `article` → `site`,
so a normal run produces the snapshot, both markdown outputs, **and** the
rebuilt `dist/`. The box-score collector is in the chain because the summary and
article now require it — there is no TeamLinkt fallback, so `weekly` stops with
an actionable error if Hoopsalytics hasn't scored this week's games yet.

`npm run collect:hoopsalytics` (season-long advanced stats) stays out of the
chain; it's only needed for the draft board, which is still a manual step.

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
aren't available, both steps stop and tell you which events are missing; they do
not fall back to TeamLinkt. See [the sourcing rule](#the-sourcing-rule).

## Status

- [x] **Collector** (`src/collect.js`) — standings, games/scores, leaders. Validated live.
- [x] **Hoopsalytics collector** (`src/collect-hoopsalytics.js`) — advanced per-player stats across 7 views. Validated live.
- [x] **Box-score collector** (`src/collect-hoopsalytics-boxscores.js`) — per-game lines; the only weekly stat source.
- [x] **Analyzer** (`src/lib.js`) — box scores → weekly production; standings movement; double-doubles.
- [x] **Summarizer** (`src/summarize.js`) — renders the deterministic `summaries/<date>.md`.
- [x] **Article writer** (`src/article.js`) — Claude-written ESPN-style `summaries/<date>-article.md`.
- [x] **Draft board** (`src/draft.js`) — valuation model + snake draft sim, sourced from Hoopsalytics. Manual step, not part of `npm run weekly`.
- [x] **Draft board page** (`src/draft-page.js`) — renders the board JSON into the published HTML page.
- [x] **Scheduled runner** (`scripts/weekly-run.sh` + `src/week-status.js`) — twice-daily timer that publishes the week as soon as Hoopsalytics has scored it.

### Possible next steps
- Auto-email the article each week (your Gmail is connected to Claude Code).
- Move the scheduled runner into GitHub Actions so it doesn't need this machine
  powered on (needs `HOOPSALYTICS_EMAIL` + `ANTHROPIC_API_KEY` as repo secrets
  and `contents: write` to commit the issue back).
- Tune the article's voice/length in `src/article.js` (system prompt + `effort`).

## Running it on a schedule

`scripts/weekly-run.sh` is `npm run weekly` plus the judgement calls a human
makes: is there a new week to write about, and have the stats landed yet? It's
driven by a systemd user timer that fires **twice a day, every day**.

Daily-and-idempotent rather than "Wednesday at 9pm" is deliberate. Games are
Wednesday, but Hoopsalytics scores the film anywhere from Wednesday night to
Friday night; playoff games move to Tuesday and Thursday; and the box's clock is
UTC while the league's isn't. A schedule that tries to predict all that will be
wrong. Instead each run asks the repo what to do:

| Situation | What the run does |
|---|---|
| No games finalized since the last issue | quiet no-op |
| New games, box scores not all scored yet | quiet no-op, try again in 12h |
| New games, every box score present | build → commit → push → Pages deploys |
| Every new game was a forfeit | logs **NEEDS ATTENTION** (see below) |

So a normal week publishes itself the first time it can, whether that's Thursday
morning or Sunday night, and the playoff schedule change needs no edit.

### The one non-obvious part

A run that *doesn't* publish deletes the snapshot it just collected. This is
load-bearing, not tidiness. `summarize.js` derives "this week" by diffing
today's snapshot against **the previous snapshot directory**
(`newlyFinalGames()`). Left behind, a Thursday snapshot taken while stats were
still pending would become Friday's baseline — and Friday's diff would then find
zero new games and cheerfully publish an **empty issue** for a week that had
three. Discarding keeps the invariant the diff relies on: *the newest snapshot is
the last published issue.* A snapshot that was already on disk before the run
isn't touched.

`src/week-status.js` is the readiness check, and it's stricter than
`requireWeeklyProduction()`, which publishes as soon as *one* box score exists.
That's fine for a one-game week and wrong for a playoff week with two game days
— it would publish an issue covering both games carrying only the first game's
stat lines. The runner waits for all of them. Forfeits are excluded from the
wait, since a 2-0 forfeit never gets a box score.

Run it by hand any time to see where a week stands:

```bash
npm run week:status          # new_games / missing / ready=yes|no
```

### Install

```bash
npx playwright install --with-deps chromium        # needs sudo; one time
cp scripts/systemd/shorelinebb-weekly.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now shorelinebb-weekly.timer
```

`Persistent=true` means a run missed while the machine was off happens on the
next boot, and `loginctl enable-linger` (already on) keeps the timer running
without a login session.

```bash
systemctl --user list-timers shorelinebb-weekly    # when it next fires
journalctl --user -u shorelinebb-weekly -n 50      # what the last runs did
tail -f ~/.local/state/shorelinebb/weekly.log      # same, kept longer
PUBLISH=0 npm run weekly:auto                      # build but don't commit/push
systemctl --user start shorelinebb-weekly.service  # force a run now
```

### When it wants a human

Two cases don't self-resolve, both loud in the log:

- **All-forfeit week** — no box score will ever exist, so the stats gate never
  opens. Write that week by hand or skip it.
- **A step failed after the stats were verified good** (article/site/git). The
  snapshot is deliberately *kept* so you can inspect it, and the service exits
  non-zero, so `systemctl --user status` shows it red.

The draft board stays manual — `npm run draft && npm run draft:page` — same as
before.

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
