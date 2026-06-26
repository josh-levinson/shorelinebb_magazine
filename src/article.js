// AI-written weekly article: takes the structured snapshot data and has Claude
// write an ESPN-style recap. The deterministic numbers come from the snapshots;
// Claude supplies the narrative voice — it is told to use ONLY the provided
// facts (these are real people, so no invented quotes or stats).
//
// Requires ANTHROPIC_API_KEY (or an `ant auth login` profile).
//
// Usage:  node src/article.js            # latest two snapshots
//         node src/article.js 2026-06-29 # treat this stamp as "latest"
import { mkdirSync, writeFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

// Load .env (for ANTHROPIC_API_KEY) if present. No-op when the file is absent
// or a real env var is already set.
try {
  process.loadEnvFile();
} catch { /* no .env file — rely on the ambient environment */ }
import {
  listSnapshots, loadSnapshot, weeklyProduction, newlyFinalGames, teamNameById,
} from "./lib.js";

// ---- assemble the structured payload --------------------------------------
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
const played = production.filter((p) => p.played_this_week);

const line = (p) => {
  const parts = [`${p.weekly.TP} pts`];
  for (const [s, l] of [["TOTRB", "reb"], ["AST", "ast"], ["STL", "stl"], ["BLK", "blk"], ["3PM", "3PM"]]) {
    if (p.weekly[s] > 0) parts.push(`${p.weekly[s]} ${l}`);
  }
  return parts.join(", ");
};

const games = newlyFinalGames(curr, prev)
  .sort((a, b) => a.ts - b.ts)
  .map((g) => {
    const performers = (side) =>
      production
        .filter((p) => p.team_id === side.team_id && p.weekly.TP > 0)
        .sort((a, b) => b.weekly.TP - a.weekly.TP)
        .slice(0, 4)
        .map((p) => ({ name: p.name, statline: line(p) }));
    const homeWon = g.home.score > g.away.score;
    return {
      date: g.date,
      home: { team: g.home.name, score: g.home.score, top: performers(g.home) },
      away: { team: g.away.name, score: g.away.score, top: performers(g.away) },
      winner: (homeWon ? g.home : g.away).name,
      margin: Math.abs(g.home.score - g.away.score),
    };
  });

const standings = curr.standings.map((t) => {
  const before = prev?.standings.find((x) => x.team_id === t.team_id)?.rank;
  return {
    rank: t.rank, team: t.team, w: t.w, l: t.l,
    points_for: t.pf, points_against: t.pa, diff: t.diff, streak: t.streak,
    rank_change: before != null ? before - t.rank : null,
  };
});

const topScorers = [...played].sort((a, b) => b.weekly.TP - a.weekly.TP).slice(0, 6)
  .map((p) => ({ name: p.name, team: teamOf(p.team_id), statline: line(p) }));
const catLeader = (stat) => {
  const best = [...played].sort((a, b) => b.weekly[stat] - a.weekly[stat])[0];
  return best && best.weekly[stat] > 0
    ? { name: best.name, team: teamOf(best.team_id), value: best.weekly[stat] } : null;
};
const doubleDoubles = played
  .filter((p) => [p.weekly.TP, p.weekly.TOTRB, p.weekly.AST].filter((v) => v >= 10).length >= 2)
  .map((p) => ({ name: p.name, team: teamOf(p.team_id), statline: line(p) }));

const data = {
  league: "Shoreline adult men's basketball league",
  venue: "East Shoreline Catholic Academy",
  week_of: target,
  is_first_week: baseline,
  note: baseline
    ? "This is the first week of the season; all stats are season-to-date with no prior week to compare against."
    : "Player stats below are this week's production only (computed by diffing cumulative season totals against last week).",
  games,
  standings,
  stat_leaders: {
    top_scorers: topScorers,
    rebounds: catLeader("TOTRB"),
    assists: catLeader("AST"),
    steals: catLeader("STL"),
    blocks: catLeader("BLK"),
    double_doubles: doubleDoubles,
  },
};

// ---- prompt ----------------------------------------------------------------
const system = `You are a talented sports writer producing a weekly recap for a beer-league
(adult men's recreational) basketball league, in the style of an ESPN or The Athletic column —
lively, knowledgeable, a little playful, but credible. You write clean Markdown.

Hard rules:
- Use ONLY the facts in the provided JSON. These are real, named people — do NOT invent quotes,
  injuries, backstories, hometowns, nicknames, or any stat not present in the data.
- Every number you cite must come from the data. Never round or embellish a score or stat line.
- It's a rec league: keep the tone fun and affectionate, never mocking. Celebrate the players.
- If it's the first week, frame it as the season tip-off and avoid week-over-week "movement" language.`;

const userPrompt = `Write this week's recap article for the league. Structure it as:

1. A punchy headline (H1) and a one-or-two sentence dek/lede that captures the week.
2. **Around the League** — a short narrative recap of each game (final score, who won, the standout
   performances). Weave the box-score lines in naturally; don't just list them.
3. **The Standings** — a brief narrative on the table${baseline ? "" : ", noting any risers/fallers vs last week"}, followed by the standings as a Markdown table.
4. **Movers & Shakers** — highlight the week's statistical standouts: top scorers, category leaders,
   and any double-doubles. Make it feel like a "stars of the week" segment.

Keep it tight and readable — roughly 500–800 words. Here is the data:

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\``;

// ---- generate --------------------------------------------------------------
const client = new Anthropic();
console.error(`Generating article for week of ${target}${baseline ? " (season opener)" : ""} …\n`);

let article = "";
try {
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system,
    messages: [{ role: "user", content: userPrompt }],
  });
  stream.on("text", (t) => process.stderr.write(t));
  const final = await stream.finalMessage();
  article = final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
} catch (e) {
  const noAuth =
    e instanceof Anthropic.AuthenticationError ||
    /authentication method|api[_-]?key/i.test(e.message || "");
  if (noAuth) {
    console.error(
      "\n\nNo API key found. This step calls the Claude API, which needs a key.\n" +
        "  Easiest: cp .env.example .env  and paste your key into .env\n" +
        "  Or:      export ANTHROPIC_API_KEY=sk-ant-...\n" +
        "Get one at https://console.anthropic.com/ → API Keys. " +
        "(The other steps — collect/summary — don't need it.)",
    );
  } else {
    console.error(`\n\nArticle generation failed: ${e.message}`);
  }
  process.exit(1);
}

mkdirSync("summaries", { recursive: true });
const path = `summaries/${target}-article.md`;
writeFileSync(path, article.trim() + "\n");
console.error(`\n\nWrote ${path}`);
