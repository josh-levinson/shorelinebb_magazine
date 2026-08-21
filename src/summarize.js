// Summarizer: reads the two most recent snapshots and writes a weekly
// markdown summary — game recaps, standings (with movement), and
// movers-and-shakers (weekly production diff).
//
// Usage:  node src/summarize.js            # latest two snapshots
//         node src/summarize.js 2026-06-29 # treat this stamp as "latest"
import { mkdirSync, writeFileSync } from "node:fs";
import {
  listSnapshots, loadSnapshot, weeklyProduction, weeklyProductionFromBoxscores,
  newlyFinalGames, teamNameById, renderSummaryMarkdown,
} from "./lib.js";

const stamps = listSnapshots();
if (stamps.length === 0) {
  console.error("No snapshots found. Run `npm run collect` first.");
  process.exit(1);
}
const target = process.argv[2] || stamps[stamps.length - 1];
const idx = stamps.indexOf(target);
if (idx === -1) {
  console.error(`Snapshot ${target} not found. Have: ${stamps.join(", ")}`);
  process.exit(1);
}
const curr = loadSnapshot(target);
const prev = idx > 0 ? loadSnapshot(stamps[idx - 1]) : null;
const baseline = !prev;

const names = teamNameById(curr);
const teamOf = (id) => names.get(id) || "Unknown";
const games = newlyFinalGames(curr, prev);
const prevRank = new Map((prev?.standings ?? []).map((t) => [t.team_id, t.rank]));

// Prefer Hoopsalytics' real per-game box scores; fall back to the cumulative
// TeamLinkt diff only when this week's box scores aren't published yet. The
// diff is the lossy path — see weeklyProductionFromBoxscores() for why.
const teamCodeByName = new Map(curr.players.map((p) => [p.Name, p.Team]));
const boxProduction = weeklyProductionFromBoxscores(target, games, { teamCodeByName });
const production = boxProduction ?? weeklyProduction(curr, prev);
const source = boxProduction
  ? `Player stats from Hoopsalytics per-game box scores for event(s) `
    + `${games.map((g) => g.event_id).join(", ")}.`
  : `Generated from ${target}` + (prev ? ` vs ${prev.stamp}` : ` (baseline)`)
    + ` (cumulative-stats diff — no Hoopsalytics box scores available).`;

const md = renderSummaryMarkdown({
  target,
  baseline,
  games,
  standings: curr.standings,
  prevRank,
  production,
  teamOf,
  sourceNote: source,
});

mkdirSync("summaries", { recursive: true });
const path = `summaries/${target}.md`;
writeFileSync(path, md);
console.log(`Wrote ${path}`);
const played = production.filter((p) => p.played_this_week);
console.log(`  ${games.length} game(s), ${curr.standings.length} teams, ` +
  `${played.length} players with stats${baseline ? " (baseline week)" : ""}`);
