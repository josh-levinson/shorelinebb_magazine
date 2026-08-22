// Summarizer: reads the two most recent snapshots and writes a weekly
// markdown summary — game recaps, standings (with movement), and
// movers-and-shakers.
//
// Player stats come from Hoopsalytics per-game box scores, never TeamLinkt.
//
// Usage:  node src/summarize.js            # latest two snapshots
//         node src/summarize.js 2026-06-29 # treat this stamp as "latest"
import { mkdirSync, writeFileSync } from "node:fs";
import {
  listSnapshots, loadSnapshot, requireWeeklyProduction, boxscoreSourceNote,
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

// Hoopsalytics' real per-game box scores are the only stat source; this throws
// rather than falling back to TeamLinkt if they aren't scored yet.
let production;
try {
  production = requireWeeklyProduction(target, games);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const source = boxscoreSourceNote(games);

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
