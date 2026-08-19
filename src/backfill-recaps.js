// Backfill: reconstructs weekly recaps for weeks that never got a live
// snapshot, using the real per-event box scores that collect.js already
// captured (it re-fetches getPlayerStatsForEvent for every finalized game on
// every run, not just new ones — so the most recent snapshot's boxscores/
// directory holds real per-player lines for most of the season, not just the
// most recent week).
//
// Unlike the live pipeline (which diffs two cumulative-stats snapshots),
// this reads each game's box score directly, so it's exact per-game data —
// no lumping of skipped weeks into one mega-diff. Standings are reconstructed
// by replaying every final game chronologically (win/loss, points for/against);
// rank ties are broken by point differential, which may not always match the
// league's own (undocumented) tiebreak rules.
//
// A week is skipped if either: every one of its games is already covered by
// an existing summaries/<stamp>.md (idempotent — safe to re-run), or none of
// its games have box-score data yet (stats not analyzed by Hoopsalytics yet).
//
// Usage:  node src/backfill-recaps.js             # deterministic recaps only
//         node src/backfill-recaps.js --articles   # + an AI article per backfilled week (costs API calls)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
try {
  process.loadEnvFile();
} catch { /* no .env file — rely on the ambient environment */ }
import {
  SNAP_ROOT, COUNT_STATS, listSnapshots, loadSnapshot, newlyFinalGames,
  renderSummaryMarkdown, buildArticleData, generateArticle,
} from "./lib.js";

const withArticles = process.argv.includes("--articles");

const snaps = listSnapshots();
if (snaps.length === 0) {
  console.error("No snapshots found. Run `npm run collect` first.");
  process.exit(1);
}
const latest = snaps[snaps.length - 1];
const SNAP = `${SNAP_ROOT}/${latest}`;
const BOX = `${SNAP}/boxscores`;
const HBOX = `${SNAP}/hoopsalytics_boxscores`;

const games = JSON.parse(readFileSync(`${SNAP}/games.json`, "utf8"))
  .filter((g) => g.final)
  .sort((a, b) => a.ts - b.ts);

// ---- which games already have a real (non-backfilled) recap ---------------
const alreadyCovered = new Set();
for (let i = 0; i < snaps.length; i++) {
  const stamp = snaps[i];
  if (!existsSync(`summaries/${stamp}.md`)) continue;
  const curr = loadSnapshot(stamp);
  const prev = i > 0 ? loadSnapshot(snaps[i - 1]) : null;
  for (const g of newlyFinalGames(curr, prev)) alreadyCovered.add(g.event_id);
}

// ---- box score parsing ------------------------------------------------------
// stat_types is the league's stat dictionary (id -> {name, abbreviation}) —
// identical across events, so grab it once from the first usable file.
let abbrevById = null;
function loadStatTypes(payload) {
  if (abbrevById) return;
  abbrevById = new Map();
  for (const teamBlock of Object.values(payload.stat_types)) {
    for (const [id, info] of Object.entries(teamBlock)) {
      if (id === "all" || id === "group") continue;
      if (info?.abbreviation) abbrevById.set(id, info.abbreviation);
    }
    break;
  }
}

// Parses one event's box score file into per-player weekly lines (same shape
// weeklyProduction() produces, minus GP/MIN which per-game box scores don't carry).
// Prefers TeamLinkt's own box score (getPlayerStatsForEvent, captured by
// collect.js) — that's what already-generated recaps/articles for earlier
// weeks were written from, so keep using it where it exists rather than
// silently drifting their numbers. Falls back to hoopsalytics.com directly
// (collect-hoopsalytics-boxscores.js) only for games TeamLinkt hasn't
// republished yet but hoopsalytics has already fully scored.
function parseBoxscore(event_id) {
  const rows = parseTeamlinktBoxscore(event_id);
  if (rows) return rows;

  const hoopPath = `${HBOX}/${event_id}.json`;
  if (existsSync(hoopPath)) {
    try {
      const hoopRows = JSON.parse(readFileSync(hoopPath, "utf8"));
      if (hoopRows.length > 0) return hoopRows;
    } catch { /* no usable data from either source */ }
  }
  return null;
}

function parseTeamlinktBoxscore(event_id) {
  const path = `${BOX}/${event_id}.json`;
  if (!existsSync(path)) return null;
  let json;
  try { json = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const payload = json?.payload;
  if (!payload?.stats || Object.keys(payload.stats).length === 0) return null;
  loadStatTypes(payload);

  const rows = [];
  for (const [team_id, block] of Object.entries(payload.stats)) {
    const roster = payload.rosters[team_id] || {};
    for (const [player_id, statDict] of Object.entries(block.statistic || {})) {
      const name = roster[player_id]?.name;
      if (!name) continue;
      const weekly = {};
      for (const s of COUNT_STATS) weekly[s] = 0;
      for (const [statId, entry] of Object.entries(statDict)) {
        const abbrev = abbrevById.get(statId);
        if (abbrev && COUNT_STATS.includes(abbrev)) weekly[abbrev] = Number(entry.value) || 0;
      }
      const played_this_week = Object.values(weekly).some((v) => v > 0);
      weekly.GP = played_this_week ? 1 : 0;
      rows.push({ name, team_id: Number(team_id), weekly, played_this_week });
    }
  }
  return rows;
}

// ---- group games into weeks -------------------------------------------------
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function isoFromLongDate(s) {
  // "Wed Jun 24, 2026" -> "2026-06-24" (parsed manually to sidestep local-TZ shifts)
  const m = s.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const [, mon, day, year] = m;
  const mi = MONTHS[mon];
  if (mi == null) return null;
  return `${year}-${String(mi + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const weeks = new Map(); // iso date -> games[]
for (const g of games) {
  const iso = isoFromLongDate(g.date);
  if (!iso) continue;
  if (!weeks.has(iso)) weeks.set(iso, []);
  weeks.get(iso).push(g);
}
const weekDates = [...weeks.keys()].sort();

// ---- team names --------------------------------------------------------------
const teamNames = new Map();
for (const g of games) {
  teamNames.set(g.home.team_id, g.home.name);
  teamNames.set(g.away.team_id, g.away.name);
}
const teamOf = (id) => teamNames.get(id) || "Unknown";

// ---- simulate standings week by week -----------------------------------------
// Replays every final game in order; PF/PA/W/L are exact, rank is our own
// (win% desc, then point diff desc, then PF desc) — may not match the
// league's own tiebreak rules if any ties occur.
const record = new Map(); // team_id -> { w, l, pf, pa, results: ["W"|"L", ...] }
function ensure(id) {
  if (!record.has(id)) record.set(id, { w: 0, l: 0, pf: 0, pa: 0, results: [] });
  return record.get(id);
}
// Single forward pass — mutates `record` once per week and snapshots the
// resulting table, so later lookups (recap loop, sanity check) just read the
// snapshot instead of re-applying games and double-counting.
const standingsByWeek = new Map(); // iso date -> rows
for (const dateIso of weekDates) {
  for (const g of weeks.get(dateIso)) {
    const h = ensure(g.home.team_id), a = ensure(g.away.team_id);
    h.pf += g.home.score; h.pa += g.away.score;
    a.pf += g.away.score; a.pa += g.home.score;
    if (g.home.score > g.away.score) { h.w++; a.l++; h.results.push("W"); a.results.push("L"); }
    else { a.w++; h.l++; a.results.push("W"); h.results.push("L"); }
  }
  const rows = [...record.entries()].map(([team_id, r]) => {
    const gp = r.w + r.l;
    const streakType = r.results.at(-1);
    let streakLen = 0;
    for (let i = r.results.length - 1; i >= 0 && r.results[i] === streakType; i--) streakLen++;
    return {
      team_id, team: teamOf(team_id), gp, w: r.w, l: r.l,
      pct: gp ? r.w / gp : 0, pf: r.pf, pa: r.pa, diff: r.pf - r.pa,
      streak: `${streakType}${streakLen}`,
    };
  });
  rows.sort((x, y) => y.pct - x.pct || y.diff - x.diff || y.pf - x.pf);
  rows.forEach((r, i) => (r.rank = i + 1));
  standingsByWeek.set(dateIso, rows);
}

// ---- generate one recap per uncovered, analyzed week --------------------------
mkdirSync("summaries", { recursive: true });
let prevRank = null;
let written = 0;
const articleTargets = []; // { dateIso, data } for weeks written this run, when --articles is set
for (const dateIso of weekDates) {
  const weekGames = weeks.get(dateIso);
  const standings = standingsByWeek.get(dateIso);

  const covered = weekGames.every((g) => alreadyCovered.has(g.event_id));
  if (covered) {
    prevRank = new Map(standings.map((t) => [t.team_id, t.rank]));
    continue;
  }

  const production = [];
  const analyzedIds = [];
  for (const g of weekGames) {
    const rows = parseBoxscore(g.event_id);
    if (rows) { production.push(...rows); analyzedIds.push(g.event_id); }
  }
  if (analyzedIds.length === 0) {
    console.log(`Skipping week of ${dateIso}: no box-score data yet (stats not analyzed).`);
    prevRank = new Map(standings.map((t) => [t.team_id, t.rank]));
    continue;
  }

  const md = renderSummaryMarkdown({
    target: dateIso,
    baseline: false,
    games: weekGames,
    standings,
    prevRank,
    production,
    teamOf,
    sourceNote: `Backfilled from box-score data for event(s) ${analyzedIds.join(", ")} `
      + `(no live snapshot was collected the week of ${dateIso}). `
      + `Standings are reconstructed by replaying game results — ranking may not `
      + `exactly match the league's own tiebreak rules.`,
  });
  writeFileSync(`summaries/${dateIso}.md`, md);
  console.log(`Wrote summaries/${dateIso}.md (${weekGames.length} games, ${analyzedIds.length} with box scores, ${production.length} player lines)`);
  written++;

  if (withArticles) {
    const data = buildArticleData({
      league: "Shoreline adult men's basketball league",
      venue: "East Shoreline Catholic Academy",
      target: dateIso,
      baseline: false,
      games: weekGames,
      standings,
      prevRank,
      production,
      teamOf,
      note: "Player stats below are this week's real box-score line stats for every game that "
        + "week (not a cumulative diff — full per-game data). This recap is being written after "
        + "the fact from historical box scores; write it as a normal weekly recap of that week, "
        + "not as breaking news.",
    });
    articleTargets.push({ dateIso, data });
  }

  prevRank = new Map(standings.map((t) => [t.team_id, t.rank]));
}

console.log(`\nBackfilled ${written} week(s).`);

if (withArticles) {
  for (const { dateIso, data } of articleTargets) {
    const path = `summaries/${dateIso}-article.md`;
    if (existsSync(path)) { console.log(`\nSkipping article for ${dateIso}: ${path} already exists.`); continue; }
    console.log(`\nGenerating article for week of ${dateIso} …\n`);
    let article;
    try {
      article = await generateArticle(data, { baseline: false, onText: (t) => process.stderr.write(t) });
    } catch (e) {
      console.error(`\nArticle generation failed for ${dateIso}: ${e.message}`);
      continue;
    }
    writeFileSync(path, article.trim() + "\n");
    console.log(`\nWrote ${path}`);
  }
}

// ---- sanity check against real snapshots -------------------------------------
// Where a real snapshot exists, W/L/PF/PA from replaying exactly the games it
// had marked final should match its own standings.json exactly (only
// rank/tiebreak order might legitimately differ). Replaying that snapshot's
// own final-game set (rather than a date cutoff) avoids false mismatches from
// snapshots collected before a week's finals had posted.
for (const stamp of snaps) {
  const real = JSON.parse(readFileSync(`${SNAP_ROOT}/${stamp}/standings.json`, "utf8"));
  if (real.length === 0) continue;
  const realFinalIds = new Set(
    JSON.parse(readFileSync(`${SNAP_ROOT}/${stamp}/games.json`, "utf8"))
      .filter((g) => g.final)
      .map((g) => g.event_id),
  );
  const rec = new Map();
  for (const g of games) {
    if (!realFinalIds.has(g.event_id)) continue;
    const h = ensure2(rec, g.home.team_id), a = ensure2(rec, g.away.team_id);
    h.pf += g.home.score; h.pa += g.away.score;
    a.pf += g.away.score; a.pa += g.home.score;
    if (g.home.score > g.away.score) { h.w++; a.l++; } else { a.w++; h.l++; }
  }
  let mismatches = 0;
  for (const t of real) {
    const s = rec.get(t.team_id);
    if (!s || s.w !== t.w || s.l !== t.l || s.pf !== t.pf || s.pa !== t.pa) mismatches++;
  }
  console.log(
    mismatches
      ? `Sanity check vs ${stamp}: ${mismatches} team(s) mismatch on W/L/PF/PA.`
      : `Sanity check vs ${stamp}: simulated standings match real W/L/PF/PA. ✓`,
  );
}
function ensure2(map, id) {
  if (!map.has(id)) map.set(id, { w: 0, l: 0, pf: 0, pa: 0 });
  return map.get(id);
}
