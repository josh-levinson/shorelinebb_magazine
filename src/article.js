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
  listSnapshots, loadSnapshot, requireWeeklyProduction, newlyFinalGames, teamNameById,
  buildArticleData, generateArticle,
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

// Stat lines come from Hoopsalytics per-game box scores only — never a
// TeamLinkt cumulative diff, which would put invented-looking numbers about
// real, named players into a published article.
let production;
try {
  production = requireWeeklyProduction(target, games);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const data = buildArticleData({
  league: "Shoreline adult men's basketball league",
  venue: "East Shoreline Catholic Academy",
  target,
  baseline,
  games,
  standings: curr.standings,
  prevRank,
  production,
  teamOf,
  note: "Player stats below are real per-game box score lines from Hoopsalytics, "
    + "the league's stats provider, summed over exactly this week's games."
    + (baseline ? " This is the first week of the season, so there is no prior week to compare against." : ""),
});

// ---- generate --------------------------------------------------------------
console.error(`Generating article for week of ${target}${baseline ? " (season opener)" : ""} …\n`);

let article = "";
try {
  article = await generateArticle(data, { baseline, onText: (t) => process.stderr.write(t) });
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
