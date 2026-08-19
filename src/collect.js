// Collector: loads the Shoreline league pages in a headless browser, captures
// the JSON the site fetches, and writes a timestamped weekly snapshot.
//
// Why a browser (not plain fetch): the data endpoints require the site's
// session/CSRF context — direct curl returns empty. Navigating real pages lets
// the browser establish that context, and we sniff the JSON responses.
//
// Usage:  node src/collect.js [YYYY-MM-DD]
//   The optional date stamps the snapshot dir (defaults to today, local time).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const ASSOCIATION = "10372";
const BASE = "https://leagues.teamlinkt.com/shorelinebball";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const stamp = process.argv[2] || new Date().toISOString().slice(0, 10);
const SNAP = `data/snapshots/${stamp}`;
const RAW = `${SNAP}/raw`;
const BOX = `${SNAP}/boxscores`;
[RAW, BOX].forEach((d) => mkdirSync(d, { recursive: true }));

const log = (...a) => console.log(...a);

// ---- helpers ---------------------------------------------------------------
const stripTags = (s) => String(s ?? "").replace(/<[^>]+>/g, "").trim();
// Team cell looks like: <a ...><span ...>Huskies</span></a> with optional "(57)"
function parseTeamCell(html) {
  const idMatch = String(html).match(/team\/\d+\/(\d+)/);
  const text = stripTags(html);
  const scoreMatch = text.match(/\((\d+)\)\s*$/);
  return {
    team_id: idMatch ? Number(idMatch[1]) : null,
    name: text.replace(/\s*\(\d+\)\s*$/, "").trim(),
    score: scoreMatch ? Number(scoreMatch[1]) : null,
  };
}
function eventIdFrom(titleHtml) {
  const m = String(titleHtml).match(/event\/\d+\/(\d+)/);
  return m ? m[1] : null;
}

// ---- collect ---------------------------------------------------------------
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();

const grab = {}; // logical name -> parsed JSON
function watch(page) {
  page.on("response", async (res) => {
    const url = res.url();
    let key = null;
    if (url.includes("/leagues/getStandings/")) key = "standings";
    else if (url.includes("/leagues/getAllEvents/")) key = "events";
    else if (url.includes("/leagues/getLeadPlayerStatisticCardsJSON/")) key = "leaders";
    else if (url.includes("/leagues/getPlayerStatsForEvent/")) key = "boxscore"; // handled per-event below
    if (!key || key === "boxscore") return;
    try {
      const body = await res.text();
      grab[key] = JSON.parse(body);
      grab[`${key}__url`] = url;
      writeFileSync(`${RAW}/${key}.json`, body);
    } catch { /* non-JSON or parse error: ignore */ }
  });
}
watch(page);

for (const path of ["/Scores", "/Standings", "/Statistics"]) {
  log(`Loading ${path} …`);
  try {
    await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(3000);
  } catch (e) {
    log(`  warn: ${e.message}`);
  }
}

// ---- full per-player stats table (the movers-and-shakers source) -----------
// Lives on the Statistics page behind the "Players" tab; renders into
// #stats_table once activated. Cumulative for the season → diff snapshots
// week-over-week to get per-week production.
// The table is paginated via a custom Next button (#stats_next_btn calling
// nextStatisticsTablePage); we click through every page and accumulate rows,
// deduping by name.
const extractPage = () =>
  page.evaluate(() => {
    const t = document.querySelector("#stats_table");
    if (!t) return [];
    const heads = [...t.querySelectorAll("thead th")].map((th) => th.innerText.trim());
    return [...t.querySelectorAll("tbody tr")]
      .map((tr) => {
        const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
        if (cells.length < heads.length - 1) return null;
        const row = {};
        heads.forEach((h, i) => (row[h || `col${i}`] = cells[i] ?? null));
        const img = tr.querySelector('img[src*="team_data"]'); // robust team link
        const m = img && img.getAttribute("src").match(/team_data\/(\d+)/);
        row.team_id = m ? Number(m[1]) : null;
        return row;
      })
      .filter(Boolean);
  });

const byName = new Map();
let pagesRead = 0;
try {
  await page.click("#player_stats_tab", { timeout: 8000 });
  await page.waitForTimeout(3000);
  for (let pageNum = 1; pageNum <= 20; pageNum++) {
    for (const r of await extractPage()) if (r.Name) byName.set(r.Name, r);
    pagesRead = pageNum;
    const nextDisabled = await page
      .$eval("#stats_next_btn", (el) => el.classList.contains("disabled"))
      .catch(() => true);
    if (nextDisabled) break;
    const firstBefore = await page
      .$eval("#stats_table tbody tr td", (td) => td.innerText)
      .catch(() => "");
    await page.click("#stats_next_btn");
    // wait for the table to actually turn over (first cell changes, loader gone)
    await page
      .waitForFunction(
        (prev) => {
          const td = document.querySelector("#stats_table tbody tr td");
          const proc = document.querySelector("#stats_table_processing");
          const loading = proc && getComputedStyle(proc).display !== "none";
          return td && td.innerText !== prev && !loading;
        },
        firstBefore,
        { timeout: 10000 },
      )
      .catch(() => {});
    await page.waitForTimeout(800);
  }
} catch (e) {
  log(`  player-stats warn: ${e.message}`);
}
const playerStats = [...byName.values()];
writeFileSync(`${SNAP}/player_stats.json`, JSON.stringify(playerStats, null, 2));
log(`Player stats: ${playerStats.length} players across ${pagesRead} page(s)`);

// ---- parse standings -------------------------------------------------------
let standings = [];
if (grab.standings?.standings) {
  standings = grab.standings.standings.map((r) => ({
    rank: r.ranking,
    team: r.Team?.name ?? stripTags(r.team_name),
    team_id: r.team_id,
    gp: r.games_played,
    w: r.total_wins,
    l: r.total_losses,
    pct: r.win_percent,
    pf: r.score_for,
    pa: r.score_against,
    diff: r.score_differential,
    streak: `${r.streak_type}${r.streak_length}`,
    last_ten: r.last_ten,
  }));
}
writeFileSync(`${SNAP}/standings.json`, JSON.stringify(standings, null, 2));
log(`Standings: ${standings.length} teams`);

// ---- parse games -----------------------------------------------------------
let games = [];
if (grab.events?.data) {
  games = grab.events.data.map((g) => {
    const home = parseTeamCell(g["3"]);
    const away = parseTeamCell(g["4"]);
    return {
      event_id: eventIdFrom(g["2"]),
      date: g["0"],
      time: g["1"],
      ts: g["6"],
      location: stripTags(g["5"]),
      home,
      away,
      final: home.score != null && away.score != null,
    };
  });
}
writeFileSync(`${SNAP}/games.json`, JSON.stringify(games, null, 2));
const finals = games.filter((g) => g.final);
log(`Games: ${games.length} total, ${finals.length} with final scores`);

// ---- leaders ---------------------------------------------------------------
let leaders = [];
if (grab.leaders?.payload) {
  leaders = grab.leaders.payload.map((grp) => ({
    statistic_id: grp[0]?.PlayerStatistic?.statistic_id ?? null,
    players: grp.map((p) => ({
      name: p.Player?.name,
      team: p.Player?.Team?.name,
      value: p.PlayerStatistic?.value,
    })),
  }));
}
writeFileSync(`${SNAP}/leaders.json`, JSON.stringify(leaders, null, 2));
log(`Leaders: ${leaders.length} stat groups`);

// ---- box scores per finalized game ----------------------------------------
let boxCount = 0;
for (const g of finals) {
  if (!g.event_id) continue;
  let captured = null;
  const handler = async (res) => {
    if (res.url().includes("/leagues/getPlayerStatsForEvent/")) {
      try { captured = await res.text(); } catch {}
    }
  };
  page.on("response", handler);
  try {
    await page.goto(`https://leagues.teamlinkt.com/Leagues/event/${ASSOCIATION}/${g.event_id}`, {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    await page.waitForTimeout(2500);
  } catch (e) {
    log(`  box ${g.event_id} warn: ${e.message}`);
  }
  page.off("response", handler);
  if (captured) {
    writeFileSync(`${BOX}/${g.event_id}.json`, captured);
    try {
      const j = JSON.parse(captured);
      // payload.stats is keyed by team_id (an object), not an array — .length
      // is always undefined on it, so count players with a statistic block instead.
      const n = Object.values(j?.payload?.stats ?? {})
        .reduce((sum, team) => sum + Object.keys(team.statistic ?? {}).length, 0);
      if (n > 0) boxCount++;
      log(`  box ${g.event_id}: ${n} stat lines${n === 0 ? " (not analyzed yet)" : ""}`);
    } catch {}
  }
}
log(`Box scores with data: ${boxCount}/${finals.length}`);

await browser.close();

// ---- snapshot manifest -----------------------------------------------------
writeFileSync(
  `${SNAP}/manifest.json`,
  JSON.stringify(
    {
      stamp,
      association: ASSOCIATION,
      season_url: grab.standings__url ?? grab.leaders__url ?? null,
      teams: standings.length,
      players: playerStats.length,
      games: games.length,
      finals: finals.length,
      boxscores_with_data: boxCount,
    },
    null,
    2,
  ),
);
log(`\nSnapshot written to ${SNAP}/`);
