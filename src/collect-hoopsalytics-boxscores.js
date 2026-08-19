// Per-game box scores directly from hoopsalytics.com — the actual stats
// provider — rather than TeamLinkt's getPlayerStatsForEvent endpoint (which
// republishes them but visibly lags: as of this writing, TeamLinkt still
// shows empty box scores for games hoopsalytics has already fully scored
// "Done", days or weeks after the fact).
//
// hoopsalytics.com/league/games.php?season_id=19&team_id=<id> lists a team's
// games with a game_id and a "Done"/"self-scored"/pending status.
// hoopsalytics.com/stats/show.php?stats=player+stats&game_ids[]=<id>&team_id=<id>
// returns BOTH teams' full per-player box score for that one game_id (the
// team_id in the query just picks which side renders first) — so one fetch
// per game_id, not per team.
//
// This writes two things into data/snapshots/<stamp>/:
//   hoopsalytics_game_map.json    event_id (TeamLinkt) -> {game_id, status} for every
//                                  game we could match by date + matchup
//   hoopsalytics_boxscores/<event_id>.json   per-player lines for "Done" games,
//                                  in the same shape backfill-recaps.js's
//                                  parseBoxscore() produces from a TeamLinkt
//                                  box score, so it's a drop-in fallback source.
//
// Usage: node src/collect-hoopsalytics-boxscores.js [YYYY-MM-DD]
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { COUNT_STATS } from "./lib.js";

process.loadEnvFile?.();
const EMAIL = process.env.HOOPSALYTICS_EMAIL;
if (!EMAIL) {
  console.error("Set HOOPSALYTICS_EMAIL in .env first (see .env.example).");
  process.exit(1);
}

const SEASON_ID = 19;
// hoopsalytics team_id -> team name (from the standings page's team links —
// see data/probe/hoopsalytics/01-after-submit.html).
const HOOP_TEAM_IDS = {
  34733: "Red Storm", 34734: "Knicks", 34735: "Black Mamba",
  34736: "Bulldogs", 34737: "Green Wave", 34738: "Huskies",
};

const stamp = process.argv[2] || new Date().toISOString().slice(0, 10);
const SNAP = `data/snapshots/${stamp}`;
const HBOX = `${SNAP}/hoopsalytics_boxscores`;
mkdirSync(HBOX, { recursive: true });

const games = JSON.parse(readFileSync(`${SNAP}/games.json`, "utf8")).filter((g) => g.final);
const teamlinktIdByName = new Map();
for (const g of games) {
  teamlinktIdByName.set(g.home.name, g.home.team_id);
  teamlinktIdByName.set(g.away.name, g.away.team_id);
}

const log = (...a) => console.log(...a);

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

log("Logging in to hoopsalytics.com …");
await page.goto("https://hoopsalytics.com/program/login.php", { waitUntil: "networkidle", timeout: 45000 });
await page.fill('input[name="login"]', EMAIL, { timeout: 8000 });
await Promise.all([
  page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {}),
  page.click("#submit-button", { timeout: 8000 }),
]);
await page.waitForTimeout(1500);
if (!/hoopsalytics\.com/.test(page.url())) {
  console.error(`Login didn't land on hoopsalytics.com (got ${page.url()}) — bailing.`);
  await browser.close();
  process.exit(1);
}

// ---- 1. pull every team's schedule, build game_id -> {date, teams, status} --
const scheduleExtract = () =>
  page.evaluate(() => {
    // Row text looks like: "39249\t(L) vs. Green Wave (37 - 48)\nAug 12, 2026 @ …"
    const rows = [...document.querySelectorAll("tr")];
    const out = [];
    for (const tr of rows) {
      const text = tr.innerText;
      const idMatch = text.match(/^\s*(\d{4,6})\s/);
      const dateMatch = text.match(/(\w{3}\s+\d{1,2},\s+\d{4})/); // e.g. "Aug 12, 2026"
      if (!idMatch || !dateMatch) continue;
      out.push({
        game_id: Number(idMatch[1]),
        date: dateMatch[1],
        done: /\bDone\b/.test(text),
        selfScored: /self-scored/.test(text),
      });
    }
    return out;
  });

const byGameId = new Map(); // game_id -> { date (ISO), done, teams: Set<name> }
for (const [hoopId, name] of Object.entries(HOOP_TEAM_IDS)) {
  log(`Loading schedule for ${name} …`);
  await page.goto(`https://hoopsalytics.com/league/games.php?season_id=${SEASON_ID}&team_id=${hoopId}`, {
    waitUntil: "networkidle", timeout: 45000,
  });
  await page.waitForTimeout(1000);
  for (const row of await scheduleExtract()) {
    const iso = isoFromLongDate(row.date);
    if (!iso) continue;
    const entry = byGameId.get(row.game_id) ?? { date: iso, done: row.done, teams: new Set() };
    entry.teams.add(name);
    entry.done = entry.done || row.done;
    byGameId.set(row.game_id, entry);
  }
}
log(`Found ${byGameId.size} distinct hoopsalytics game(s) across all team schedules.`);

// ---- 2. match hoopsalytics games to our TeamLinkt event_ids by date + matchup
const hoopIdByName = new Map(Object.entries(HOOP_TEAM_IDS).map(([id, name]) => [name, Number(id)]));
const gameMap = {}; // event_id -> { game_id, status, team_id (a hoopsalytics participant, for the fetch URL) }
for (const g of games) {
  const wanted = new Set([g.home.name, g.away.name]);
  const match = findMatch(g, byGameId, wanted);
  if (match) {
    gameMap[g.event_id] = {
      game_id: match.id,
      status: match.entry.done ? "done" : "pending",
      team_id: hoopIdByName.get(g.home.name),
    };
  }
}
function isoFromLongDate(s) {
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const m = s.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const [, mon, day, year] = m;
  return `${year}-${String(MONTHS[mon] + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function findMatch(g, byGameId, wantedTeams) {
  const iso = isoFromLongDate(g.date);
  for (const [id, entry] of byGameId) {
    if (entry.date !== iso) continue;
    if ([...wantedTeams].every((t) => entry.teams.has(t))) return { id, entry };
  }
  return null;
}
writeFileSync(`${SNAP}/hoopsalytics_game_map.json`, JSON.stringify(gameMap, null, 2));
log(`Matched ${Object.keys(gameMap).length}/${games.length} TeamLinkt games to hoopsalytics game_ids.`);

// ---- 3. fetch + parse box scores for "done" games we don't already have ------
// Column layout of stats/show.php's player table (verified against a known
// score): 0-2 blank(ON/OFF/marker), 3 Player ("01#1 Name"), 4 Time, 5 2Pt/A,
// 6 3Pt/A, 7 FT/A, 8 Fouls, 9 OReb, 10 DReb, 11 Ast, 12 Stl, 13 Blk, 14 TO,
// 15 Shots, 16 Pts, 17-19 shooting %.
const tableExtract = () =>
  page.evaluate(() => {
    const tables = [...document.querySelectorAll("table.table1, table.table2")].slice(0, 2);
    return tables.map((t) =>
      [...t.querySelectorAll("tbody tr, tr")]
        .map((tr) => [...tr.querySelectorAll("td, th")].map((c) => c.innerText.trim()))
        .filter((cells) => cells.length >= 17),
    );
  });

function parseMade(s) {
  const [made] = String(s ?? "0/0").split("/");
  return Number(made) || 0;
}
function parseAttempt(s) {
  const parts = String(s ?? "0/0").split("/");
  return Number(parts[1]) || 0;
}

const gameByEventId = new Map(games.map((g) => [g.event_id, g]));

let written = 0;
for (const [event_id, { game_id, status, team_id }] of Object.entries(gameMap)) {
  if (status !== "done") continue;
  const out = `${HBOX}/${event_id}.json`;
  if (existsSync(out)) continue; // don't re-fetch what we already have

  log(`Fetching box score for event ${event_id} (hoopsalytics game ${game_id}) …`);
  await page.goto(
    `https://hoopsalytics.com/stats/show.php?stats=player+stats&game_ids[]=${game_id}&team_id=${team_id}`,
    { waitUntil: "networkidle", timeout: 45000 },
  );
  await page.waitForTimeout(1500);
  const tables = await tableExtract();
  // table[0] = the team passed as `team_id` (the home side, by construction
  // above); table[1] = its opponent — see the header comment on tableExtract.
  const g = gameByEventId.get(event_id) || gameByEventId.get(Number(event_id));
  const teamIdByTableIndex = [g?.home?.team_id, g?.away?.team_id];

  const rows = [];
  tables.forEach((table, tableIdx) => {
    for (const cells of table.slice(1)) { // skip header row
      const playerCell = cells[3] ?? "";
      // Seen in both "01#1 Name" (zero-padded sort key + jersey) and "#1 Name *"
      // (no sort key, trailing "*" for starters) forms — normalize either way.
      // Rows without a "#jersey" prefix (the "ALL"/"ZALL" totals row) are skipped.
      const m = playerCell.match(/^(?:\d+)?#\d+\s+(.+?)\s*\*?\s*$/);
      if (!m) continue;
      const name = m[1].trim();
      const weekly = {};
      for (const s of COUNT_STATS) weekly[s] = 0;
      weekly["2PM"] = parseMade(cells[5]); weekly["2PA"] = parseAttempt(cells[5]);
      weekly["3PM"] = parseMade(cells[6]); weekly["3PA"] = parseAttempt(cells[6]);
      weekly.FTM = parseMade(cells[7]); weekly.FTA = parseAttempt(cells[7]);
      weekly.PF = Number(cells[8]) || 0;
      weekly.OR = Number(cells[9]) || 0;
      weekly.DR = Number(cells[10]) || 0;
      weekly.TOTRB = weekly.OR + weekly.DR;
      weekly.AST = Number(cells[11]) || 0;
      weekly.STL = Number(cells[12]) || 0;
      weekly.BLK = Number(cells[13]) || 0;
      weekly.TO = Number(cells[14]) || 0;
      weekly.TP = Number(cells[16]) || 0;
      const played_this_week = Object.values(weekly).some((v) => v > 0);
      weekly.GP = played_this_week ? 1 : 0;
      rows.push({ name, team_id: teamIdByTableIndex[tableIdx] ?? null, weekly, played_this_week });
    }
  });
  if (rows.length === 0) {
    log(`  warn: parsed 0 players for event ${event_id} — page structure may differ.`);
    continue;
  }
  writeFileSync(out, JSON.stringify(rows, null, 2));
  log(`  wrote ${out} (${rows.length} players)`);
  written++;
}

await browser.close();
log(`\nWrote ${written} new hoopsalytics box score file(s) to ${HBOX}/`);
