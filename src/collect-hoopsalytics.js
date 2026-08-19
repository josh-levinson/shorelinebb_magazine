// Hoopsalytics collector: logs into hoopsalytics.com (email-only login — see
// src/probe-hoopsalytics.js) and pulls the advanced per-player stat views for
// the league's stats/show-league.php page, merging them into one row per
// player. Unlike collect.js's TeamLinkt scrape, this site is plain
// server-rendered HTML per view (?season_id=19&view=<View>) with no
// pagination and no separate JSON endpoint — see
// data/probe/hoopsalytics/views-summary.json for the discovery notes.
//
// Usage: node src/collect-hoopsalytics.js [YYYY-MM-DD]
//   The optional date stamps the snapshot dir (defaults to today, local time),
//   matching src/collect.js's convention so both collectors write into the
//   same data/snapshots/<stamp>/ directory.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

process.loadEnvFile?.();
const EMAIL = process.env.HOOPSALYTICS_EMAIL;
if (!EMAIL) {
  console.error("Set HOOPSALYTICS_EMAIL in .env first (see .env.example).");
  process.exit(1);
}

const SEASON_ID = 19;
const VIEWS = ["Offense", "Defense", "Key Stats", "Scouting", "Shooting", "Deluxe Stats", "Shooting (from Sets)"];
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const stamp = process.argv[2] || new Date().toISOString().slice(0, 10);
const SNAP = `data/snapshots/${stamp}`;
mkdirSync(SNAP, { recursive: true });

const log = (...a) => console.log(...a);

// "#0 Devin·Ye (Green Wave)" -> { jersey: 0, name: "Devin Ye", team: "Green Wave" }
// The site renders player names with U+00A0 (non-breaking space) between
// first/last name (to stop them wrapping mid-name), so normalize that to a
// plain space or every downstream name-keyed lookup (loadSnapshot, the draft
// board, weeklyProduction's Map) silently fails to match.
const normalizeSpace = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
function parsePlayerCell(cell) {
  const clean = normalizeSpace(cell);
  // A roster slot with a jersey number but no player assigned renders as
  // e.g. "#12 (Green Wave)" — no name between the number and the team. Treat
  // that as unnamed (caller skips falsy names) rather than a parse fallback.
  if (/^#\d+\s*\([^)]+\)$/.test(clean)) return { jersey: null, name: "", team: null };
  const m = clean.match(/^#(\d+)\s+(.+?)\s+\(([^)]+)\)$/);
  if (!m) return { jersey: null, name: clean, team: null };
  return { jersey: Number(m[1]), name: m[2].trim(), team: m[3].trim() };
}

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: UA });
const page = await context.newPage();

// ---- log in -----------------------------------------------------------------
log("Logging in …");
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
log(`  logged in, at ${page.url()}`);

// ---- pull each view -----------------------------------------------------------
const extractTable = () =>
  page.evaluate(() => {
    const t = document.querySelector("#league-table");
    if (!t) return null;
    const headerRow = t.querySelector("thead tr") || t.querySelector("tr");
    const headers = headerRow
      ? [...headerRow.querySelectorAll("th, td")].map((c) => c.innerText.trim())
      : [];
    const rows = [...t.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td, th")].map((c) => c.innerText.trim()),
    );
    return { headers, rows };
  });

const byName = new Map();
for (const view of VIEWS) {
  const url = `https://hoopsalytics.com/stats/show-league.php?season_id=${SEASON_ID}&view=${encodeURIComponent(view)}`;
  log(`Loading view "${view}" …`);
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForTimeout(2000);
  } catch (e) {
    log(`  warn: ${e.message}`);
    continue;
  }
  const table = await extractTable();
  if (!table) {
    log(`  warn: #league-table not found for view "${view}"`);
    continue;
  }
  const { headers, rows } = table;
  for (const cells of rows) {
    const { jersey, name, team } = parsePlayerCell(cells[1]);
    if (!name) continue;
    const player = byName.get(name) ?? { name, jersey, team };
    // Columns beyond index 1 (index 0 is a blank marker column, index 1 is
    // the parsed player cell). Duplicate column names across views (Games,
    // Time, Pts., ...) carry the same underlying value, so a later view's
    // value simply overwrites an earlier one's — harmless.
    for (let i = 2; i < headers.length; i++) {
      const key = headers[i];
      if (!key) continue;
      player[key] = cells[i] ?? null;
    }
    byName.set(name, player);
  }
  log(`  ${rows.length} rows, ${headers.length} columns`);
}

await browser.close();

const players = [...byName.values()];
writeFileSync(`${SNAP}/hoopsalytics_stats.json`, JSON.stringify(players, null, 2));
log(`\nHoopsalytics stats: ${players.length} players across ${VIEWS.length} view(s) written to ${SNAP}/hoopsalytics_stats.json`);
