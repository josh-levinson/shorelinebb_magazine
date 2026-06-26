// Summarizer: reads the two most recent snapshots and writes a weekly
// markdown summary — game recaps, standings (with movement), and
// movers-and-shakers (weekly production diff).
//
// Usage:  node src/summarize.js            # latest two snapshots
//         node src/summarize.js 2026-06-29 # treat this stamp as "latest"
import { mkdirSync, writeFileSync } from "node:fs";
import {
  listSnapshots, loadSnapshot, weeklyProduction, newlyFinalGames,
  teamNameById, STAT_LABELS,
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
const production = weeklyProduction(curr, prev);
const byTeam = (id) => production.filter((p) => p.team_id === id && p.played_this_week);

const fmtDate = (s) =>
  new Date(s + "T12:00:00").toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

const out = [];
const w = (s = "") => out.push(s);

// ---- header ----------------------------------------------------------------
w(`# Shoreline Basketball — Week of ${fmtDate(target)}`);
w();
if (baseline) {
  w(`> First snapshot — establishing the baseline. Week-over-week movement and `
    + `weekly stat lines begin with next week's summary.`);
  w();
}

// ---- 1. game recaps --------------------------------------------------------
const games = newlyFinalGames(curr, prev);
w(`## 🏀 Games`);
w();
if (games.length === 0) {
  w(`_No new final scores since the last snapshot._`);
  w();
} else {
  for (const g of [...games].sort((a, b) => a.ts - b.ts)) {
    const h = g.home, a = g.away;
    const homeWon = h.score > a.score;
    const winner = homeWon ? h : a;
    const loser = homeWon ? a : h;
    w(`### ${winner.name} ${winner.score}, ${loser.name} ${loser.score}`);
    w(`*${g.date}*`);
    w();
    // leading scorers, attributed by team (one game per team per week)
    for (const side of [h, a]) {
      const roster = byTeam(side.team_id)
        .filter((p) => p.weekly.TP > 0)
        .sort((x, y) => y.weekly.TP - x.weekly.TP);
      if (roster.length === 0) {
        w(`- **${side.name}** — _no player stats reported_`);
        continue;
      }
      const top = roster[0];
      const line = statLine(top);
      const others = roster.slice(1, 3)
        .map((p) => `${p.name} ${p.weekly.TP}`).join(", ");
      w(`- **${side.name}** — ${top.name} led with ${line}`
        + (others ? ` · also: ${others}` : ""));
    }
    w();
  }
}

// ---- 2. standings ----------------------------------------------------------
const prevRank = new Map((prev?.standings ?? []).map((t) => [t.team_id, t.rank]));
w(`## 📊 Standings`);
w();
w(`| | Team | W | L | PF | PA | Diff | Streak |`);
w(`|---|------|---|---|----|----|------|--------|`);
for (const t of curr.standings) {
  let move = "";
  if (prev && prevRank.has(t.team_id)) {
    const d = prevRank.get(t.team_id) - t.rank;
    move = d > 0 ? ` ▲${d}` : d < 0 ? ` ▼${-d}` : "";
  }
  const diff = t.diff > 0 ? `+${t.diff}` : `${t.diff}`;
  w(`| ${t.rank}${move} | ${t.team} | ${t.w} | ${t.l} | ${t.pf} | ${t.pa} | ${diff} | ${t.streak} |`);
}
w();

// ---- 3. movers & shakers ---------------------------------------------------
w(`## 🔥 Movers & Shakers`);
w();
const played = production.filter((p) => p.played_this_week);
if (played.length === 0) {
  w(`_No player stats reported this week yet (stats post over the weekend)._`);
  w();
} else {
  const label = baseline ? "this season so far" : "this week";

  // top scorers
  const scorers = [...played].sort((a, b) => b.weekly.TP - a.weekly.TP).slice(0, 5);
  w(`**Top scorers (${label})**`);
  w();
  scorers.forEach((p, i) =>
    w(`${i + 1}. **${p.name}** (${teamOf(p.team_id)}) — ${statLine(p)}`));
  w();

  // category leaders
  const cats = [["TOTRB", "rebounds"], ["AST", "assists"], ["STL", "steals"], ["BLK", "blocks"], ["3PM", "threes made"]];
  const lines = [];
  for (const [stat, word] of cats) {
    const best = [...played].sort((a, b) => b.weekly[stat] - a.weekly[stat])[0];
    if (best && best.weekly[stat] > 0)
      lines.push(`- **${word}:** ${best.name} (${teamOf(best.team_id)}) — ${best.weekly[stat]}`);
  }
  if (lines.length) {
    w(`**Category leaders (${label})**`);
    w();
    lines.forEach(w);
    w();
  }

  // notable lines: double-doubles & big games
  const notable = [];
  for (const p of played) {
    const dd = [["TP", p.weekly.TP], ["TOTRB", p.weekly.TOTRB], ["AST", p.weekly.AST]]
      .filter(([, v]) => v >= 10).length;
    if (dd >= 2) notable.push(`- **${p.name}** (${teamOf(p.team_id)}) posted a double-double: ${statLine(p)}`);
    else if (p.weekly.TP >= 18) notable.push(`- **${p.name}** (${teamOf(p.team_id)}) dropped ${p.weekly.TP}: ${statLine(p)}`);
  }
  if (notable.length) {
    w(`**Notable performances**`);
    w();
    [...new Set(notable)].forEach(w);
    w();
  }
}

// ---- footer ----------------------------------------------------------------
const missing = curr.standings
  .map((t) => t.team)
  .filter((name) => !production.some((p) => teamOf(p.team_id) === name && p.played_this_week));
if (missing.length) {
  w(`---`);
  w(`_Note: no player stats reported for ${missing.join(", ")} ` +
    `(stats are entered by the league's analytics provider over the weekend)._`);
  w();
}
w(`<sub>Generated from ${target}` + (prev ? ` vs ${prev.stamp}` : ` (baseline)`) + `.</sub>`);

// ---- helpers ---------------------------------------------------------------
function statLine(p) {
  const parts = [`${p.weekly.TP} pts`];
  for (const [stat, lbl] of [["TOTRB", "reb"], ["AST", "ast"], ["STL", "stl"], ["BLK", "blk"]]) {
    if (p.weekly[stat] > 0) parts.push(`${p.weekly[stat]} ${lbl}`);
  }
  return parts.join(", ");
}

// ---- write -----------------------------------------------------------------
mkdirSync("summaries", { recursive: true });
const path = `summaries/${target}.md`;
writeFileSync(path, out.join("\n") + "\n");
console.log(`Wrote ${path}`);
console.log(`  ${games.length} game(s), ${curr.standings.length} teams, ` +
  `${played.length} players with stats${baseline ? " (baseline week)" : ""}`);
